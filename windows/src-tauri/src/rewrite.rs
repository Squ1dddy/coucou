// Friendly activity text: a local Ollama rewrites Claude's plain activity line
// into one short, warm line for the Claude panel's headline. The plain text is
// always the fallback, so every failure here is silent (None).
//
// The endpoint is a hard-coded loopback address. It is never configurable, so
// nothing typed in a settings file can send activity text anywhere else.

use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, VecDeque};
use std::hash::{Hash, Hasher};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::State;

use crate::{log, platform, Shared};

const OLLAMA_URL: &str = "http://127.0.0.1:11434/api/generate";
const MODEL: &str = "gemma3:4b";
const REWRITE_TIMEOUT: Duration = Duration::from_secs(4);
const WARM_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_LINE: usize = 60;
const SAID_MAX: usize = 300;
const CACHE_MAX: usize = 200;
const TAIL_BYTES: u64 = 64 * 1024;

const SYSTEM_PROMPT: &str = "You write the status line for Mochi, a small friendly character who watches an AI coding agent work.
Rewrite the facts into ONE short line, max 55 characters.
Rules: present tense, describe only what the facts say, never invent files or work. Light, warm personality: a gentle verb or small flourish is fine, jokes are not. No emoji, no quotes, no exclamation marks, no \"I\". Name the file or thing if given. Keep the same action as the facts: reading stays reading, thinking stays thinking.
Examples:
Facts: Editing state.ts | Claude said: Now I'll fix the expiry check.
Line: Tightening the session expiry check in state.ts
Facts: Running cargo test | Claude said: Let me run the tests to confirm.
Line: Putting the Rust tests through their paces
Facts: Reading layout.ts | Claude said: Let me look at how the panel is sized.
Line: Studying how the panel gets its size";

// ── Pure helpers ──────────────────────────────────────────────────────────────

/// The last `max` characters of `text`, trimmed (never splits a character).
fn tail_chars(text: &str, max: usize) -> String {
    let text = text.trim();
    let count = text.chars().count();
    if count <= max {
        return text.to_string();
    }
    text.chars().skip(count - max).collect::<String>().trim().to_string()
}

pub fn build_prompt(facts: &str, said: Option<&str>) -> String {
    let said = said.map(|s| tail_chars(s, SAID_MAX)).filter(|s| !s.is_empty());
    format!(
        "Facts: {} | Claude said: {}\nLine:",
        facts.trim(),
        said.as_deref().unwrap_or("(nothing)")
    )
}

fn is_emoji(c: char) -> bool {
    matches!(c as u32,
        0x1F000..=0x1FAFF | 0x2600..=0x27BF | 0x2B00..=0x2BFF | 0x2300..=0x23FF
        | 0xFE0F | 0x200D)
}

fn strip_wrapping_quotes(s: &str) -> &str {
    let s = s.trim();
    for q in ['"', '\'', '`'] {
        if s.len() >= 2 && s.starts_with(q) && s.ends_with(q) {
            return s[1..s.len() - 1].trim();
        }
    }
    s
}

/// Cleans the model's reply into a headline, or None when it is not usable.
/// Never truncates: a line that is too long is rejected.
pub fn filter_line(raw: &str) -> Option<String> {
    let first = raw.lines().map(str::trim).find(|l| !l.is_empty())?;
    let straight: String = first
        .chars()
        .map(|c| match c {
            '\u{201C}' | '\u{201D}' | '\u{201E}' => '"',
            '\u{2018}' | '\u{2019}' | '\u{201A}' => '\'',
            c => c,
        })
        .collect();
    let mut s = strip_wrapping_quotes(&straight);
    s = s.strip_suffix('.').unwrap_or(s).trim();
    s = strip_wrapping_quotes(s);
    if s.is_empty() || s.chars().count() > MAX_LINE || s.chars().any(is_emoji) || s.starts_with("I ") {
        return None;
    }
    Some(s.to_string())
}

