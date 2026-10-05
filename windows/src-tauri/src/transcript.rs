// Reads Claude Code session transcripts (`~/.claude/projects/**/*.jsonl`) for
// the session title shown on the stage. Only paths under that folder are read.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde_json::Value;

use crate::platform;

const TAIL_BYTES: u64 = 64 * 1024;

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
