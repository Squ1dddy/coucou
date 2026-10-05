// OAuth 2 sign-in: Authorization Code + PKCE (S256) with a loopback redirect.
//
// Generic over a `Provider`; the connectors (Spotify today) are only config. The
// flow: bind 127.0.0.1 on a random port, open the browser at the provider's
// authorize page, take exactly one callback, check `state`, trade the code for
// tokens and close the listener.
//
// Tokens live in the Credential Manager through `secrets.rs` and nowhere else.
// They are never logged, never written to disk and never sent to the front end:
// the island only ever learns `connected: bool`.

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::log;
use crate::platform;
use crate::secrets;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);
const READ_TIMEOUT: Duration = Duration::from_secs(5);
/// Refresh when less than this many seconds remain on the access token.
const REFRESH_MARGIN_SECS: u64 = 60;

/// Everything that differs between providers. Key names must be in `KNOWN_KEYS`.
pub struct Provider {
    pub id: &'static str,
    pub auth_url: &'static str,
    pub token_url: &'static str,
    /// Space-separated, as the providers want them.
    pub scopes: &'static str,
    pub client_id_key: &'static str,
    /// Only for providers that issue a secret to a desktop client (Google).
    pub client_secret_key: Option<&'static str>,
    /// Extra query parameters on the authorize URL (e.g. `access_type=offline`).
    pub extra_auth_params: &'static [(&'static str, &'static str)],
    pub access_key: &'static str,
    pub refresh_key: &'static str,
    pub expiry_key: &'static str,
}

pub const SPOTIFY: Provider = Provider {
    id: "spotify",
    auth_url: "https://accounts.spotify.com/authorize",
    token_url: "https://accounts.spotify.com/api/token",
    scopes: "user-read-currently-playing user-read-playback-state user-modify-playback-state",
    client_id_key: "spotify-client-id",
    client_secret_key: None,
    extra_auth_params: &[],
    access_key: "spotify-access-token",
    refresh_key: "spotify-refresh-token",
    expiry_key: "spotify-token-expiry",
};

/// Google desktop clients need their client secret in the token exchange, and
/// `access_type=offline` + `prompt=consent` make Google always issue a refresh token.
pub const GOOGLE: Provider = Provider {
    id: "google",
    auth_url: "https://accounts.google.com/o/oauth2/v2/auth",
    token_url: "https://oauth2.googleapis.com/token",
    scopes: "https://www.googleapis.com/auth/calendar.readonly",
    client_id_key: "gcal-client-id",
    client_secret_key: Some("gcal-client-secret"),
    extra_auth_params: &[("access_type", "offline"), ("prompt", "consent")],
    access_key: "gcal-access-token",
    refresh_key: "gcal-refresh-token",
    expiry_key: "gcal-token-expiry",
};

pub fn provider(id: &str) -> Option<&'static Provider> {
    match id {
        "spotify" => Some(&SPOTIFY),
        "google" => Some(&GOOGLE),
        _ => None,
    }
}

/// Why `access_token` could not hand one over.
#[derive(Debug, PartialEq)]
pub enum AuthError {
    NotConnected,
    /// The refresh token was revoked or expired: the user has to sign in again.
    Reconnect,
    Failed(String),
}

impl AuthError {
    pub fn message(&self) -> String {
        match self {
            AuthError::NotConnected => "Not connected".into(),
            AuthError::Reconnect => "Reconnect".into(),
            AuthError::Failed(m) => m.clone(),
        }
    }
}

// ── Pure helpers (unit tested) ────────────────────────────────────────────────

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).expect("the OS random source is unavailable");
    buf
}

/// 64 random bytes → 86 base64url characters, inside RFC 7636's 43-128.
fn generate_verifier() -> String {
    URL_SAFE_NO_PAD.encode(random_bytes::<64>())
}

fn generate_state() -> String {
    URL_SAFE_NO_PAD.encode(random_bytes::<24>())
}

/// S256: BASE64URL(SHA256(verifier)) without padding.
fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn build_auth_url(p: &Provider, client_id: &str, redirect: &str, state: &str, challenge: &str) -> String {
    let mut url = url::Url::parse(p.auth_url).expect("provider auth url is valid");
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("response_type", "code")
            .append_pair("client_id", client_id)
            .append_pair("redirect_uri", redirect)
            .append_pair("scope", p.scopes)
            .append_pair("state", state)
            .append_pair("code_challenge_method", "S256")
            .append_pair("code_challenge", challenge);
        for (k, v) in p.extra_auth_params {
            q.append_pair(k, v);
        }
    }
    url.into()
}

