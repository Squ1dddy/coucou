// Integration pollers — the Rust side of StripePoller / VercelPoller /
// N8nPoller / NotionPoller / CalcomPoller.
//
// Same endpoints, same first-run delays and intervals as the Swift pollers. Each
// one emits an `integration` event; the island owns the badge, the sound and the
// 60 s auto-clear, exactly as the Swift handlers do.
//
// Nothing is polled until its key exists in the Credential Manager, and no
// request goes anywhere the user has not configured.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::island::WINDOW_LABEL;
use crate::log;
use crate::oauth;
use crate::platform;
use crate::secrets;

const TIMEOUT: Duration = Duration::from_secs(10);

/// What the island receives. `event` is only set when something actually changed,
/// which is what drives the pill badge and the sound.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationUpdate {
    pub id: &'static str,
    pub data: Value,
    pub error: Option<String>,
    pub event: Option<IntegrationEvent>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationEvent {
    pub success: bool,
    pub label: String,
    pub detail: Option<String>,
}

fn emit(app: &AppHandle, update: IntegrationUpdate) {
    let _ = app.emit_to(WINDOW_LABEL, "integration", update);
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .unwrap_or_default()
}

/// Set from the tray's Pause item. While it is on, nothing reaches the network:
/// pausing Coucou has to mean pausing Coucou, not just hiding the island.
pub static PAUSED: AtomicBool = AtomicBool::new(false);

pub fn set_paused(on: bool) {
    PAUSED.store(on, Ordering::Relaxed);
}

/// Spawns every poller with the macOS delays and intervals.
pub fn start(app: AppHandle) {
    spawn(app.clone(), "integration_n8n", 3, 15, poll_n8n);
    spawn(app.clone(), "integration_vercel", 5, 30, poll_vercel);
    spawn(app.clone(), "integration_stripe", 6, 30, poll_stripe);
    spawn(app.clone(), "integration_calcom", 8, 300, poll_calcom);
    spawn(app.clone(), "integration_notion", 9, 300, poll_notion);
    spawn(app.clone(), "integration_gcal", 10, 300, poll_gcal);
    spawn_spotify(app);
}

/// Spotify runs its own loop: 5 s while the island is showing, 30 s while it is
/// collapsed. The same paused / switched-off guards as every other poller, plus
/// nothing at all until the user has signed in.
fn spawn_spotify(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(4)).await;
        let mut last: Option<std::time::Instant> = None;
        let mut ticker = tokio::time::interval(Duration::from_secs(5));
        loop {
            ticker.tick().await;
            if !spotify_allowed(&app) {
                continue;
            }
            let collapsed = app
                .try_state::<crate::Shared>()
                .map(|s| s.gate.collapsed.load(Ordering::Relaxed))
                .unwrap_or(true);
            if collapsed && last.is_some_and(|t| t.elapsed() < Duration::from_secs(30)) {
                continue;
            }
            last = Some(std::time::Instant::now());
            poll_spotify(app.clone()).await;
        }
    });
}

/// Not paused, switched on in settings, and signed in.
fn spotify_allowed(app: &AppHandle) -> bool {
    !PAUSED.load(Ordering::Relaxed)
        && enabled(app, "integration_spotify")
        && oauth::connected(&oauth::SPOTIFY)
}

/// True when the user has this integration switched on in settings.
fn enabled(app: &AppHandle, id: &str) -> bool {
    app.try_state::<crate::Shared>()
        .map(|shared| {
            let settings = shared.settings.lock().unwrap();
            settings.active_integrations.iter().any(|x| x == id)
        })
        .unwrap_or(false)
}

fn spawn<F, Fut>(app: AppHandle, id: &'static str, delay_secs: u64, every_secs: u64, poll: F)
where
    F: Fn(AppHandle) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send,
{
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(delay_secs)).await;
        let mut ticker = tokio::time::interval(Duration::from_secs(every_secs));
        loop {
            ticker.tick().await;
            // The ticker keeps its cadence; we just decline to do the work. An
            // integration the user switched off, or a paused app, must make no
            // network calls at all — CLAUDE.md allows talking only to services
            // the user configured, and a disabled one is not configured.
            if PAUSED.load(Ordering::Relaxed) || !enabled(&app, id) {
                continue;
            }
            poll(app.clone()).await;
        }
    });
}

