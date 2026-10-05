import { describeActivity as d } from "../src/core/activity";

const cases: [string, Record<string, unknown>, string][] = [
  ["Bash", { command: "npm test", description: "Run the tests." }, "Run the tests"],
  ["Bash", { command: "rm -rf C:\\secret" }, "Running a command"],
  ["PowerShell", { command: "ls" }, "Running a command"],
  ["Edit", { file_path: "C:\\Users\\beaub\\src\\island\\hooks.ts" }, "Editing hooks.ts"],
  ["Write", { file_path: "/home/x/new.md" }, "Writing new.md"],
  ["Read", { file_path: "C:\\a\\b\\state.ts" }, "Reading state.ts"],
  ["Grep", { pattern: "stepLabel" }, 'Searching the code for "stepLabel"'],
  ["Grep", { pattern: "foo.*bar\\d+" }, "Searching the code"],
  ["Glob", { pattern: "**/*.ts" }, "Looking through files"],
  ["WebSearch", { query: "tauri tray icon" }, "Searching the web for tauri tray icon"],
  ["WebFetch", { url: "https://www.docs.rs/tauri/latest?x=1" }, "Reading docs.rs"],
  ["Task", { description: "Find the bug" }, "Asking a helper: Find the bug"],
  [
    "TodoWrite",
    { todos: [{ content: "A", status: "completed" }, { content: "Fix it", activeForm: "Fixing it", status: "in_progress" }] },
    "Fixing it",
  ],
  ["TodoWrite", { todos: [] }, "Planning next steps"],
  ["AskUserQuestion", {}, "Asking you a question"],
  ["Skill", { skill: "tdd" }, "Using the tdd skill"],
  ["mcp__github__list_prs", {}, "Using github"],
  ["mcp__3f2a9c1b-1234-4abc-9def-000000000000__x", {}, "Using a connector"],
  ["SomeWeirdTool", { a: 1 }, "Working…"],
  ["Bash", { description: "x".repeat(100) }, "X".padEnd(59, "x") + "…"],
];

let fail = 0;
for (const [tool, input, want] of cases) {
  const got = d(tool, input);
  const ok = got === want && got.length <= 60;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${tool} -> ${got}${ok ? "" : `  (want ${want})`}`);
}
console.log(fail ? `${fail} failed` : "all passed");
process.exit(fail ? 1 : 0);
