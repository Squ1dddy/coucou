// Island views — DOM ports of IslandViewContent.swift. Paddings, font sizes,
// colours and wording are copied from the Swift views so both platforms read
// identically.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { State, sessionLabel, setSessionName, type AgentTask } from "../core/state";
import { Bridge } from "../core/bridge";
import { washRGBA, type IslandViewName, type Wash } from "../core/layout";
import { WheelStepper } from "../core/carousel";
import { viewedSubagent } from "./claude";
import { buildPrompt } from "./chat";
import { buildChoose, buildUpload, buildUploading } from "./upload";
import {
  renderIntegrationCard,
  integrationCardSalt,
  integrationCardHeld,
  syncLiveTimer,
  type IntegrationCardHooks } from "./integrations";

export interface ViewActions {
  setView(v: IslandViewName): void;
  collapse(): void;
  setFocus(id: string): void;
  /** Wheel over the carousel: next (+1) or previous (-1) agent, bouncing at the ends. */
  stepFocus(dir: 1 | -1): void;
  /** Brings the Claude desktop app forward (VS Code where there is none). */
  openClaude(): void;
  /** The ↗ button: opens whatever the focused pill points at. */
  openTarget(): void;
  openUrl(url: string): void;
  /** Claude panel: fly a subagent's mini Mochi to the stage and show its view. */
  drillIn(agentId: string, slot: HTMLElement): void;
  /** Leave the subagent view (the reverse flight). */
  drillOut(): void;
  decide(d: "allow" | "deny"): void;
  toggleSound(): void;
  setVolume(v: number): void;
  setAutoClose(seconds: number): void;
  openSettingsWindow(): void;
  blip(): void;
}

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  /** Called when the view becomes active, for views with a text field. */
  focus?(): void;
  /** Called every frame while the view is on screen. */
  tick?(nowMs: number): void;
  /** Called when the view stops being the active one. */
  leave?(): void;
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

function card(wash: Wash, ...children: (Node | string)[]): HTMLElement {
  const el = h("div", { class: wash ? "card wash" : "card" }, ...children);
  if (wash) el.style.setProperty("--wash", washRGBA(wash));
  return el;
}

function btn(
  label: string,
  kind: "primary" | "secondary",
  onClick: () => void,
  kbd?: string,
): HTMLElement {
  return h(
    "button",
    { class: `btn ${kind}`, onclick: onClick },
    h("span", { text: label }),
    kbd ? h("span", { class: "kbd", text: kbd }) : null,
  );
}

/** AgentWho — coloured dot + task name + grey label. */
function agentWho(task: AgentTask | null, label: string): HTMLElement {
  const row = h("div", { class: "who-row" });
  if (task) {
    row.append(dot(task.color, 8), h("span", { class: "n", text: [sessionLabel(task) ?? task.name, task.project].filter(Boolean).join(" · ") }));
  }
  row.append(h("span", { text: label }));
  return row;
}

function stack(padLeft: number, padRight: number, ...children: Node[]): HTMLElement {
  const el = h("div", { class: "stack" }, ...children);
  el.style.padding = `4px ${padRight}px 4px ${padLeft}px`;
  return el;
}

// ── Header ────────────────────────────────────────────────────────────────────

export function buildHeader(actions: ViewActions): ViewHost {
  const tabHome = h("button", { class: "tab", title: "Overview", onclick: () => go("overview") }, svg(ICONS.house, 13));
  const tabChat = h("button", { class: "tab", title: "Ask", onclick: () => go("prompt") }, svg(ICONS.bubble, 13));
  const tabDrop = h("button", { class: "tab", title: "Drop", onclick: () => go("upload") }, svg(ICONS.plus, 13));

  const gearBtn = h("button", { title: "Settings", onclick: () => go("settings") }, svg(ICONS.gear, 14));
  const soundBtn = h("button", { title: "Mute", onclick: () => actions.toggleSound() }, svg(ICONS.speakerOn, 14));

  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }

  const el = h(
    "div",
    { id: "header" },
    h("div", { class: "tabs" }, tabHome, tabChat, tabDrop),
    h("div", { class: "header-actions" }, gearBtn, soundBtn),
  );

  return {
    el,
    sync() {
      const v = State.view;
      tabHome.classList.toggle("on", v === "overview" || v === "empty");
      tabChat.classList.toggle("on", v === "prompt");
      tabDrop.classList.toggle("on", v === "upload");
      gearBtn.classList.toggle("on", v === "settings");
      clear(gearBtn);
      gearBtn.append(svg(v === "settings" ? ICONS.gearFill : ICONS.gear, 14));
      clear(soundBtn);
      soundBtn.append(svg(State.settings.soundEnabled ? ICONS.speakerOn : ICONS.speakerOff, 14));
      el.style.opacity = v === "confused" ? "0" : "1";
    },
  };
}