/// One-shot refresh from the Refresh buttons in the island.
pub async fn poll_once(app: AppHandle, id: &str) {
    match id {
        "integration_stripe" => poll_stripe(app).await,
        "integration_vercel" => poll_vercel(app).await,
        "integration_n8n" => poll_n8n(app).await,
        "integration_notion" => poll_notion(app).await,
        "integration_calcom" => poll_calcom(app).await,
        "integration_spotify" if spotify_allowed(&app) => poll_spotify(app).await,
        "integration_gcal" if gcal_allowed(&app) => poll_gcal(app).await,
        _ => {}
    }
}

/// Remembers the newest id per integration so an event fires once, not on every poll.
struct Seen(Mutex<std::collections::HashMap<&'static str, String>>);

static SEEN: std::sync::LazyLock<Seen> =
    std::sync::LazyLock::new(|| Seen(Mutex::new(std::collections::HashMap::new())));

/// Returns true the first time a given id is seen (and false on the very first
/// load, which only fills the card).
fn is_new(key: &'static str, id: &str) -> bool {
    let mut map = SEEN.0.lock().unwrap();
    match map.insert(key, id.to_string()) {
        Some(previous) => previous != id,
        None => false, // first poll: populate silently, like the Swift pollers
    }
}

fn status_error(code: u16, unauthorised_hint: &str) -> String {
    match code {
        401 => "Invalid API key (401)".into(),
        403 => unauthorised_hint.into(),
        _ => format!("API error {code}"),
    }
}

// ── Stripe ────────────────────────────────────────────────────────────────────

async fn poll_stripe(app: AppHandle) {
    let Some(key) = secrets::get("stripe-api-key") else { return };
    let auth = format!("Basic {}", crate::claude::base64_for(format!("{key}:").as_bytes()));
    let http = client();

    let balance = http
        .get("https://api.stripe.com/v1/balance")
        .header("Authorization", &auth)
        .send()
        .await;

    let (amount, currency) = match balance {
        Ok(r) if r.status().is_success() => {
            let json: Value = r.json().await.unwrap_or(json!({}));
            let mut buckets: Vec<Value> = Vec::new();
            for k in ["available", "pending"] {
                if let Some(arr) = json.get(k).and_then(Value::as_array) {
                    buckets.extend(arr.iter().cloned());
                }
            }
            let currency = buckets
                .first()
                .and_then(|b| b.get("currency"))
                .and_then(Value::as_str)
                .unwrap_or("eur")
                .to_string();
            let amount: i64 = buckets
                .iter()
                .filter_map(|b| b.get("amount").and_then(Value::as_i64))
                .sum();
            (amount, currency)
        }
        Ok(r) => {
            let code = r.status().as_u16();
            emit(&app, IntegrationUpdate {
                id: "integration_stripe",
                data: json!({}),
                error: Some(status_error(code, "Use a secret key (sk_live_… not pk_live_…)")),
                event: None,
            });
            return;
        }
        Err(e) => {
            emit(&app, IntegrationUpdate {
                id: "integration_stripe",
                data: json!({}),
                error: Some(format!("No connection: {e}")),
                event: None,
            });
            return;
        }
    };

    let charges = http
        .get("https://api.stripe.com/v1/charges?limit=3")
        .header("Authorization", &auth)
        .send()
        .await;
    let Ok(response) = charges else { return };
    if !response.status().is_success() {
        return;
    }
    let json: Value = response.json().await.unwrap_or(json!({}));
    let payments: Vec<Value> = json
        .get("data")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|c| {
                    let description = c
                        .get("description")
                        .and_then(Value::as_str)
                        .or_else(|| {
                            c.get("billing_details")
                                .and_then(|b| b.get("name"))
                                .and_then(Value::as_str)
                        })
                        .map(str::to_string);
                    Some(json!({
                        "id": c.get("id")?.as_str()?,
                        "amount": c.get("amount")?.as_i64()?,
                        "currency": c.get("currency")?.as_str()?,
                        "description": description,
                        "createdAt": c.get("created").and_then(Value::as_i64).unwrap_or(0) * 1000,
                        "status": c.get("status").and_then(Value::as_str).unwrap_or("succeeded"),
                    }))
                })
                .collect()
        })
        .unwrap_or_default();

    let newest = payments
        .first()
        .and_then(|p| p.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let event = if !newest.is_empty() && is_new("stripe", &newest) {
        let label = payments[0]
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| {
                let cents = payments[0].get("amount").and_then(Value::as_i64).unwrap_or(0);
                format!("{:.2}", cents as f64 / 100.0)
            });
        Some(IntegrationEvent { success: true, label, detail: None })
    } else {
        None
    };

    emit(&app, IntegrationUpdate {
        id: "integration_stripe",
        data: json!({ "balance": amount, "currency": currency, "payments": payments }),
        error: None,
        event,
    });
}

