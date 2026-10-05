# Coucou (Windows): agent carousel + detail panel redesign

## Context
The overview view today is a left card (focused agent: Mochi plus a compact info card) and a right card of pills for the other agents. Beau finds this inefficient. New model: the **left is a carousel stage** (Mochi/agent bot plus its name; the mouse wheel over it switches agents with a vertical slide), and the **right is a rich detail panel** for the selected agent (Claude Code: live activity, checklist, plan limits; Spotify: album art and full controls; Calendar: upcoming list). Style: the existing Coucou look (minimal, pre-liquid-glass Apple), the same spring motion. Windows/Tauri only (`windows/`). The Mac app is untouched.

## Decisions (grilled 2026-10-05)
- Carousel list = `State.tasks` (Claude Code + toggled-on integrations + live agent sessions). Disabled integrations (n8n, Vercel unticked) are never in it.
- Wheel **down** = next agent: the current one slides up and out, the next comes in from below. Wheel up is the reverse. 1 notch = 1 agent, ~350ms lock, stop at the ends with a small rubber-band bounce. Touchpad: accumulate deltaY up to a threshold.
- Wheel zones: over the left switches agents. Over the right it scrolls that panel (calendar list); otherwise nothing.
- Left = bot + name only. A tiny vertical dot strip beside the bot: one dot per agent, the current one highlighted, a dot glows in its badge colour when that agent has finished or needs attention.
- Alerts unchanged: approval/question/finished/error takeovers plus sounds stay as they are. When a takeover closes, the carousel auto-scrolls to that agent.
- Always opens on Claude Code at startup.
- Header row (tabs, settings, sound) unchanged.
- Proportions are my call. Beau reviews after. Start: overview island 640 -> 720 wide (= PANEL_W, the window already fits) and 160 -> 200 tall. Left column ~150px, right panel takes the rest.
- Claude panel: an activity message (emphasised), Claude's real checklist only when Claude made one (max 4 rows, current one bold, done ones ticked/faded, "+N more"), slim 5h/Week bars with reset time, a small footer (context %, elapsed, Open Claude). Idle: "Idle" plus the bars.
- Quirky activity: a local **Ollama gemma3:4b** rewrites Claude's own words plus tool activity into a short (<= ~60 char) accurate message with light personality, not silly, no emoji, never inventing work. The rule-based text (`core/activity.ts`) shows instantly and is the fallback when Ollama is off.
- Plan limits: claude-hud `display.externalUsageWritePath` writes official rate_limits JSON. Coucou reads that file.
- Spotify panel: album art, title, artist, a progress bar with times, big prev/play/next, a slim volume slider. No shuffle/like.
- Calendar panel: the rest of today plus the next 2 days under small day headings, the next event highlighted ("in 20 min"), scrollable.

## Tickets (vertical slices, each delegated to sonnet-coder via /delegate, accepted by me)

### T1: Carousel shell (no new data)
- `src/core/layout.ts`: overview height 200, expanded width 720 for overview, new bot position for the left column.
- `src/views/views.ts` `buildOverview`: replace the left card/right pills with a `.stage` (name label + dot strip) and a `.detail` panel that renders the existing `renderIntegrationCard`/ticker for the focused task for now. Remove `buildPill` usage from the overview (keep the function if other views use it; delete it if dead).
- `src/island/island.ts`: wheel handler on the stage zone -> `State.setFocus(next)`. Slide animation: snapshot the current `botCanvas` into a temp canvas that springs up (or down) and fades, while the live canvas springs in from the opposite side using the existing springs in `core/anim.ts`. The detail panel and name cross-slide the same way. Rubber-band at the ends.
- Dot strip driven by `State.tasks` + `pillBadge` (reuse badge colours from `buildPill`).
- Takeover close -> `setFocus(task.id)` of the agent that took over (hook in `island/hooks.ts` / FSM).
- Startup focus = `integration_claude`.
- Remove `mini-grid` from the overview if it's only used for the pills (check `agentMode: "pills"`).

### T2: Claude data (plan limits, transcript, checklist)
- claude-hud config: add `display.externalUsageWritePath` -> `%LOCALAPPDATA%\Coucou\claude-usage.json` (dated backup, show the diff, write only after Beau confirms).
- Rust (`src-tauri/src/claude.rs`): read + watch that file and expose `five_hour`/`seven_day` `used_percentage` + `resets_at`, stale after 5 min.
- Hook (`hook/src/main.rs:32`): stop dropping `transcript_path`. The app tails the transcript locally for the last assistant text + latest usage (context tokens). Never log transcript content.
- Checklist: parse `TodoWrite` (`todos`) and the newer `TaskCreate`/`TaskUpdate`/`TaskList` tool inputs from PreToolUse/PostToolUse into a per-session list on the task (`core/state.ts` AgentTask). Tests on fixture payloads.
- Claude detail panel UI per the decisions.