// ── Overview ──────────────────────────────────────────────────────────────────

/** Badge colours shared by the carousel's dots. */
const BADGE_COLORS = { approval: "#F5A524", finished: "#22C55E", error: "#F4505E" } as const;

/** How far (px) the name and detail panel travel while the carousel slides. */
const SLIDE_PX = 26;
const SLIDE_MS = 340;
const SLIDE_EASE = "cubic-bezier(0.3, 1.1, 0.4, 1)";

/**
 * Cross-slides `body` for a focus change: a ghost copy of the old content slides
 * out while the (already re-rendered) body slides in from the other side.
 * `dir` +1 = next agent: old goes up, new comes from below.
 */
function crossSlide(host: HTMLElement, body: HTMLElement, ghost: HTMLElement | null, dir: 1 | -1) {
  if (ghost) {
    ghost.classList.add("ghost");
    host.append(ghost);
    const out = ghost.animate(
      [
        { transform: "translateY(0)", opacity: 1 },
        { transform: `translateY(${-dir * SLIDE_PX}px)`, opacity: 0 },
      ],
      { duration: SLIDE_MS, easing: SLIDE_EASE, fill: "forwards" },
    );
    out.onfinish = () => ghost.remove();
  }
  body.animate(
    [
      { transform: `translateY(${dir * SLIDE_PX}px)`, opacity: 0 },
      { transform: "translateY(0)", opacity: 1 },
    ],
    { duration: SLIDE_MS, easing: SLIDE_EASE },
  );
}

/** A deep copy that keeps what canvases were showing (cloneNode leaves them blank). */
function cloneWithCanvases(el: HTMLElement): HTMLElement {
  const copy = el.cloneNode(true) as HTMLElement;
  const from = el.querySelectorAll("canvas");
  const to = copy.querySelectorAll("canvas");
  from.forEach((c, i) => to[i]?.getContext("2d")?.drawImage(c, 0, 0));
  return copy;
}

