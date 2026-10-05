// Runs before `npm run dev` (the Tauri beforeDevCommand). A dev session that was
// not shut down cleanly leaves its Vite holding port 1420 (strictPort) and its
// debug coucou.exe locked, and the next `tauri dev` dies on "Port 1420 is
// already in use". Stop those leftovers, but only when they belong to this
// project; anything else on the port is reported, never killed.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const PORT = 1420;
const root = resolve(import.meta.dirname, "..").toLowerCase();

function ps(script) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
  }).trim();
}

function processes() {
  const out = ps(
    `@(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | ` +
      `ForEach-Object { $_.OwningProcess }) + @(Get-Process coucou -ErrorAction SilentlyContinue | ` +
      `ForEach-Object { $_.Id }) | Sort-Object -Unique | ForEach-Object { ` +
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=$_"; ` +
      `if ($p) { [pscustomobject]@{ id = $p.ProcessId; cmd = "$($p.ExecutablePath) $($p.CommandLine)" } } } | ` +
      `ConvertTo-Json -Compress`,
  );
  if (!out) return [];
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [parsed];
}

if (process.platform !== "win32") process.exit(0);

const dry = process.argv.includes("--dry");
let blocked = false;
for (const { id, cmd } of processes()) {
  const lower = cmd.toLowerCase();
  if (lower.includes(root)) {
    if (!dry) ps(`Stop-Process -Id ${id} -Force`);
    console.log(`free-dev-port: ${dry ? "would stop" : "stopped"} leftover dev process ${id}`);
  } else if (lower.includes("\\target\\") || lower.includes("vite")) {
    console.error(`free-dev-port: port ${PORT} or coucou.exe held by another project (pid ${id}), not touching it`);
    blocked = true;
  }
  // Anything else named coucou (the installed release build) is left alone.
}
process.exit(blocked ? 1 : 0);