/// Last text block of the last assistant message in a JSONL tail, last ~300 chars.
pub fn last_assistant_text_in(jsonl: &str) -> Option<String> {
    for line in jsonl.lines().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else { continue };
        if v.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let content = v.get("message").and_then(|m| m.get("content"));
        let text = match content {
            Some(Value::String(s)) => Some(s.clone()),
            Some(Value::Array(blocks)) => blocks.iter().rev().find_map(|b| {
                if b.get("type").and_then(Value::as_str) == Some("text") {
                    b.get("text").and_then(Value::as_str).map(str::to_string)
                } else {
                    None
                }
            }),
            _ => None,
        };
        if let Some(t) = text.map(|t| tail_chars(&t, SAID_MAX)).filter(|t| !t.is_empty()) {
            return Some(t);
        }
    }
    None
}

/// Session title from a transcript: the last `custom-title` entry (the name the
/// desktop app shows in its sidebar, or a `/rename`), capped at 80 chars.
pub fn session_title_in(jsonl: &str) -> Option<String> {
    jsonl.lines().rev().find_map(|line| {
        if !line.contains("\"custom-title\"") {
            return None;
        }
        let v = serde_json::from_str::<Value>(line.trim()).ok()?;
        if v.get("type").and_then(Value::as_str) != Some("custom-title") {
            return None;
        }
        let t = v.get("customTitle").and_then(Value::as_str)?.trim();
        (!t.is_empty()).then(|| t.chars().take(80).collect())
    })
}

/// Only `<base>/**/*.jsonl` that exists, after resolving `..` and links.
pub fn path_allowed(path: &Path, base: &Path) -> bool {
    if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        return false;
    }
    let (Ok(p), Ok(b)) = (path.canonicalize(), base.canonicalize()) else { return false };
    p.starts_with(b) && p.is_file()
}

fn read_tail(path: &Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.take(TAIL_BYTES).read_to_end(&mut bytes).ok()?;
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if start > 0 {
        // The cut usually lands mid-line: drop the partial first line.
        text = text.split_once('\n').map(|(_, rest)| rest.to_string()).unwrap_or_default();
    }
    Some(text)
}

// ── Cache ─────────────────────────────────────────────────────────────────────

struct Cache {
    map: HashMap<u64, String>,
    order: VecDeque<u64>,
}

static CACHE: Mutex<Option<Cache>> = Mutex::new(None);

fn key_of(facts: &str, said: Option<&str>) -> u64 {
    let mut h = DefaultHasher::new();
    facts.hash(&mut h);
    said.hash(&mut h);
    h.finish()
}

fn cache_get(key: u64) -> Option<String> {
    CACHE.lock().ok()?.as_ref()?.map.get(&key).cloned()
}

fn cache_put(key: u64, line: String) {
    let Ok(mut guard) = CACHE.lock() else { return };
    let cache = guard.get_or_insert_with(|| Cache { map: HashMap::new(), order: VecDeque::new() });
    if cache.map.insert(key, line).is_none() {
        cache.order.push_back(key);
        while cache.order.len() > CACHE_MAX {
            if let Some(old) = cache.order.pop_front() {
                cache.map.remove(&old);
            }
        }
    }
}

// ── Ollama ────────────────────────────────────────────────────────────────────

static UNREACHABLE_LOGGED: AtomicBool = AtomicBool::new(false);

fn note_unreachable() {
    if !UNREACHABLE_LOGGED.swap(true, Ordering::Relaxed) {
        log::line("Friendly activity: Ollama is not reachable on 127.0.0.1:11434 (plain text is used)");
    }
}

async fn generate(body: Value, timeout: Duration) -> Option<String> {
    let client = reqwest::Client::builder().timeout(timeout).build().ok()?;
    let response = match client.post(OLLAMA_URL).json(&body).send().await {
        Ok(r) => r,
        Err(e) => {
            if e.is_connect() {
                note_unreachable();
            }
            return None;
        }
    };
    if !response.status().is_success() {
        return None;
    }
    let v: Value = response.json().await.ok()?;
    v.get("response").and_then(Value::as_str).map(str::to_string)
}