function buildOverview(actions: ViewActions): ViewHost {
  const detailBody = h("div", { class: "detail-body" });
  const jump = h(
    "button",
    { class: "icon-btn jump", title: "Open", onclick: () => actions.openTarget() },
    svg(ICONS.arrowUpRight, 8),
  );
  const detail = card(null, detailBody, jump);
  detail.classList.add("detail-panel");

  // Left column: the island draws the bot over it; the name and dots live here.
  const nameEl = h("div", { class: "stage-name" });
  const dots = h("div", { class: "stage-dots" });
  const stage = h("div", { class: "stage" }, card(null), nameEl, dots);

  // The wheel switches agents over the stage only; the detail panel scrolls natively.
  const stepper = new WheelStepper();
  stage.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const dir = stepper.feed(e.deltaY, performance.now(), e.deltaMode);
      if (dir) actions.stepFocus(dir);
    },
    { passive: false },
  );

  // "N min" text and the limit bars age on their own: one slow repaint while a
  // Claude panel is on screen (nothing at all while the island is hidden).
  window.setInterval(() => {
    if (State.mode !== "hidden" && State.view === "overview" && State.focusTask?.source === "claudeCode") {
      State.notify();
    }
  }, 30_000);

  const el = h("div", { class: "view overview" }, stage, h("div", { class: "right" }, detail));

  let dotKey = "";
  let detailOpen = false;
  let lastFocus: string | null = null;
  let cardKey = "";
  /** False while the view is off screen, so a focus change then does not animate. */
  let shown = false;
  /** Set while the stage name is an input: ends the rename (saving or not). */
  let endRename: ((save: boolean, quiet?: boolean) => void) | null = null;

  function renderName(task: AgentTask | null) {
    clear(nameEl);
    nameEl.removeAttribute("title");
    const viewing = task ? viewedSubagent(task)?.sub : null;
    if (viewing) {
      // Drilled in: the Mochi on the stage is the subagent, named for its job.
      nameEl.append(h("span", { class: "stage-name-main", text: viewing.description }));
      nameEl.append(h("span", { class: "stage-name-sub", text: viewing.type }));
    } else if (task) {
      // A Claude session goes by its name (yours, else title, else first prompt);
      // "Claude Code" moves to the tooltip.
      const label = task.source === "claudeCode" ? sessionLabel(task) : null;
      const main = h("span", { class: "stage-name-main", text: label ?? task.name });
      nameEl.append(main);
      if (task.project) nameEl.append(h("span", { class: "stage-name-sub", text: task.project }));
      if (label) nameEl.title = `${task.name} · ${label}`;
      if (task.source === "claudeCode" && task.sessionId) {
        nameEl.title = `${nameEl.title || task.name}\nDouble-click to rename`;
        main.addEventListener("dblclick", () => startRename(task, main));
      }
    }
  }

  /** Double-click a Claude session's stage name: type the name you want shown for it. */
  function startRename(task: AgentTask, main: HTMLElement) {
    const sessionId = task.sessionId;
    if (!sessionId || endRename) return;
    const input = h("input", { class: "stage-name-input", maxlength: 60, spellcheck: "false" });
    input.value = sessionLabel(task) ?? "";
    input.placeholder = "Session name";
    main.replaceWith(input);
    // The island only takes keyboard focus while a text field needs it (as for the chat).
    void Bridge.focusWindow(true);
    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 120);
    // `quiet` when called from inside a sync, which redraws anyway.
    endRename = (save, quiet = false) => {
      endRename = null;
      // Blank saves as "no name": back to the title or first prompt.
      if (save) setSessionName(sessionId, input.value);
      void Bridge.focusWindow(false);
      if (!quiet) State.notify();
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") endRename?.(true);
      else if (e.key === "Escape") endRename?.(false);
    });
    input.addEventListener("blur", () => endRename?.(true));
  }

  const hooks: IntegrationCardHooks = {
    get detailOpen() {
      return detailOpen;
    },
    openDetail() {
      detailOpen = true;
      cardKey = "";
      State.notify();
    },
    closeDetail() {
      detailOpen = false;
      cardKey = "";
      State.notify();
    },
    openSettings: () => actions.openSettingsWindow(),
    drillIn: (id, slot) => actions.drillIn(id, slot),
    drillOut: () => actions.drillOut(),
  };
  let lastDrill: string | null = null;

  return {
    el,
    leave() {
      shown = false;
      endRename?.(true, true);
    },
    sync() {
      const task = State.focusTask;
      let ghostBody: HTMLElement | null = null;
      let ghostName: HTMLElement | null = null;
      const changed = task?.id !== lastFocus;
      // Opening / closing a subagent view slides the panel like a carousel step
      // (in = next, out = previous); a focus change wins and exits it instantly.
      const drillId = State.drillAgentId;
      const drillChanged = !changed && drillId !== lastDrill;
      const slideDir: 1 | -1 = changed ? State.focusDir : drillId ? 1 : -1;
      lastDrill = drillId;
      if (drillChanged) cardKey = "";
      if (changed || drillChanged) {
        if (shown && lastFocus != null) {
          ghostBody = cloneWithCanvases(detailBody);
          ghostName = nameEl.cloneNode(true) as HTMLElement;
        }
        lastFocus = task?.id ?? null;
        detailOpen = false;
        cardKey = "";
        endRename?.(true, true);
      }

      // Mid-rename the name stays an input; everything else still updates.
      if (!endRename) renderName(task);

      // Every pill shows its own card, exactly like IntegrationCardView; Claude
      // Code entries (main or extra session) get the Claude panel.
      if (task) {
        const info = State.integrations[task.id];
        const key = [
          task.id, detailOpen, task.state, task.steps.join("|"),
          info?.loaded, info?.error, info?.configured,
          JSON.stringify(info?.data ?? {}), integrationCardSalt(task.id),
          // The Claude panel also shows limits and "N min" text that move on their own.
          task.source === "claudeCode"
            ? [
                task.promptAt, task.updatedAt, task.project, JSON.stringify(State.claudeUsage),
                Math.floor(Date.now() / 30_000), drillId,
                (task.subagents ?? []).map((x) => `${x.agentId}/${x.model}/${drillId === x.agentId ? x.lastActivity : ""}`).join(","),
              ].join("^")
            : "",
        ].join("~");
        // A poll must not rebuild the volume slider under the user's finger.
        const held = cardKey.startsWith(`${task.id}~`) && integrationCardHeld();
        if (key !== cardKey && !held) {
          // Same agent re-rendered (a poll, a clock tick): keep the list's scroll place.
          const scroll = cardKey.startsWith(`${task.id}~`) ? detailBody.scrollTop : 0;
          cardKey = key;
          clear(detailBody);
          detailBody.append(renderIntegrationCard(task, hooks));
          detailBody.scrollTop = scroll;
        }
      }
      syncLiveTimer();

      jump.style.display = detailOpen ? "none" : "";

      // Dot strip: one dot per agent, the current one longer; a finished / waiting /
      // failed agent glows in its badge colour.
      const key = State.tasks.map((t) => `${t.id}:${t.pillBadge ?? ""}:${t.project ?? ""}:${sessionLabel(t) ?? ""}`).join("|") + `@${task?.id}`;
      if (key !== dotKey) {
        dotKey = key;
        clear(dots);
        for (const t of State.tasks) {
          const d = h("i");
          if (t.pillBadge) {
            const c = BADGE_COLORS[t.pillBadge];
            d.style.background = c;
            d.style.boxShadow = `0 0 6px ${c}`;
          }
          const b = h(
            "button",
            {
              class: t.id === task?.id ? "stage-dot on" : "stage-dot",
              title: [sessionLabel(t) ?? t.name, t.project].filter(Boolean).join(" · "),
              onclick: () => actions.setFocus(t.id),
            },
            d,
          );
          dots.append(b);
        }
      }

      if ((changed || drillChanged) && shown && ghostBody && ghostName) {
        crossSlide(detail, detailBody, ghostBody, slideDir);
        crossSlide(stage, nameEl, ghostName, slideDir);
      }
      shown = true;
    },
  };
}