### T3: Quirky activity via Ollama
- Rust module `src-tauri/src/rewrite.rs`: POST `http://127.0.0.1:11434/api/generate` (hard-coded loopback only), model `gemma3:4b`, `keep_alive` 10m, short timeout, debounced (only on a meaningful change, at most 1 per ~4s per session), cache by input hash. On any failure, silently keep the rule text.
- Prompt: input = the rule-based activity + the last assistant sentence. Output = one line, <= 60 chars, accurate, light personality, no emoji. Post-filter length/newlines.
- A Settings toggle "Friendly activity text (Ollama)", default on.
- Requires `ollama pull gemma3:4b` (~3.3GB download, ask Beau first).

### T4: Spotify panel
- `src-tauri/src/integrations.rs`: include `album.images` (smallest >= 64px URL), `volume_percent` from the player, a new `spotifyVolume(pct)` -> `PUT /me/player/volume` (Content-Length 0 like the controls).
- CSP: allow `img-src https://i.scdn.co`.
- UI: art left (rounded 8px), title/artist/progress with mm:ss, big controls, a slim volume slider (debounced 200ms). Show Spotify's refusal message as now.

### T5: Calendar panel
- Extend the gcal fetch window from today to today + 2 days. Group by day, highlight the next event with a relative time, scrollable list (wheel zone right).

## Order
T1 -> T4 -> T5 -> T2 -> T3 (visible wins first, the risky data work after). 5 tickets, so this qualifies for `auto-run`; I'd still run it ticket by ticket in this session because each needs Beau's visual review.

## Verification
- Per ticket: `npx tsc --noEmit`, `cargo test` (28+ tests, plus new parsers), visual check in `npm run tauri dev` with screenshots (wheel up/down, ends bounce, takeover -> auto-scroll, dots).
- T2: a fixture hook payload with TodoWrite/TaskUpdate produces the checklist; a fake usage JSON renders the bars; a stale file hides them.
- T3: with Ollama stopped, the rule text shows and there are no errors in `%LOCALAPPDATA%\Coucou\coucou.log`; with it running, the message changes within ~2s.
- End: `review-changes`, rebuild the release (`npx tauri build --no-bundle`), recopy to `%LOCALAPPDATA%\Programs\Coucou\`.

## Claude panel + subagents (grilled 2026-10-05, rounds 4-5) - supersedes T2/T3 details above where they differ
Done since: T1 `8ad16d5`, T4 `ca70737`, T5 `0a52d3a` (Beau signed off Spotify), notes `357cbdf`/`b0f5fd6`, auto-hide off `e3a03e4` (petit never hides; tray pause still hides).

Panel layout (right side, Claude Code focused):
1. Friendly line (big, Ollama gemma3:4b) + plain fact line under it (small grey: "Editing integrations.ts · 14 min").
2. Middle: Claude's real checklist (3-4 rows: last done, current bold, next 1-2, "3/9 done"); hidden when none.
3. Running subagents as a row of mini orange Mochis: takes the middle when there's no checklist, a slim row along the bottom when there is (option a). ONLY running subagents (finished ones disappear). Each mini Mochi has its own bobbing/working animation, phases deliberately out of sync.
4. Bottom: thin 5h + Week bars with % and reset time; colour shift amber >=70%, red >=90%; no sound/pop-up. Open Claude link.
- Dropped: context %, the "20/20" step counter.
- Idle: calm; limit bars + "Last: <friendly summary> · 12 min ago" + Open Claude.

Subagent drill-in: click a mini Mochi -> it grows and glides into the big bot spot on the left while the right panel slides to that subagent's view: friendly line + plain line, model, elapsed, back arrow. Back reverses exactly. Animations must connect smoothly (shared-element feel, same springs as the carousel). No subagent checklist. Model: from the Agent tool input `model`, else the agent definition frontmatter (`.claude/agents/<type>.md`), else "Same as Claude"; never guess. If the viewed subagent finishes: brief done tick, then auto back out.
Data: PreToolUse for the Agent/Task tool (description, prompt, subagent_type, model) + SubagentStart/SubagentStop (agent_id); subagent tool events carry agent_id in recent Claude Code (verify on 2.1.285) to drive per-subagent plain/friendly lines.

Multiple Claude sessions: one carousel entry per live session, label "Claude Code" with the cwd folder name underneath ("Traksy"). Extra sessions fade out when they end; the main Claude Code entry always stays. Needs per-session tasks (today one `integration_claude` task).

Usage: refresh on every Stop hook (end of each prompt) via Claude Code's zero-token `get_usage` control request (verify it works on 2.1.285 and costs no usage); fallback = claude-hud file `%LOCALAPPDATA%\Coucou\claude-usage.json`; if stale show "updated N min ago".

Suggested tickets: T2a per-session Claude tasks + panel shell (plain line, limits, idle) -> T2b checklist -> T2c subagents row + drill-in animation -> T3 Ollama friendly lines (main + subagents).