// ── Vercel ────────────────────────────────────────────────────────────────────

async fn poll_vercel(app: AppHandle) {
    let Some(token) = secrets::get("vercel-token") else { return };
    let response = client()
        .get("https://api.vercel.com/v6/deployments?limit=5")
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
        .send()
        .await;
    let Ok(response) = response else { return };
    if !response.status().is_success() {
        emit(&app, IntegrationUpdate {
            id: "integration_vercel",
            data: json!({}),
            error: Some(status_error(response.status().as_u16(), "Token lacks access")),
            event: None,
        });
        return;
    }
    let json: Value = response.json().await.unwrap_or(json!({}));
    let terminal = ["READY", "ERROR", "CANCELED"];
    let deployments: Vec<Value> = json
        .get("deployments")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|d| {
                    let state = d.get("state")?.as_str()?;
                    if !terminal.contains(&state) {
                        return None;
                    }
                    let meta = d.get("meta");
                    let pick = |keys: [&str; 3]| {
                        meta.and_then(|m| keys.iter().find_map(|k| m.get(*k).and_then(Value::as_str)))
                            .map(str::to_string)
                    };
                    Some(json!({
                        "id": d.get("uid")?.as_str()?,
                        "projectName": d.get("name")?.as_str()?,
                        "url": d.get("url").and_then(Value::as_str).unwrap_or(""),
                        "state": state,
                        "createdAt": d.get("createdAt").and_then(Value::as_f64).unwrap_or(0.0),
                        "commitMessage": pick(["githubCommitMessage", "gitlabCommitMessage", "bitbucketCommitMessage"]),
                        "branch": pick(["githubCommitRef", "gitlabCommitRef", "bitbucketBranch"]),
                    }))
                })
                .collect()
        })
        .unwrap_or_default();

    let event = deployments.first().and_then(|latest| {
        let id = latest.get("id")?.as_str()?;
        if !is_new("vercel", id) {
            return None;
        }
        let success = latest.get("state")?.as_str()? == "READY";
        Some(IntegrationEvent {
            success,
            label: latest.get("projectName")?.as_str()?.to_string(),
            detail: None,
        })
    });

    emit(&app, IntegrationUpdate {
        id: "integration_vercel",
        data: json!({ "deployments": deployments }),
        error: None,
        event,
    });
}

// ── Notion ────────────────────────────────────────────────────────────────────

async fn poll_notion(app: AppHandle) {
    let Some(token) = secrets::get("notion-api-key") else { return };
    let response = client()
        .post("https://api.notion.com/v1/search")
        .header("Authorization", format!("Bearer {token}"))
        .header("Notion-Version", "2022-06-28")
        .header("Content-Type", "application/json")
        .json(&json!({
            "sort": { "direction": "descending", "timestamp": "last_edited_time" },
            "page_size": 3
        }))
        .send()
        .await;
    let Ok(response) = response else { return };
    if !response.status().is_success() {
        emit(&app, IntegrationUpdate {
            id: "integration_notion",
            data: json!({}),
            error: Some(status_error(response.status().as_u16(), "Integration lacks access")),
            event: None,
        });
        return;
    }
    let json: Value = response.json().await.unwrap_or(json!({}));
    let pages: Vec<Value> = json
        .get("results")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(parse_notion_page).collect())
        .unwrap_or_default();

    emit(&app, IntegrationUpdate {
        id: "integration_notion",
        data: json!({ "pages": pages }),
        error: None,
        event: None,
    });
}

fn parse_notion_page(obj: &Value) -> Option<Value> {
    let id = obj.get("id")?.as_str()?;
    let is_database = obj.get("object").and_then(Value::as_str) == Some("database");

    let mut title = "Untitled".to_string();
    if is_database {
        if let Some(text) = obj
            .get("title")
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(|t| t.get("plain_text"))
            .and_then(Value::as_str)
        {
            if !text.is_empty() {
                title = text.to_string();
            }
        }
    } else if let Some(props) = obj.get("properties").and_then(Value::as_object) {
        for prop in props.values() {
            if prop.get("type").and_then(Value::as_str) != Some("title") {
                continue;
            }
            if let Some(text) = prop
                .get("title")
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                .and_then(|t| t.get("plain_text"))
                .and_then(Value::as_str)
            {
                if !text.is_empty() {
                    title = text.to_string();
                    break;
                }
            }
        }
    }

    let emoji = obj
        .get("icon")
        .filter(|i| i.get("type").and_then(Value::as_str) == Some("emoji"))
        .and_then(|i| i.get("emoji"))
        .and_then(Value::as_str);

    Some(json!({
        "id": id,
        "title": title,
        "emoji": emoji,
        "lastEditedAt": obj.get("last_edited_time").and_then(Value::as_str)?,
        "url": obj.get("url").and_then(Value::as_str).unwrap_or("https://notion.so"),
    }))
}