// ── Empty ─────────────────────────────────────────────────────────────────────

function buildEmpty(actions: ViewActions): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px;flex-direction:row;align-items:center;gap:16px" },
    h(
      "div",
      { style: "display:flex;flex-direction:column;gap:5px" },
      h("div", { class: "title", text: "Nothing running right now." }),
      h("div", { class: "sub", text: "Drop a file or window, or ask me anything." }),
    ),
    h("div", { class: "grow" }),
    btn("Ask Claude", "primary", () => actions.setView("prompt")),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Approval ──────────────────────────────────────────────────────────────────

function buildApproval(actions: ViewActions): ViewHost {
  const who = h("div");
  const code = h("div", { class: "code" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("amber", stack(116, 16, who, code, row)));
  let rowKey = "";
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, "needs permission"));
      // The whole point of approving here rather than in the terminal: this line
      // is the command, the file path or the URL being authorised, not just the
      // name of the tool asking.
      code.textContent = State.pendingApproval?.command || State.pendingApproval?.tool || "…";
      // Two buttons, built once. Rebuilding them between a mouse-down and a
      // mouse-up would swallow the click, and there is nothing left to vary:
      // "Always" is gone until the remembered-rules list exists to back it.
      if (rowKey === "built") return;
      rowKey = "built";
      clear(row);
      row.append(
        btn("Deny", "secondary", () => actions.decide("deny"), "N"),
        btn("Allow", "primary", () => actions.decide("allow"), "Y"),
      );
    },
  };
}

// ── Question ──────────────────────────────────────────────────────────────────

function buildQuestion(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const row = h("div", { class: "actions" },
    btn("Open Claude", "primary", () => actions.openClaude()),
    btn("Later", "secondary", () => actions.collapse()),
  );
  const el = h("div", { class: "view" }, card("cyan", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, "is asking"));
      title.textContent = State.focusTask?.steps.at(-1) ?? "Claude needs an answer";
    },
  };
}

// ── Error ─────────────────────────────────────────────────────────────────────

function buildError(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title", text: "Workflow stopped." });
  const detail = h("div", { class: "detail" });
  const row = h("div", { class: "actions" },
    btn("Retry", "primary", () => actions.setView(State.defaultView())),
    btn("Open in n8n", "secondary", () => actions.openUrl("")),
  );
  const el = h("div", { class: "view" }, card("red", stack(116, 16, who, title, detail, row)));
  return {
    el,
    sync() {
      const task = State.focusTask;
      clear(who);
      who.append(agentWho(task, task?.source === "n8n" ? "n8n" : "Claude Code"));
      title.textContent = task?.source === "n8n" ? "Workflow stopped." : "Session stopped on an error.";
      detail.textContent = task?.steps.at(-1) ?? "No detail available.";
    },
  };
}

// ── Finished ──────────────────────────────────────────────────────────────────

function buildFinished(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const row = h("div", { class: "actions" },
    btn("Open Claude", "primary", () => actions.openClaude()),
    btn("OK", "secondary", () => actions.collapse()),
  );
  const el = h("div", { class: "view" }, card("green", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, "finished"));
      title.textContent = State.focusTask?.steps.at(-1) ?? "Session finished";
    },
  };
}