#[derive(Debug, PartialEq)]
enum Callback {
    Code(String),
    Failed(String),
    /// Anything that is not /callback (favicon, preconnect probes).
    Other,
}

/// `GET /callback?code=…&state=… HTTP/1.1` → the request target.
fn request_target(head: &str) -> Option<&str> {
    let line = head.lines().next()?;
    let mut parts = line.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    parts.next()
}

fn parse_callback(target: &str, expected_state: &str) -> Callback {
    let Ok(url) = url::Url::parse(&format!("http://127.0.0.1{target}")) else {
        return Callback::Other;
    };
    if url.path() != "/callback" {
        return Callback::Other;
    }
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            "error" => error = Some(v.into_owned()),
            _ => {}
        }
    }
    // State first: a callback that fails the check is never trusted, whatever else it says.
    if state.as_deref() != Some(expected_state) {
        return Callback::Failed("The sign-in answer did not match this request.".into());
    }
    if let Some(e) = error {
        return Callback::Failed(if e == "access_denied" {
            "Access was denied.".into()
        } else {
            format!("The provider refused the sign-in ({e}).")
        });
    }
    match code {
        Some(c) if !c.is_empty() => Callback::Code(c),
        _ => Callback::Failed("The sign-in answer had no code.".into()),
    }
}

fn needs_refresh(expiry: Option<u64>, now: u64) -> bool {
    match expiry {
        Some(at) => at <= now + REFRESH_MARGIN_SECS,
        None => true,
    }
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

// ── Token storage ─────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

fn store_tokens(p: &Provider, t: TokenResponse) -> Result<(), String> {
    secrets::set(p.access_key, &t.access_token)?;
    let expiry = now_secs() + t.expires_in.unwrap_or(3600);
    secrets::set(p.expiry_key, &expiry.to_string())?;
    // Providers may rotate the refresh token; when they do not, keep the old one.
    if let Some(r) = t.refresh_token.filter(|r| !r.is_empty()) {
        secrets::set(p.refresh_key, &r)?;
    }
    Ok(())
}

fn clear_tokens(p: &Provider) {
    for key in [p.access_key, p.refresh_key, p.expiry_key] {
        let _ = secrets::clear(key);
    }
}

pub fn connected(p: &Provider) -> bool {
    secrets::present(p.refresh_key)
}

fn http() -> reqwest::Client {
    reqwest::Client::builder().timeout(HTTP_TIMEOUT).build().unwrap_or_default()
}

/// Posts the form to the token URL. Only the status and the provider's `error`
/// code ever reach the log; the body can hold tokens.
async fn token_request(p: &Provider, mut form: Vec<(&str, String)>) -> Result<TokenResponse, (u16, String)> {
    let client_id = secrets::get(p.client_id_key).ok_or((0, "Client ID missing".to_string()))?;
    form.push(("client_id", client_id));
    if let Some(secret) = p.client_secret_key.and_then(secrets::get) {
        form.push(("client_secret", secret));
    }
    let response = http()
        .post(p.token_url)
        .form(&form)
        .send()
        .await
        .map_err(|_| (0, "No connection".to_string()))?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        let body: serde_json::Value = response.json().await.unwrap_or_default();
        let error = body.get("error").and_then(|e| e.as_str()).unwrap_or("").to_string();
        log::line(format!("oauth {} token HTTP {status} {error}", p.id));
        return Err((status, error));
    }
    response
        .json::<TokenResponse>()
        .await
        .map_err(|_| (status, "Unreadable token response".to_string()))
}

static REFRESH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// A usable access token, refreshed first when less than 60 s remain.
pub async fn access_token(p: &Provider) -> Result<String, AuthError> {
    let Some(refresh) = secrets::get(p.refresh_key) else {
        return Err(AuthError::NotConnected);
    };
    let fresh = |p: &Provider| {
        let expiry = secrets::get(p.expiry_key).and_then(|s| s.parse::<u64>().ok());
        if needs_refresh(expiry, now_secs()) {
            None
        } else {
            secrets::get(p.access_key)
        }
    };
    if let Some(token) = fresh(p) {
        return Ok(token);
    }

    // One refresh at a time: a second caller finds the new token when it gets in.
    let _guard = REFRESH_LOCK.lock().await;
    if let Some(token) = fresh(p) {
        return Ok(token);
    }
    let form = vec![("grant_type", "refresh_token".to_string()), ("refresh_token", refresh)];
    match token_request(p, form).await {
        Ok(tokens) => {
            let token = tokens.access_token.clone();
            store_tokens(p, tokens).map_err(AuthError::Failed)?;
            Ok(token)
        }
        Err((400 | 401, error)) if error == "invalid_grant" => {
            clear_tokens(p);
            Err(AuthError::Reconnect)
        }
        Err((_, message)) => Err(AuthError::Failed(if message.is_empty() {
            "Sign-in refresh failed".into()
        } else {
            message
        })),
    }
}

