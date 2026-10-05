// Subagent model lookup: reads the `model:` line from the frontmatter of an
// agent definition (`<cwd>/.claude/agents/<type>.md`, then
// `~/.claude/agents/<type>.md`). Read-only, frontmatter only, type validated.

use std::io::{BufRead, BufReader};
use std::path::Path;

use crate::platform;

/// Frontmatter is tiny; never read more than this many lines looking for it.
const MAX_LINES: usize = 60;

/// Agent types are file names: letters, digits, `_` and `-`, at most 64. Anything
/// else (dots, slashes, colons of plugin types) is rejected, so no path traversal.
pub fn valid_agent_type(t: &str) -> bool {
    !t.is_empty()
        && t.len() <= 64
        && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The `model:` value of a markdown frontmatter block, from an iterator of lines.
fn frontmatter_model<I: Iterator<Item = String>>(lines: I) -> Option<String> {
    let mut lines = lines.take(MAX_LINES);
    if lines.next()?.trim_end() != "---" {
        return None;
    }
    for line in lines {
        let line = line.trim_end();
        if line == "---" {
            return None;
        }
        if let Some(rest) = line.strip_prefix("model:") {
            let v = rest.trim().trim_matches(|c| c == '"' || c == '\'').trim();
            return if v.is_empty() { None } else { Some(v.to_string()) };
        }
    }
    None
}

fn model_in(dir: &Path, agent_type: &str) -> Option<String> {
    let file = std::fs::File::open(dir.join("agents").join(format!("{agent_type}.md"))).ok()?;
    let lines = BufReader::new(file).lines().map_while(Result::ok);
    // A BOM would hide the opening `---`.
    frontmatter_model(lines.map(|l| l.trim_start_matches('\u{feff}').to_string()))
}

/// Model declared by the agent definition, project first, then user level.
pub fn lookup_model(cwd: Option<&str>, agent_type: &str) -> Option<String> {
    if !valid_agent_type(agent_type) {
        return None;
    }
    if let Some(cwd) = cwd.filter(|c| !c.is_empty()) {
        if let Some(m) = model_in(&Path::new(cwd).join(".claude"), agent_type) {
            return Some(m);
        }
    }
    model_in(&platform::home_dir().join(".claude"), agent_type)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(s: &str) -> impl Iterator<Item = String> + '_ {
        s.lines().map(String::from)
    }

    fn temp_project(name: &str, file: &str, body: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("coucou-agents-{name}-{}", std::process::id()));
        let dir = root.join(".claude").join("agents");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(file), body).unwrap();
        root
    }

    #[test]
    fn model_found() {
        let src = "---\nname: x\nmodel: sonnet\ntools: Read\n---\nbody\nmodel: opus";
        assert_eq!(frontmatter_model(lines(src)).as_deref(), Some("sonnet"));
        let root = temp_project("found", "reviewer.md", "---\nname: reviewer\nmodel: \"haiku\"\n---\n");
        assert_eq!(lookup_model(root.to_str(), "reviewer").as_deref(), Some("haiku"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn model_inherit_is_returned_verbatim() {
        let root = temp_project("inherit", "helper.md", "---\nmodel: inherit\n---\n");
        assert_eq!(lookup_model(root.to_str(), "helper").as_deref(), Some("inherit"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn model_missing() {
        assert_eq!(frontmatter_model(lines("---\nname: x\n---\nmodel: opus")), None);
        assert_eq!(frontmatter_model(lines("no frontmatter\nmodel: opus")), None);
        let root = temp_project("missing", "other.md", "---\nname: other\n---\n");
        assert_eq!(lookup_model(root.to_str(), "nonexistent-agent-zz9"), None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn bad_type_rejected() {
        for bad in ["", "../secret", "a/b", r"a\b", "plugin:agent", "a.b", &"x".repeat(65)] {
            assert!(!valid_agent_type(bad), "{bad}");
            assert_eq!(lookup_model(Some("."), bad), None);
        }
        assert!(valid_agent_type("code-reviewer_2"));
    }
}