// ── Cal.com ───────────────────────────────────────────────────────────────────

async fn poll_calcom(app: AppHandle) {
    let Some(key) = secrets::get("calcom-api-key") else { return };
    let response = client()
        .get("https://api.cal.com/v2/bookings?status=upcoming")
        .header("Authorization", format!("Bearer {key}"))
        .header("cal-api-version", "2024-08-13")
        .send()
        .await;
    let Ok(response) = response else { return };
    if !response.status().is_success() {
        emit(&app, IntegrationUpdate {
            id: "integration_calcom",
            data: json!({}),
            error: Some(status_error(response.status().as_u16(), "Key lacks access")),
            event: None,
        });
        return;
    }
    let json: Value = response.json().await.unwrap_or(json!({}));
    let bookings: Vec<Value> = json
        .get("data")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|b| {
                    let start = b
                        .get("start")
                        .or_else(|| b.get("startTime"))
                        .and_then(Value::as_str)?;
                    let attendee = b.get("attendees").and_then(Value::as_array).and_then(|a| a.first());
                    let notes = b
                        .get("responses")
                        .and_then(|r| r.get("notes"))
                        .and_then(|n| n.get("value"))
                        .and_then(Value::as_str)
                        .or_else(|| b.get("description").and_then(Value::as_str))
                        .filter(|s| !s.is_empty());
                    Some(json!({
                        "id": b.get("id").map(|v| v.to_string()).unwrap_or_default(),
                        "title": b.get("title").and_then(Value::as_str).unwrap_or("Meeting"),
                        "start": start,
                        "status": b.get("status").and_then(Value::as_str).unwrap_or("accepted"),
                        "attendeeName": attendee.and_then(|a| a.get("name")).and_then(Value::as_str),
                        "attendeeEmail": attendee.and_then(|a| a.get("email")).and_then(Value::as_str),
                        "attendeeNotes": notes,
                    }))
                })
                .collect()
        })
        .unwrap_or_default();

    emit(&app, IntegrationUpdate {
        id: "integration_calcom",
        data: json!({ "bookings": bookings }),
        error: None,
        event: None,
    });
}

// ── n8n ───────────────────────────────────────────────────────────────────────

async fn poll_n8n(app: AppHandle) {
    let (Some(key), Some(raw_base)) = (secrets::get("n8n-api-key"), secrets::get("n8n-url")) else {
        return;
    };
    let base = raw_base.trim_end_matches('/').to_string();
    let http = client();

    // Same two shapes as the Swift poller: the public API first, then /rest.
    let list_urls = [
        format!("{base}/api/v1/executions?limit=1&includeData=false"),
        format!("{base}/rest/executions?limit=1&includeData=false"),
    ];

    let mut items: Option<Vec<Value>> = None;
    for url in &list_urls {
        let Ok(response) = http.get(url).header("X-N8N-API-KEY", &key).header("Accept", "application/json").send().await
        else {
            continue;
        };
        if !response.status().is_success() {
            // Only the status: a self-hosted base URL can carry credentials.
            log::line(format!("n8n list HTTP {}", response.status()));
            continue;
        }
        let Ok(json) = response.json::<Value>().await else { continue };
        items = match &json {
            Value::Object(o) => o.get("data").and_then(Value::as_array).cloned(),
            Value::Array(a) => Some(a.clone()),
            _ => None,
        };
        if items.is_some() {
            break;
        }
    }

    let Some(first) = items.and_then(|list| list.into_iter().next()) else { return };
    let id = match first.get("id") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => return,
    };

    let status = first.get("status").and_then(Value::as_str).unwrap_or("");
    if !["success", "error", "crashed", "canceled", "failed"].contains(&status) {
        return;
    }
    if !is_new("n8n", &id) {
        return;
    }
    let success = status == "success";

    let detail_urls = [
        format!("{base}/api/v1/executions/{id}?includeData=true"),
        format!("{base}/api/v1/executions/{id}"),
        format!("{base}/rest/executions/{id}?includeData=true"),
        format!("{base}/rest/executions/{id}"),
    ];
    let mut name = "Workflow".to_string();
    let mut detail = None;
    for url in &detail_urls {
        let Ok(response) = http.get(url).header("X-N8N-API-KEY", &key).header("Accept", "application/json").send().await
        else {
            continue;
        };
        if !response.status().is_success() {
            continue;
        }
        let Ok(json) = response.json::<Value>().await else { continue };
        name = json
            .get("workflowData")
            .and_then(|w| w.get("name"))
            .and_then(Value::as_str)
            .or_else(|| json.get("name").and_then(Value::as_str))
            .unwrap_or("Workflow")
            .to_string();
        detail = n8n_detail(&json, success);
        break;
    }

    log::line(format!("n8n execution {id} {status} · {name}"));
    emit(&app, IntegrationUpdate {
        id: "integration_n8n",
        data: json!({ "workflow": name, "status": status }),
        error: None,
        event: Some(IntegrationEvent { success, label: name, detail }),
    });
}