/// Drops the access token so the next call refreshes (the API said it was stale).
pub fn forget_access_token(p: &Provider) {
    let _ = secrets::clear(p.expiry_key);
}

// ── Connect ───────────────────────────────────────────────────────────────────

static CONNECTING: std::sync::LazyLock<Mutex<HashSet<&'static str>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashSet::new()));

struct ConnectGuard(&'static str);

impl ConnectGuard {
    fn acquire(id: &'static str) -> Option<Self> {
        CONNECTING.lock().unwrap().insert(id).then_some(ConnectGuard(id))
    }
}

impl Drop for ConnectGuard {
    fn drop(&mut self) {
        CONNECTING.lock().unwrap().remove(self.0);
    }
}

fn page(ok: bool, message: &str) -> String {
    let title = if ok { "Signed in" } else { "Sign-in failed" };
    format!(
        "<!doctype html><meta charset=utf-8><title>Coucou</title>\
         <body style=\"font:16px system-ui,sans-serif;background:#0b0c0f;color:#eee;\
         display:grid;place-items:center;height:100vh;margin:0\">\
         <div style=\"text-align:center\"><h2>{title}</h2><p>{message}</p></div></body>"
    )
}

async fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let reply = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(reply.as_bytes()).await;
    let _ = stream.shutdown().await;
}

/// Reads one request head (up to 8 KB) from the stream.
async fn read_head(stream: &mut TcpStream) -> Option<String> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        let n = tokio::time::timeout(READ_TIMEOUT, stream.read(&mut chunk)).await.ok()?.ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") || buf.len() > 8192 {
            break;
        }
    }
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Takes connections until the /callback one arrives. Browsers also knock for
/// /favicon.ico and open idle connections; those get a 404 and do not count.
async fn wait_for_code(listener: &TcpListener, state: &str) -> Result<String, String> {
    loop {
        let (mut stream, _) = listener.accept().await.map_err(|e| format!("Listener failed: {e}"))?;
        let Some(head) = read_head(&mut stream).await else { continue };
        let Some(target) = request_target(&head) else {
            respond(&mut stream, "404 Not Found", "").await;
            continue;
        };
        match parse_callback(target, state) {
            Callback::Code(code) => {
                respond(&mut stream, "200 OK", &page(true, "You can close this tab and go back to Coucou.")).await;
                return Ok(code);
            }
            Callback::Failed(message) => {
                respond(&mut stream, "400 Bad Request", &page(false, &message)).await;
                return Err(message);
            }
            Callback::Other => respond(&mut stream, "404 Not Found", "").await,
        }
    }
}

async fn connect(p: &'static Provider) -> Result<(), String> {
    let client_id = secrets::get(p.client_id_key).ok_or("Enter your Client ID first")?;
    let _guard = ConnectGuard::acquire(p.id).ok_or("A sign-in is already open")?;

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Could not open the sign-in listener: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}/callback");

    let verifier = generate_verifier();
    let state = generate_state();
    let url = build_auth_url(p, &client_id, &redirect, &state, &pkce_challenge(&verifier));
    platform::open_url(&url);

    let code = tokio::time::timeout(CONNECT_TIMEOUT, wait_for_code(&listener, &state))
        .await
        .map_err(|_| "Sign-in timed out".to_string())??;
    drop(listener);

    let form = vec![
        ("grant_type", "authorization_code".to_string()),
        ("code", code),
        ("redirect_uri", redirect),
        ("code_verifier", verifier),
    ];
    let tokens = token_request(p, form).await.map_err(|(_, message)| {
        if message.is_empty() { "Sign-in failed".to_string() } else { format!("Sign-in failed ({message})") }
    })?;
    if tokens.refresh_token.as_deref().unwrap_or("").is_empty() {
        return Err("The provider gave no refresh token".into());
    }
    store_tokens(p, tokens)
}

// ── Commands ──────────────────────────────────────────────────────────────────

fn lookup(id: &str) -> Result<&'static Provider, String> {
    provider(id).ok_or_else(|| format!("unknown provider {id}"))
}

