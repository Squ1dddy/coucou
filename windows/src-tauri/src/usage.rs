// Claude plan limits (5 h and weekly) for the Claude panel.
//
// Primary source: Claude Code's own `get_usage` control request. It is a local
// protocol message, not a prompt, so it spends no tokens. We start `claude` in
// stream-json mode with every hook disabled (otherwise Coucou's own hook would
// see a phantom session), send `initialize` then `get_usage`, read the answer
// and kill the child. No user message is ever sent.
//
// Fallback: the claude-hud snapshot at %LOCALAPPDATA%\Coucou\claude-usage.json.
//
// Nothing here is logged beyond "usage ok" / "usage failed".

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::island::WINDOW_LABEL;
use crate::{integrations, log, platform, settings};

const TIMEOUT: Duration = Duration::from_secs(20);
const MIN_GAP: Duration = Duration::from_secs(30);
/// A snapshot older than this is shown as "updated N min ago".
#[allow(dead_code)]
pub const STALE_MS: i64 = 5 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Limit {
    /// 0-100.
    pub pct: f64,
    pub resets_at_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Usage {
    pub five_hour: Option<Limit>,
    pub seven_day: Option<Limit>,
    pub updated_ms: i64,
    pub source: &'static str,
}

#[allow(dead_code)]
impl Usage {
    pub fn is_stale(&self, now_ms: i64) -> bool {
        now_ms - self.updated_ms > STALE_MS
    }
}

// ── Time ──────────────────────────────────────────────────────────────────────

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// "2026-10-05T14:50:00.123Z" or "...+10:00" -> epoch milliseconds.
fn parse_iso_ms(s: &str) -> Option<i64> {
    let s = s.trim();
    let (date, rest) = s.split_once(['T', ' '])?;
    let mut dp = date.split('-');
    let y: i64 = dp.next()?.parse().ok()?;
    let mo: i64 = dp.next()?.parse().ok()?;
    let d: i64 = dp.next()?.parse().ok()?;
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    // Split the clock from the zone designator.
    let zone_at = rest.find(['Z', 'z', '+', '-']);
    let (clock, zone) = match zone_at {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    let mut cp = clock.split(':');
    let hh: i64 = cp.next()?.parse().ok()?;
    let mm: i64 = cp.next().unwrap_or("0").parse().ok()?;
    let sec_str = cp.next().unwrap_or("0");
    let (whole, frac) = sec_str.split_once('.').unwrap_or((sec_str, ""));
    let ss: i64 = whole.parse().ok()?;
    let millis: i64 = if frac.is_empty() {
        0
    } else {
        let digits: String = frac.chars().take(3).collect();
        let pad = 3 - digits.len();
        digits.parse::<i64>().ok()? * 10_i64.pow(pad as u32)
    };
    let offset_min: i64 = match zone.chars().next() {
        None | Some('Z') | Some('z') => 0,
        Some(sign) => {
            let body = &zone[1..];
            let (oh, om) = body.split_once(':').unwrap_or((body, "0"));
            let (oh, om): (i64, i64) = if !body.contains(':') && body.len() == 4 {
                (body[..2].parse().ok()?, body[2..].parse().ok()?)
            } else {
                (oh.parse().ok()?, om.parse().ok()?)
            };
            let total = oh * 60 + om;
            if sign == '-' { -total } else { total }
        }
    };
    let secs = days_from_civil(y, mo, d) * 86_400 + hh * 3600 + mm * 60 + ss - offset_min * 60;
    Some(secs * 1000 + millis)
}

/// A timestamp as ISO text, epoch seconds or epoch milliseconds.
fn time_value_ms(v: &Value) -> Option<i64> {
    match v {
        Value::String(s) => match s.trim().parse::<f64>() {
            Ok(n) => Some(epoch_to_ms(n)),
            Err(_) => parse_iso_ms(s),
        },
        Value::Number(n) => n.as_f64().map(epoch_to_ms),
        _ => None,
    }
}

fn epoch_to_ms(n: f64) -> i64 {
    // Seconds are ~1.7e9, milliseconds ~1.7e12.
    if n < 1e11 { (n * 1000.0) as i64 } else { n as i64 }
}

fn number(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().trim_end_matches('%').parse().ok(),
        _ => None,
    }
}

// ── Parsers ───────────────────────────────────────────────────────────────────

fn limit_from(v: &Value) -> Option<Limit> {
    let obj = v.as_object()?;
    let pct = ["utilization", "used_percentage", "used_percent", "percent"]
        .iter()
        .find_map(|k| obj.get(*k).and_then(number))?;
    let resets_at_ms = obj.get("resets_at").and_then(time_value_ms);
    Some(Limit { pct: pct.clamp(0.0, 100.0), resets_at_ms })
}

/// The `control_response` for `get_usage`:
/// `.response.response.rate_limits.{five_hour,seven_day}`.
/// Returns None for any other line.
pub fn parse_usage_response(line: &str, now: i64) -> Option<Usage> {
    let v: Value = serde_json::from_str(line).ok()?;
    if v.get("type")?.as_str()? != "control_response" {
        return None;
    }
    let resp = v.get("response")?;
    if resp.get("request_id")?.as_str()? != "u2" {
        return None;
    }
    let limits = resp.get("response")?.get("rate_limits")?;
    let five_hour = limits.get("five_hour").and_then(limit_from);
    let seven_day = limits.get("seven_day").and_then(limit_from);
    if five_hour.is_none() && seven_day.is_none() {
        return None;
    }
    Some(Usage { five_hour, seven_day, updated_ms: now, source: "claude" })
}

/// The claude-hud snapshot. Tolerant about names and time formats; `mtime_ms`
/// stands in for `updated_at` when the file does not carry one.
pub fn parse_hud(text: &str, mtime_ms: i64) -> Option<Usage> {
    let v: Value = serde_json::from_str(text).ok()?;
    let root = v.get("rate_limits").filter(|r| r.is_object()).unwrap_or(&v);
    let five_hour = root.get("five_hour").and_then(limit_from);
    let seven_day = root.get("seven_day").and_then(limit_from);
    if five_hour.is_none() && seven_day.is_none() {
        return None;
    }
    let updated_ms = v
        .get("updated_at")
        .or_else(|| root.get("updated_at"))
        .and_then(time_value_ms)
        .unwrap_or(mtime_ms);
    Some(Usage { five_hour, seven_day, updated_ms, source: "hud" })
}

// ── Fetching ──────────────────────────────────────────────────────────────────

fn claude_exe() -> std::path::PathBuf {
    #[cfg(windows)]
    let local = platform::home_dir().join(".local").join("bin").join("claude.exe");
    #[cfg(not(windows))]
    let local = platform::home_dir().join(".local").join("bin").join("claude");
    if local.is_file() { local } else { "claude".into() }
}

/// Asks Claude Code for the limits over its control protocol. Blocking.
fn fetch_from_claude() -> Option<Usage> {
    let mut cmd = Command::new(claude_exe());
    cmd.args([
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--settings",
        r#"{"disableAllHooks":true}"#,
    ])
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::null());
    platform::no_console(&mut cmd);
    let mut child = cmd.spawn().ok()?;

    let mut stdin = child.stdin.take()?;
    let stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
    });

    let sent = stdin
        .write_all(
            concat!(
                r#"{"type":"control_request","request_id":"u1","request":{"subtype":"initialize"}}"#,
                "\n",
                r#"{"type":"control_request","request_id":"u2","request":{"subtype":"get_usage"}}"#,
                "\n"
            )
            .as_bytes(),
        )
        .and_then(|_| stdin.flush())
        .is_ok();

    let deadline = Instant::now() + TIMEOUT;
    let mut result = None;
    while sent {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        match rx.recv_timeout(left) {
            Ok(line) => {
                if let Some(u) = parse_usage_response(&line, now_ms()) {
                    result = Some(u);
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    result
}

fn fetch_from_hud() -> Option<Usage> {
    let path = settings::local_dir().join("claude-usage.json");
    let text = std::fs::read_to_string(&path).ok()?;
    let mtime = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    parse_hud(&text, mtime)
}

static RUNNING: AtomicBool = AtomicBool::new(false);
static LAST_DONE: Mutex<Option<Instant>> = Mutex::new(None);

/// Fetches in the background and emits `claude-usage`. Skipped when Coucou is
/// paused, a fetch is already running or one finished less than 30 s ago.
pub fn refresh(app: &AppHandle) {
    if integrations::PAUSED.load(Ordering::Relaxed) {
        return;
    }
    if LAST_DONE.lock().unwrap().is_some_and(|t| t.elapsed() < MIN_GAP) {
        return;
    }
    if RUNNING.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let usage = fetch_from_claude().or_else(fetch_from_hud);
        *LAST_DONE.lock().unwrap() = Some(Instant::now());
        RUNNING.store(false, Ordering::Release);
        match usage {
            Some(u) => {
                log::line("usage ok");
                let _ = app.emit_to(WINDOW_LABEL, "claude-usage", u);
            }
            None => log::line("usage failed"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_790_000_000_000;

    #[test]
    fn iso_parses_utc_offset_and_fraction() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso_ms("2026-10-05T12:50:00.500Z"), Some(1_791_204_600_500));
        assert_eq!(parse_iso_ms("2026-10-05T22:50:00+10:00"), Some(1_791_204_600_000));
        assert_eq!(parse_iso_ms("2026-10-05T12:50:00.123456+00:00"), Some(1_791_204_600_123));
        assert_eq!(parse_iso_ms("nonsense"), None);
    }

    #[test]
    fn get_usage_response_parses() {
        let line = r#"{"type":"control_response","response":{"subtype":"success","request_id":"u2","response":{"rate_limits":{"five_hour":{"utilization":42.5,"resets_at":"2026-10-05T12:50:00Z"},"seven_day":{"utilization":71,"resets_at":"2026-10-09T00:00:00Z"}}}}}"#;
        let u = parse_usage_response(line, NOW).unwrap();
        assert_eq!(u.source, "claude");
        assert_eq!(u.updated_ms, NOW);
        let f = u.five_hour.unwrap();
        assert_eq!(f.pct, 42.5);
        assert_eq!(f.resets_at_ms, Some(1_791_204_600_000));
        assert_eq!(u.seven_day.unwrap().pct, 71.0);
    }

    #[test]
    fn other_lines_are_ignored() {
        let init = r#"{"type":"control_response","response":{"subtype":"success","request_id":"u1","response":{}}}"#;
        assert!(parse_usage_response(init, NOW).is_none());
        assert!(parse_usage_response(r#"{"type":"system","subtype":"init"}"#, NOW).is_none());
        assert!(parse_usage_response("not json", NOW).is_none());
        let empty = r#"{"type":"control_response","response":{"request_id":"u2","response":{"rate_limits":{}}}}"#;
        assert!(parse_usage_response(empty, NOW).is_none());
    }

    #[test]
    fn hud_accepts_iso_and_epoch_seconds() {
        let iso = r#"{"updated_at":"2026-10-05T12:00:00Z","five_hour":{"used_percentage":10,"resets_at":"2026-10-05T12:50:00Z"},"seven_day":{"utilization":"20","resets_at":"2026-10-09T00:00:00Z"}}"#;
        let u = parse_hud(iso, 5).unwrap();
        assert_eq!(u.source, "hud");
        assert_eq!(u.updated_ms, 1_791_201_600_000);
        assert_eq!(u.five_hour.as_ref().unwrap().pct, 10.0);
        assert_eq!(u.five_hour.unwrap().resets_at_ms, Some(1_791_204_600_000));
        assert_eq!(u.seven_day.unwrap().pct, 20.0);

        let epoch = r#"{"updated_at":1791201600,"rate_limits":{"five_hour":{"used_percentage":55.5,"resets_at":1791204600}}}"#;
        let u = parse_hud(epoch, 5).unwrap();
        assert_eq!(u.updated_ms, 1_791_201_600_000);
        assert_eq!(u.five_hour.unwrap().resets_at_ms, Some(1_791_204_600_000));
        assert!(u.seven_day.is_none());
    }

    #[test]
    fn hud_staleness_and_mtime_fallback() {
        let text = r#"{"updated_at":"2026-10-05T12:00:00Z","five_hour":{"used_percentage":10}}"#;
        let u = parse_hud(text, 0).unwrap();
        assert!(!u.is_stale(u.updated_ms + 4 * 60_000));
        assert!(u.is_stale(u.updated_ms + 6 * 60_000));
        let no_stamp = parse_hud(r#"{"five_hour":{"used_percentage":1}}"#, 777).unwrap();
        assert_eq!(no_stamp.updated_ms, 777);
        assert!(parse_hud("{}", 0).is_none());
        assert!(parse_hud("garbage", 0).is_none());
    }
}