// ── Confused ──────────────────────────────────────────────────────────────────

function buildConfused(): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 128px" },
    h("div", { class: "title", text: "Too many hits at once." }),
    h("div", { class: "sub", text: "Give me a sec — back to work in three seconds." }),
  );
  return { el: h("div", { class: "view" }, card("pink", body)), sync() {} };
}

// ── Note ──────────────────────────────────────────────────────────────────────

function buildNote(): ViewHost {
  const title = h("div", { class: "title" });
  const el = h("div", { class: "view" }, card(null, h("div", { class: "stack", style: "padding:0 18px 0 98px" }, title)));
  return {
    el,
    sync() {
      title.textContent = State.noteMessage ?? "";
    },
  };
}

// ── In-island settings ────────────────────────────────────────────────────────

function buildSettings(actions: ViewActions): ViewHost {
  const soundSwitch = h("button", { class: "switch", onclick: () => actions.toggleSound() });
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    oninput: (e: Event) => actions.setVolume(Number((e.target as HTMLInputElement).value)),
  }) as HTMLInputElement;
  const autoLabel = h("span", {});
  const segButtons = [10, 15, 30].map((s) =>
    h("button", { onclick: () => actions.setAutoClose(s) }, `${s}s`),
  );
  const claudeBadge = h("span", { class: "status-badge" });
  const apiBadge = h("span", { class: "status-badge" });

  const rows = h(
    "div",
    { class: "settings-rows" },
    h("div", { class: "settings-row" }, soundSwitch, h("span", { text: "Sound" }), volume),
    h(
      "div",
      { class: "settings-row" },
      svg(ICONS.timer, 12),
      autoLabel,
      h("div", { class: "seg" }, ...segButtons),
    ),
    h(
      "div",
      { class: "settings-row", style: "gap:14px" },
      claudeBadge,
      apiBadge,
      h("div", { class: "grow" }),
      h("button", {
        class: "link-btn",
        style: "color:#8e939c;font-size:11.5px",
        text: "Settings…",
        onclick: () => actions.openSettingsWindow(),
      }),
    ),
  );

  const el = h("div", { class: "view" },
    card(null, h("div", { class: "stack", style: "padding:14px 16px 14px 84px" }, rows)));

  return {
    el,
    sync() {
      const s = State.settings;
      soundSwitch.classList.toggle("on", s.soundEnabled);
      volume.value = String(s.soundVolume);
      volume.style.opacity = s.soundEnabled ? "1" : "0.4";
      autoLabel.textContent = `Auto-close · ${Math.round(s.autoCloseInterval)}s`;
      segButtons.forEach((b, i) => b.classList.toggle("on", s.autoCloseInterval === [10, 15, 30][i]));
      clear(claudeBadge);
      claudeBadge.append(
        dot(s.hooksInstalled ? "#22C55E" : "#F4505E", 6),
        h("span", { text: "Claude Code" }),
      );
      clear(apiBadge);
      apiBadge.append(dot("#F4505E", 6), h("span", { text: "API" }));
    },
  };
}

// ── Placeholders filled in later stages ───────────────────────────────────────

function buildPlaceholder(title: string, sub: string): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px" },
    h("div", { class: "title", text: title }),
    h("div", { class: "sub", text: sub }),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Registry ──────────────────────────────────────────────────────────────────

export function buildViews(
  actions: ViewActions,
  onChatHeightChange: () => void,
): Map<IslandViewName, ViewHost> {
  const map = new Map<IslandViewName, ViewHost>();
  map.set("overview", buildOverview(actions));
  map.set("empty", buildEmpty(actions));
  map.set("approval", buildApproval(actions));
  map.set("question", buildQuestion(actions));
  map.set("error", buildError(actions));
  map.set("finished", buildFinished(actions));
  map.set("confused", buildConfused());
  map.set("note", buildNote());
  map.set("settings", buildSettings(actions));
  map.set("prompt", buildPrompt(onChatHeightChange));
  map.set("upload", buildUpload());
  map.set("uploading", buildUploading());
  map.set("choose", buildChoose(actions));
  // Not in the Windows v1: sending a file by email, window attach + web result.
  map.set("mail", buildPlaceholder("Sending by email isn't in this version.", ""));
  map.set("searching", buildPlaceholder("Claude is searching…", ""));
  map.set("result", buildPlaceholder("Result", ""));
  return map;
}