#[tauri::command]
pub async fn oauth_connect(app: AppHandle, provider: String) -> Result<(), String> {
    let p = lookup(&provider)?;
    let result = connect(p).await;
    if let Err(e) = &result {
        log::line(format!("oauth {} connect failed: {e}", p.id));
    } else {
        log::line(format!("oauth {} connected", p.id));
    }
    let _ = app.emit("oauth-changed", p.id);
    result
}

/// Deletes this provider's tokens only; the client id stays.
#[tauri::command]
pub fn oauth_disconnect(app: AppHandle, provider: String) -> Result<(), String> {
    let p = lookup(&provider)?;
    clear_tokens(p);
    let _ = app.emit("oauth-changed", p.id);
    Ok(())
}

#[tauri::command]
pub fn oauth_status(provider: String) -> bool {
    provider_connected(&provider)
}

fn provider_connected(id: &str) -> bool {
    provider(id).map(connected).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_matches_rfc7636_appendix_b() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn verifier_is_in_range_and_unreserved() {
        let v = generate_verifier();
        assert!((43..=128).contains(&v.len()));
        assert!(v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_ne!(v, generate_verifier());
    }

    #[test]
    fn auth_url_is_encoded() {
        let url = build_auth_url(&SPOTIFY, "abc 123", "http://127.0.0.1:5000/callback", "st&te", "chal");
        assert!(url.starts_with("https://accounts.spotify.com/authorize?"));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("client_id=abc+123"));
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A5000%2Fcallback"));
        assert!(url.contains("scope=user-read-currently-playing+user-read-playback-state+user-modify-playback-state"));
        assert!(url.contains("state=st%26te"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("code_challenge=chal"));
    }

    #[test]
    fn google_provider_is_registered_and_asks_for_offline_access() {
        assert!(provider("google").is_some());
        let url = build_auth_url(&GOOGLE, "id", "http://127.0.0.1:1/callback", "s", "c");
        assert!(url.starts_with("https://accounts.google.com/o/oauth2/v2/auth?"));
        assert!(url.contains("access_type=offline"));
        assert!(url.contains("prompt=consent"));
        assert!(url.contains("calendar.readonly"));
        for key in [
            GOOGLE.client_id_key,
            GOOGLE.client_secret_key.unwrap(),
            GOOGLE.access_key,
            GOOGLE.refresh_key,
            GOOGLE.expiry_key,
        ] {
            assert!(secrets::KNOWN_KEYS.contains(&key), "{key} missing from KNOWN_KEYS");
        }
    }

    #[test]
    fn auth_url_carries_extra_params() {
        const P: Provider = Provider {
            extra_auth_params: &[("access_type", "offline")],
            ..SPOTIFY
        };
        assert!(build_auth_url(&P, "id", "http://127.0.0.1:1/callback", "s", "c").contains("access_type=offline"));
    }

    #[test]
    fn callback_with_matching_state_gives_the_code() {
        assert_eq!(parse_callback("/callback?code=a%2Fb&state=xyz", "xyz"), Callback::Code("a/b".into()));
    }

    #[test]
    fn callback_state_mismatch_is_an_error() {
        assert!(matches!(parse_callback("/callback?code=abc&state=nope", "xyz"), Callback::Failed(_)));
        assert!(matches!(parse_callback("/callback?code=abc", "xyz"), Callback::Failed(_)));
    }

    #[test]
    fn callback_access_denied_is_an_error() {
        let got = parse_callback("/callback?error=access_denied&state=xyz", "xyz");
        assert_eq!(got, Callback::Failed("Access was denied.".into()));
    }

    #[test]
    fn callback_without_code_is_an_error() {
        assert!(matches!(parse_callback("/callback?state=xyz", "xyz"), Callback::Failed(_)));
    }

    #[test]
    fn other_paths_are_ignored() {
        assert_eq!(parse_callback("/favicon.ico", "xyz"), Callback::Other);
    }

    #[test]
    fn request_target_reads_the_first_line() {
        let head = "GET /callback?code=1&state=2 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";
        assert_eq!(request_target(head), Some("/callback?code=1&state=2"));
        assert_eq!(request_target("POST /callback HTTP/1.1\r\n\r\n"), None);
    }

    #[test]
    fn refresh_decision() {
        assert!(needs_refresh(None, 1000));
        assert!(needs_refresh(Some(1000), 1000));
        assert!(needs_refresh(Some(1059), 1000));
        assert!(!needs_refresh(Some(1061), 1000));
        assert!(!needs_refresh(Some(5000), 1000));
    }
}