/// The whole rewrite, with the setting passed in so "off" is testable.
pub async fn rewrite(enabled: bool, facts: &str, said: Option<&str>) -> Option<String> {
    if !enabled || facts.trim().is_empty() {
        return None;
    }
    let key = key_of(facts, said);
    if let Some(hit) = cache_get(key) {
        return Some(hit);
    }
    let body = json!({
        "model": MODEL,
        "system": SYSTEM_PROMPT,
        "prompt": build_prompt(facts, said),
        "stream": false,
        "keep_alive": "10m",
        "options": { "temperature": 0.6, "num_predict": 30 },
    });
    let line = filter_line(&generate(body, REWRITE_TIMEOUT).await?)?;
    cache_put(key, line.clone());
    Some(line)
}

/// Loads the model into memory (a cold load takes ~47 s) so the first rewrite is quick.
pub async fn warm(enabled: bool) {
    if !enabled {
        return;
    }
    let body = json!({ "model": MODEL, "prompt": "", "stream": false, "keep_alive": "10m" });
    let _ = generate(body, WARM_TIMEOUT).await;
}

fn enabled(shared: &Shared) -> bool {
    shared.settings.lock().map(|s| s.friendly_activity).unwrap_or(false)
}

#[tauri::command]
pub async fn rewrite_activity(
    shared: State<'_, Shared>,
    facts: String,
    said: Option<String>,
) -> Result<Option<String>, ()> {
    Ok(rewrite(enabled(&shared), &facts, said.as_deref()).await)
}

#[tauri::command]
pub fn ollama_warm(shared: State<'_, Shared>) {
    let on = enabled(&shared);
    if on {
        tauri::async_runtime::spawn(warm(on));
    }
}

/// What Claude last said in this session, read from the end of its transcript.
#[tauri::command]
pub fn last_assistant_text(path: String) -> Option<String> {
    let base = platform::home_dir().join(".claude").join("projects");
    let path = Path::new(&path);
    if !path_allowed(path, &base) {
        return None;
    }
    last_assistant_text_in(&read_tail(path)?)
}

/// Largest transcript read whole when the tail holds no title.
const TITLE_FULL_MAX: u64 = 16 * 1024 * 1024;