fn n8n_detail(json: &Value, success: bool) -> Option<String> {
    let result = json.get("data")?.get("resultData")?;
    if !success {
        if let Some(error) = result.get("error") {
            let message = error.get("message").and_then(Value::as_str).unwrap_or("");
            if let Some(node) = error.get("node").and_then(|n| n.get("name")).and_then(Value::as_str) {
                if !node.is_empty() {
                    return Some(format!("{node}\n{message}"));
                }
            }
            return Some(message.to_string());
        }
        let runs = result.get("runData")?.as_object()?;
        for (node, value) in runs {
            if let Some(message) = value
                .as_array()
                .and_then(|a| a.first())
                .and_then(|r| r.get("error"))
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
            {
                return Some(format!("{node}\n{message}"));
            }
        }
        return None;
    }

    let last_node = result.get("lastNodeExecuted")?.as_str()?;
    let items = result
        .get("runData")?
        .get(last_node)?
        .as_array()?
        .first()?
        .get("data")?
        .get("main")?
        .as_array()?
        .first()?
        .as_array()?;
    let count = items.len();
    let header = format!("→ {last_node} · {count} item{}", if count == 1 { "" } else { "s" });

    let fields = items
        .first()
        .and_then(|i| i.get("json"))
        .and_then(Value::as_object)
        .map(|obj| {
            obj.iter()
                .take(4)
                .map(|(k, v)| format!("{k}: {}", fmt_value(v)))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .filter(|s| !s.is_empty());

    Some(match fields {
        Some(f) => format!("{header}\n{f}"),
        None => header,
    })
}

fn fmt_value(v: &Value) -> String {
    match v {
        Value::String(s) => s.chars().take(50).collect(),
        Value::Array(a) => format!("[{}]", a.len()),
        Value::Object(_) => "{…}".into(),
        other => other.to_string(),
    }
}

// ── Spotify ───────────────────────────────────────────────────────────────────

const SPOTIFY_API: &str = "https://api.spotify.com/v1/me/player";

fn spotify_update(app: &AppHandle, data: Value, error: Option<String>) {
    // Never an `event`: music gets no sound and no badge.
    emit(app, IntegrationUpdate { id: "integration_spotify", data, error, event: None });
}

async fn poll_spotify(app: AppHandle) {
    let token = match oauth::access_token(&oauth::SPOTIFY).await {
        Ok(t) => t,
        Err(oauth::AuthError::NotConnected) => return,
        Err(e) => {
            spotify_update(&app, json!({}), Some(e.message()));
            return;
        }
    };
    let response = client()
        .get(format!("{SPOTIFY_API}/currently-playing?additional_types=episode"))
        .bearer_auth(&token)
        .send()
        .await;
    let Ok(response) = response else { return };
    let code = response.status().as_u16();
    match code {
        // Nothing playing is a normal state, not an error.
        204 => spotify_update(&app, spotify_data(&json!({})), None),
        200 => {
            let body: Value = response.json().await.unwrap_or(json!({}));
            spotify_update(&app, spotify_data(&body), None);
        }
        401 => oauth::forget_access_token(&oauth::SPOTIFY), // stale: the next tick refreshes
        429 => spotify_update(&app, json!({}), Some("Spotify is rate limiting, retrying".into())),
        _ => spotify_update(&app, json!({}), Some(format!("Spotify error {code}"))),
    }
}

/// The card's data from a `currently-playing` body. Empty body means not playing.
fn spotify_data(body: &Value) -> Value {
    let Some(item) = body.get("item").filter(|i| i.is_object()) else {
        return json!({ "playing": false });
    };
    let names = |list: Option<&Value>| {
        list.and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.get("name").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .filter(|s| !s.is_empty())
    };
    // Podcast episodes have a show instead of artists and an album.
    let show = item.get("show").and_then(|s| s.get("name")).and_then(Value::as_str);
    let artist = names(item.get("artists")).or_else(|| show.map(str::to_string));
    let album = item.get("album").and_then(|a| a.get("name")).and_then(Value::as_str).or(show);
    // Images come largest first; the card only needs a small one.
    let art = item
        .get("album")
        .or_else(|| item.get("show"))
        .and_then(|a| a.get("images"))
        .and_then(Value::as_array)
        .and_then(|imgs| imgs.last())
        .and_then(|i| i.get("url"))
        .and_then(Value::as_str);
    json!({
        "playing": body.get("is_playing").and_then(Value::as_bool).unwrap_or(false),
        "title": item.get("name").and_then(Value::as_str),
        "artist": artist,
        "album": album,
        "artUrl": art,
        "progressMs": body.get("progress_ms").and_then(Value::as_u64).unwrap_or(0),
        "durationMs": item.get("duration_ms").and_then(Value::as_u64).unwrap_or(0),
        "trackUrl": item.get("external_urls").and_then(|u| u.get("spotify")).and_then(Value::as_str),
    })
}

/// play | pause | next | previous, then a poll so the card catches up at once.
pub async fn spotify_control(app: AppHandle, action: &str) -> Result<(), String> {
    let (method, path) = match action {
        "play" => (reqwest::Method::PUT, "play"),
        "pause" => (reqwest::Method::PUT, "pause"),
        "next" => (reqwest::Method::POST, "next"),
        "previous" => (reqwest::Method::POST, "previous"),
        _ => return Err(format!("unknown action {action}")),
    };
    if !spotify_allowed(&app) {
        return Err("Spotify is not connected".into());
    }
    let token = oauth::access_token(&oauth::SPOTIFY).await.map_err(|e| e.message())?;
    let response = client()
        .request(method, format!("{SPOTIFY_API}/{path}"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|_| "No connection".to_string())?;
    match response.status().as_u16() {
        200..=299 => {}
        404 => return Err("Open Spotify on a device".into()),
        403 => return Err("Spotify refused (Premium is needed to control playback)".into()),
        401 => {
            oauth::forget_access_token(&oauth::SPOTIFY);
            return Err("Try again".into());
        }
        code => return Err(format!("Spotify error {code}")),
    }
    // Spotify takes a moment to report the new state.
    tokio::time::sleep(Duration::from_millis(400)).await;
    poll_spotify(app).await;
    Ok(())
}

// ── Google Calendar ───────────────────────────────────────────────────────────

const GCAL_EVENTS: &str = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

/// Not paused, switched on in settings, and signed in.
fn gcal_allowed(app: &AppHandle) -> bool {
    !PAUSED.load(Ordering::Relaxed)
        && enabled(app, "integration_gcal")
        && oauth::connected(&oauth::GOOGLE)
}

fn gcal_update(app: &AppHandle, data: Value, error: Option<String>) {
    // Never an `event` from Rust: the 10-minute heads-up is a timer in the island.
    emit(app, IntegrationUpdate { id: "integration_gcal", data, error, event: None });
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Inverse of `days_from_civil`.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// `2026-10-05T03:04:05Z` from Unix seconds.
fn rfc3339_utc(secs: i64) -> String {
    let (y, m, d) = civil_from_days(secs.div_euclid(86400));
    let t = secs.rem_euclid(86400);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", t / 3600, t % 3600 / 60, t % 60)
}

/// `+11:00` / `-03:30` from an offset in seconds east of UTC.
fn fmt_offset(offset_secs: i64) -> String {
    let sign = if offset_secs < 0 { '-' } else { '+' };
    let minutes = offset_secs.abs() / 60;
    format!("{sign}{:02}:{:02}", minutes / 60, minutes % 60)
}

/// The last second of the local day, with its UTC offset, as Google wants `timeMax`.
fn end_of_day_rfc3339(year: i64, month: i64, day: i64, offset_secs: i64) -> String {
    format!("{year:04}-{month:02}-{day:02}T23:59:59{}", fmt_offset(offset_secs))
}

/// The local UTC offset now, in seconds. The platform gives wall-clock fields
/// only, so compare them with UTC; rounding to 15 minutes absorbs the second
/// that can pass between the two clock reads (no zone has a finer step).
fn local_offset_secs(now_utc: i64, local: &platform::LocalTime) -> i64 {
    let local_naive = days_from_civil(local.year.into(), local.month.into(), local.day.into()) * 86400
        + i64::from(local.hour) * 3600
        + i64::from(local.minute) * 60
        + i64::from(local.second);
    let diff = local_naive - now_utc;
    (diff as f64 / 900.0).round() as i64 * 900
}

/// `(timeMin, timeMax)` for "the rest of today" in the user's time zone.
fn gcal_window() -> (String, String) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let local = platform::local_time();
    let offset = local_offset_secs(now, &local);
    (
        rfc3339_utc(now),
        end_of_day_rfc3339(local.year.into(), local.month.into(), local.day.into(), offset),
    )
}

async fn poll_gcal(app: AppHandle) {
    let token = match oauth::access_token(&oauth::GOOGLE).await {
        Ok(t) => t,
        Err(oauth::AuthError::NotConnected) => return,
        Err(e) => {
            gcal_update(&app, json!({}), Some(e.message()));
            return;
        }
    };
    let (time_min, time_max) = gcal_window();
    let response = client()
        .get(GCAL_EVENTS)
        .query(&[
            ("timeMin", time_min.as_str()),
            ("timeMax", time_max.as_str()),
            ("singleEvents", "true"),
            ("orderBy", "startTime"),
            ("maxResults", "20"),
        ])
        .bearer_auth(&token)
        .send()
        .await;
    let Ok(response) = response else { return };
    let code = response.status().as_u16();
    match code {
        200 => {
            let body: Value = response.json().await.unwrap_or(json!({}));
            gcal_update(&app, json!({ "events": gcal_events(&body) }), None);
        }
        401 => oauth::forget_access_token(&oauth::GOOGLE), // stale: the next poll refreshes
        429 => gcal_update(&app, json!({}), Some("Google is rate limiting, retrying".into())),
        _ => gcal_update(&app, json!({}), Some(format!("Google Calendar error {code}"))),
    }
}

/// The card's events from an `events.list` body: all-day first, then timed in
/// the order Google returned them (by start). Cancelled and declined are dropped.
fn gcal_events(body: &Value) -> Vec<Value> {
    let text = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    let pick = |v: &Value| text(v, "dateTime").or_else(|| text(v, "date"));
    let mut all_day = Vec::new();
    let mut timed = Vec::new();
    for item in body.get("items").and_then(Value::as_array).into_iter().flatten() {
        if item.get("status").and_then(Value::as_str) == Some("cancelled") {
            continue;
        }
        let declined = item.get("attendees").and_then(Value::as_array).is_some_and(|a| {
            a.iter().any(|x| {
                x.get("self").and_then(Value::as_bool) == Some(true)
                    && x.get("responseStatus").and_then(Value::as_str) == Some("declined")
            })
        });
        if declined {
            continue;
        }
        let Some(start) = item.get("start") else { continue };
        let Some(start_at) = pick(start) else { continue };
        let is_all_day = start.get("dateTime").is_none();
        let event = json!({
            "id": text(item, "id"),
            "title": text(item, "summary").filter(|s| !s.is_empty()).unwrap_or_else(|| "(No title)".into()),
            "start": start_at,
            "end": item.get("end").and_then(pick),
            "allDay": is_all_day,
            "location": text(item, "location").filter(|s| !s.is_empty()),
            "htmlLink": text(item, "htmlLink"),
        });
        if is_all_day {
            all_day.push(event);
        } else {
            timed.push(event);
        }
    }
    all_day.extend(timed);
    all_day
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gcal_events_split_all_day_first_and_skip_cancelled_and_declined() {
        let body = json!({ "items": [
            { "id": "a", "summary": "Standup", "htmlLink": "https://g/a", "location": "Room 1",
              "start": {"dateTime": "2026-10-05T09:00:00+11:00"}, "end": {"dateTime": "2026-10-05T09:15:00+11:00"} },
            { "id": "b", "summary": "Holiday", "start": {"date": "2026-10-05"}, "end": {"date": "2026-10-06"} },
            { "id": "c", "status": "cancelled", "summary": "Gone",
              "start": {"dateTime": "2026-10-05T10:00:00+11:00"}, "end": {"dateTime": "2026-10-05T11:00:00+11:00"} },
            { "id": "d", "summary": "Declined",
              "attendees": [{"self": true, "responseStatus": "declined"}],
              "start": {"dateTime": "2026-10-05T11:00:00+11:00"}, "end": {"dateTime": "2026-10-05T12:00:00+11:00"} },
            { "id": "e", "summary": "Other declined",
              "attendees": [{"responseStatus": "declined"}, {"self": true, "responseStatus": "accepted"}],
              "start": {"dateTime": "2026-10-05T13:00:00+11:00"}, "end": {"dateTime": "2026-10-05T14:00:00+11:00"} },
            { "id": "f", "start": {"dateTime": "2026-10-05T15:00:00+11:00"} }
        ]});
        let events = gcal_events(&body);
        let ids: Vec<_> = events.iter().map(|e| e["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["b", "a", "e", "f"]);
        assert_eq!(events[0]["allDay"], true);
        assert_eq!(events[0]["start"], "2026-10-05");
        assert_eq!(events[1]["allDay"], false);
        assert_eq!(events[1]["title"], "Standup");
        assert_eq!(events[1]["location"], "Room 1");
        assert_eq!(events[1]["htmlLink"], "https://g/a");
        assert_eq!(events[1]["end"], "2026-10-05T09:15:00+11:00");
        assert_eq!(events[3]["title"], "(No title)");
        assert!(events[3]["location"].is_null());
    }

    #[test]
    fn gcal_events_of_an_empty_body_is_empty() {
        assert!(gcal_events(&json!({})).is_empty());
    }

    #[test]
    fn end_of_day_uses_the_local_offset() {
        assert_eq!(end_of_day_rfc3339(2026, 10, 5, 11 * 3600), "2026-10-05T23:59:59+11:00");
        assert_eq!(end_of_day_rfc3339(2026, 7, 5, 10 * 3600), "2026-07-05T23:59:59+10:00");
        assert_eq!(end_of_day_rfc3339(2026, 1, 9, 0), "2026-01-09T23:59:59+00:00");
        assert_eq!(fmt_offset(-(3 * 3600 + 1800)), "-03:30");
        assert_eq!(fmt_offset(5 * 3600 + 2700), "+05:45");
    }

    #[test]
    fn local_offset_is_found_from_wall_clock_and_utc() {
        // 2026-10-05 12:00:00 UTC is 23:00:00 in Sydney (+11:00).
        let utc = days_from_civil(2026, 10, 5) * 86400 + 12 * 3600;
        let local = platform::LocalTime { year: 2026, month: 10, day: 5, hour: 23, minute: 0, second: 1 };
        assert_eq!(local_offset_secs(utc, &local), 11 * 3600);
        // Across midnight: 20:00 UTC on the 5th is 07:00 on the 6th at +11.
        let utc = days_from_civil(2026, 10, 5) * 86400 + 20 * 3600;
        let local = platform::LocalTime { year: 2026, month: 10, day: 6, hour: 7, minute: 0, second: 0 };
        assert_eq!(local_offset_secs(utc, &local), 11 * 3600);
        // Behind UTC.
        let local = platform::LocalTime { year: 2026, month: 10, day: 5, hour: 15, minute: 0, second: 0 };
        assert_eq!(local_offset_secs(utc, &local), -5 * 3600);
    }

    #[test]
    fn rfc3339_utc_formats_and_round_trips_dates() {
        assert_eq!(rfc3339_utc(0), "1970-01-01T00:00:00Z");
        let secs = days_from_civil(2026, 10, 5) * 86400 + 3 * 3600 + 4 * 60 + 5;
        assert_eq!(rfc3339_utc(secs), "2026-10-05T03:04:05Z");
        assert_eq!(rfc3339_utc(days_from_civil(2024, 2, 29) * 86400), "2024-02-29T00:00:00Z");
    }

    #[test]
    fn spotify_data_for_a_track() {
        let body = json!({
            "is_playing": true, "progress_ms": 1200,
            "item": {
                "name": "Song", "duration_ms": 200000,
                "artists": [{"name": "A"}, {"name": "B"}],
                "album": {"name": "Album", "images": [{"url": "big"}, {"url": "small"}]},
                "external_urls": {"spotify": "https://open.spotify.com/track/1"}
            }
        });
        let d = spotify_data(&body);
        assert_eq!(d["playing"], true);
        assert_eq!(d["title"], "Song");
        assert_eq!(d["artist"], "A, B");
        assert_eq!(d["artUrl"], "small");
        assert_eq!(d["durationMs"], 200000);
        assert_eq!(d["trackUrl"], "https://open.spotify.com/track/1");
    }

    #[test]
    fn spotify_data_for_nothing_playing() {
        assert_eq!(spotify_data(&json!({})), json!({ "playing": false }));
        assert_eq!(spotify_data(&json!({ "is_playing": true, "item": null })), json!({ "playing": false }));
    }
}
