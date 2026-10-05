/**
 * describeActivity() — plain-English "what is Claude doing" text for the island.
 * Pure and deterministic. Never includes raw commands, absolute paths or tool
 * input JSON. (The approval card is different on purpose: it shows the full
 * command/path, see approvalTarget in island/hooks.ts.)
 */

const MAX_LEN = 60;

type Input = Record<string, unknown>;

function str(input: Input, key: string): string {
  const v = input[key];
  return typeof v === "string" ? v.trim() : "";
}

function finish(text: string): string {
  let t = text.replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
  if (!t) return "Working…";
  t = t.charAt(0).toUpperCase() + t.slice(1);
  if (t.length > MAX_LEN) t = t.slice(0, MAX_LEN - 1).trimEnd() + "…";
  return t;
}

/** File name without directories (handles both separators). */
function friendlyName(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const UUID_LIKE = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}/i;

function connectorName(tool: string): string {
  const server = tool.split("__")[1] ?? "";
  if (!server || UUID_LIKE.test(server)) return "a connector";
  const tidy = server
    .replace(/^claude[_-]ai[_-]/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
  return tidy || "a connector";
}

const REGEX_SYMBOLS = /[\\^$.*+?()[\]{}|]/;

function todoText(input: Input): string {
  const todos = input.todos;
  if (Array.isArray(todos)) {
    for (const t of todos) {
      if (t && typeof t === "object" && (t as Input).status === "in_progress") {
        const o = t as Input;
        const text = str(o, "activeForm") || str(o, "content");
        if (text) return text;
      }
    }
  }
  return "Planning next steps";
}

export function describeActivity(tool: string, input: Input): string {
  const inp: Input = input && typeof input === "object" ? input : {};
  switch (tool) {
    case "Bash":
    case "PowerShell":
      return finish(str(inp, "description") || "Running a command");
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": {
      const name = friendlyName(str(inp, "file_path") || str(inp, "notebook_path"));
      return finish(name ? `Editing ${name}` : "Editing a file");
    }
    case "Write": {
      const name = friendlyName(str(inp, "file_path"));
      return finish(name ? `Writing ${name}` : "Writing a file");
    }
    case "Read": {
      const name = friendlyName(str(inp, "file_path") || str(inp, "path"));
      return finish(name ? `Reading ${name}` : "Reading a file");
    }
    case "Grep": {
      const p = str(inp, "pattern");
      if (p && p.length <= 24 && !REGEX_SYMBOLS.test(p)) {
        return finish(`Searching the code for "${p}"`);
      }
      return finish("Searching the code");
    }
    case "Glob":
    case "LS":
      return finish("Looking through files");
    case "WebSearch": {
      const q = str(inp, "query");
      return finish(q ? `Searching the web for ${q}` : "Searching the web");
    }
    case "WebFetch": {
      const host = hostOf(str(inp, "url"));
      return finish(host ? `Reading ${host}` : "Reading a web page");
    }
    case "Task":
    case "Agent": {
      const d = str(inp, "description");
      return finish(d ? `Asking a helper: ${d}` : "Asking a helper");
    }
    case "TodoWrite":
      return finish(todoText(inp));
    case "AskUserQuestion":
      return finish("Asking you a question");
    case "Skill": {
      const name = str(inp, "skill") || str(inp, "name");
      return finish(name ? `Using the ${name} skill` : "Using a skill");
    }
  }
  if (tool.startsWith("mcp__")) return finish(`Using ${connectorName(tool)}`);
  return "Working…";
}