/// The session's title (see `session_title_in`). Checks the tail first; titles
/// are rewritten often so it is nearly always there.
#[tauri::command]
pub fn session_title(path: String) -> Option<String> {
    let base = platform::home_dir().join(".claude").join("projects");
    let path = Path::new(&path);
    if !path_allowed(path, &base) {
        return None;
    }
    if let Some(t) = session_title_in(&read_tail(path)?) {
        return Some(t);
    }
    if std::fs::metadata(path).ok()?.len() > TITLE_FULL_MAX {
        return None;
    }
    session_title_in(&std::fs::read_to_string(path).ok()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filter_keeps_a_clean_line() {
        assert_eq!(filter_line("Reading layout.ts").as_deref(), Some("Reading layout.ts"));
    }

    #[test]
    fn filter_first_line_quotes_and_period() {
        assert_eq!(filter_line("\n  \"Fixing the bug.\"  \nsecond").as_deref(), Some("Fixing the bug"));
        assert_eq!(filter_line("\u{201C}Fixing it\u{201D}.").as_deref(), Some("Fixing it"));
    }

    #[test]
    fn filter_straightens_apostrophes() {
        assert_eq!(filter_line("Checking Claude\u{2019}s plan").as_deref(), Some("Checking Claude's plan"));
    }

    #[test]
    fn filter_rejects_long_empty_emoji_and_first_person() {
        assert_eq!(filter_line(&"a".repeat(61)), None);
        assert!(filter_line(&"a".repeat(60)).is_some());
        assert_eq!(filter_line("  \n "), None);
        assert_eq!(filter_line("Running tests \u{1F680}"), None);
        assert_eq!(filter_line("I am reading the file"), None);
    }

    #[test]
    fn prompt_has_facts_and_said() {
        assert_eq!(
            build_prompt("Editing a.ts", Some("Now fixing.")),
            "Facts: Editing a.ts | Claude said: Now fixing.\nLine:"
        );
        assert_eq!(build_prompt("Thinking", None), "Facts: Thinking | Claude said: (nothing)\nLine:");
        let long = "x".repeat(1000);
        assert!(build_prompt("f", Some(&long)).len() < 400);
    }

    #[test]
    fn transcript_tail_picks_last_assistant_text() {
        let fixture = [
            r#"{"type":"user","message":{"role":"user","content":"hi"}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Old words."}]}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"First."},{"type":"text","text":"Fixing the expiry check now."},{"type":"tool_use","name":"Edit"}]}}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result"}]}}"#,
            "not json at all",
        ]
        .join("\n");
        assert_eq!(last_assistant_text_in(&fixture).as_deref(), Some("Fixing the expiry check now."));
        assert_eq!(last_assistant_text_in("garbage"), None);
        let long = format!(
            r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"{}"}}]}}}}"#,
            "y".repeat(500)
        );
        assert_eq!(last_assistant_text_in(&long).unwrap().chars().count(), 300);
    }

    #[test]
    fn path_guard() {
        let root = std::env::temp_dir().join(format!("coucou-rw-{}", std::process::id()));
        let base = root.join("projects");
        std::fs::create_dir_all(base.join("p")).unwrap();
        let ok = base.join("p").join("s.jsonl");
        let wrong_ext = base.join("p").join("s.txt");
        let outside = root.join("outside.jsonl");
        for f in [&ok, &wrong_ext, &outside] {
            std::fs::write(f, "{}").unwrap();
        }
        assert!(path_allowed(&ok, &base));
        assert!(!path_allowed(&wrong_ext, &base));
        assert!(!path_allowed(&outside, &base));
        assert!(!path_allowed(&base.join("p").join("..").join("..").join("outside.jsonl"), &base));
        assert!(!path_allowed(&base.join("missing.jsonl"), &base));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn cache_is_bounded() {
        for i in 0..(CACHE_MAX as u64 + 50) {
            cache_put(1_000_000 + i, "x".into());
        }
        let guard = CACHE.lock().unwrap();
        assert!(guard.as_ref().unwrap().map.len() <= CACHE_MAX);
    }

    #[test]
    fn off_makes_no_request() {
        // With the setting off we return before any HTTP client is even built.
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        assert_eq!(rt.block_on(rewrite(false, "Editing a.ts", Some("x"))), None);
        rt.block_on(warm(false));
    }

    #[test]
    fn endpoint_is_loopback() {
        assert!(OLLAMA_URL.starts_with("http://127.0.0.1:"));
    }

    #[test]
    #[ignore]
    fn rewrite_against_real_ollama() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let line = rt.block_on(async {
            warm(true).await;
            rewrite(true, "Editing state.ts", Some("Now I'll fix the expiry check.")).await
        });
        println!("rewrite -> {line:?}");
        assert!(line.is_some());
    }

    #[test]
    fn title_is_the_last_custom_title() {
        let jsonl = concat!(
            "{\"type\":\"custom-title\",\"customTitle\":\"Old name\",\"sessionId\":\"x\"}
",
            "{\"type\":\"user\",\"message\":{\"content\":\"the \\\"custom-title\\\" word\"}}
",
            "{\"type\":\"custom-title\",\"customTitle\":\"  start T3 \",\"sessionId\":\"x\"}
",
            "{\"type\":\"assistant\",\"message\":{\"content\":[]}}
",
        );
        assert_eq!(session_title_in(jsonl).as_deref(), Some("start T3"));
    }

    #[test]
    fn title_missing_or_blank_is_none() {
        assert_eq!(session_title_in("{\"type\":\"user\"}
"), None);
        assert_eq!(session_title_in("{\"type\":\"custom-title\",\"customTitle\":\"  \"}
"), None);
        assert_eq!(session_title_in("not json \"custom-title\"
"), None);
    }

    #[test]
    fn title_rejects_paths_outside_projects() {
        assert_eq!(session_title("C:/Windows/win.ini".into()), None);
    }
}
