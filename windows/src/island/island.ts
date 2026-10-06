// The island: DOM shell, sizing animation, Mochi placement, mouse handling.
// Mirrors IslandRootView.swift + IslandWindowController.swift.

import { Tracked, Spring, clamp } from "../core/anim";
import { stepIndex, type Dir } from "../core/carousel";
import { Bridge, IS_TAURI, onDragDrop } from "../core/bridge";
import {
  EXPANDED_CORNER, EXPANDED_W, NOTCH_W, PANEL_H, PANEL_W,
  ROUNDED_CORNER, VIEW_LAYOUTS, botGlowColor, botGlowOpacity, botPosition, chatPromptHeight,
  islandSize,
  type IslandMode, type IslandViewName,
} from "../core/layout";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { BotEngine, hexToRGB } from "../mochi/engine";
import { Greeting } from "../mochi/greeting";
import { createMiniBot, emoteMiniBot, pruneMiniBots, syncMiniBotStates, tickMiniBots } from "../mochi/minibots";
import { UploadCanvas } from "../upload/canvas";
import { USC, UploadSeq } from "../upload/sequence";
import { buildHeader, buildViews, type ViewActions, type ViewHost } from "../views/views";
import { h, svg } from "../views/dom";
import { ICONS } from "../views/icons";
import { IslandStateMachine } from "./fsm";

const BOT_OVERHANG = 40;
/** Clear space around the stage bot so confetti can fly past the card edges. */
const BOT_FX_PAD = 120;
/** Carousel slide: how far (px) the bot travels, and the end-of-list nudge. */
const SLIDE_D = 56;
const BUMP_PX = 6;
/** How long the done tick shows on a finished subagent before the panel backs out. */
const DONE_TICK_MS = 600;
/** Stage column in island coordinates (content padding 10, header 34 + 8). */
const STAGE = { left: 10, top: 42, w: 150, bottomInset: 10 };
/** Same margin as the Rust hit test (src-tauri/src/island.rs). */
const HIT_MARGIN = 14;

/** The three views the drop sequence owns; leaving them stops the engine. */
const UPLOAD_VIEWS: ReadonlySet<IslandViewName> = new Set(["upload", "uploading", "choose"]);

/** Seconds between the drop and the moment the progress bar starts filling. */
const PRE_PROGRESS = USC.T_PROG_START - USC.T_DROP;

const modeOrder = (m: IslandMode) => (m === "hidden" ? 0 : m === "compact" ? 1 : 2);


/** Seconds an island opened by an alert (not by you) stays open. */
const ALERT_CLOSE_S = 5;
/** Two clicks on the Mochi this close open its chat; a third this soon after makes it dizzy instead. */
const DOUBLE_CLICK_MS = 350;
export class Island {
  readonly fsm = new IslandStateMachine();

  private root: HTMLElement;
  private islandEl!: HTMLElement;
  private clipEl!: HTMLElement;
  private contentEl!: HTMLElement;
  private viewsEl!: HTMLElement;
  private botCanvas!: HTMLCanvasElement;
  private botGlow!: HTMLElement;
  private botLayer!: HTMLElement;
  private snapCanvas!: HTMLCanvasElement;
  private greetingCanvas!: HTMLCanvasElement;
  private miniGrid!: HTMLElement;
  private countdown!: HTMLElement;
  private wakeStrip!: HTMLElement;

  private header!: ViewHost;
  private views!: Map<IslandViewName, ViewHost>;
  private uploadCanvas!: UploadCanvas;

  private width = new Tracked(NOTCH_W);
  private height = new Tracked(0);
  private radius = new Tracked(ROUNDED_CORNER);
  private botCx = new Spring(46);
  private botCy = new Spring(16);
  private botSize = new Spring(10);
  /** Carousel slide progress 0 -> 1 (the live bot arrives, the snapshot leaves). */
  private slide = new Spring(1, 0.42, 0.9);
  private slideDir: Dir = 1;
  private sliding = false;
  /** Rubber-band nudge (px) at the first / last agent. */
  private bump = new Spring(0, 0.3, 0.4);
  /**
   * Subagent drill-in: 0 = session view (the parent's Mochi on the stage), 1 = the
   * subagent's Mochi on the stage. Same spring as the carousel slide.
   */
  private fly = new Spring(0, 0.42, 0.9);
  private flyer: { el: HTMLElement; agentId: string } | null = null;
  /** The clicked mini Mochi's centre and body size, island coordinates. */
  private flyFrom = { cx: 0, cy: 0, size: 20 };
  /** Subagent id the island last reacted to. */
  private drillId: string | null = null;
  /** The next exit glides back; every other exit (focus change, takeover) is instant. */
  private animatedExit = false;
  private finishingAt: number | null = null;
  private lastFocusId: string | null = null;
  private slideDirty = false;

  private engine = new BotEngine();
  private greeting = new Greeting();

  private running = false;
  /** Wakes the frame loop when the next idle fidget is due (the loop sleeps in plain idle). */
  private fidgetTimer: number | null = null;
  private lastFrame = 0;
  private dirty = true;
  private canvasPx = 0;
  /** Pixel ratio the bot canvas was sized for; changes when the island moves display. */
  private canvasDpr = 0;

  // Rust starts the window at full size so the launch greeting has room.
  private collapsed = false;
  private collapseTimer: number | null = null;
  private wasInIsland = false;
  /** Last shape handed to Rust for the click-through test. */
  private pushedRect = { x: -1, y: -1, w: -1, h: -1 };
  private homeCollapseAt: number | null = null;

  // Double-click on the Mochi → open its chat
  private lastBotClickAt = 0;
  private openChatTimer: number | null = null;

  private confusedRecovery: number | null = null;
  private prevViewBeforeConfused: IslandViewName = "overview";
  private lastSyncedView: IslandViewName | null = null;

  /** Drop sequence bookkeeping: last tick played, and whether the ✓ has fired. */
  private uploadTens = 0;
  private uploadDone = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.build();
    this.wireFsm();
    this.wireInput();
    this.engine.onDizzy = () => this.handleDizzy();
    this.greeting.onComplete = () => this.fsm.greetComplete();
    State.subscribe(() => {
      this.dirty = true;
      this.noteFocus();
      this.celebratePendingIfFocused();
      this.ensureRunning();
    });
  }

  // ── DOM ─────────────────────────────────────────────────────────────────────

  private build() {
    const actions: ViewActions = {
      setView: (v) => this.setView(v),
      collapse: () => this.collapse(),
      setFocus: (id) => {
        State.setFocus(id);
        Sound.play("blip");
      },
      stepFocus: (dir) => this.stepFocus(dir),
      drillIn: (id, slot) => this.drillIn(id, slot),
      drillOut: () => this.drillOut(),
      openClaude: () => {
        void Bridge.openSession(State.focusTask?.sessionCwd ?? null, State.focusTask?.hostSessionId ?? null);
        this.collapse();
      },
      // The ↗ button — same targets as openAgentTarget() on macOS.
      openTarget: () => {
        const task = State.focusTask;
        if (!task) return;
        const urls: Record<string, string> = {
          integration_vercel: "https://vercel.com/dashboard",
          integration_stripe: "https://dashboard.stripe.com/payments",
          integration_notion: "https://notion.so",
          integration_calcom: "https://app.cal.com/bookings",
        };
        if (task.source === "claudeCode") void Bridge.openSession(task.sessionCwd ?? null, task.hostSessionId ?? null);
        else if (task.id === "integration_n8n") void Bridge.openN8n();
        else if (urls[task.id]) void Bridge.openUrl(urls[task.id]);
      },
      closeSession: () => {
        const task = State.focusTask;
        if (task?.source === "claudeCode" && task.sessionId) State.endClaudeSession(task.sessionId);
      },
      openUrl: (url) => {
        if (url) void Bridge.openUrl(url);
      },
      decide: (d) => {
        const req = State.pendingApproval;
        void Bridge.log(`decide ${d} req=${req?.requestId ?? "none"}`);
        if (!req) return;
        Sound.play(d === "deny" ? "blip" : "approve");
        void Bridge.approvalDecision(req.requestId, d);
        State.pendingApproval = null;
        State.isPinned = false;
        this.fsm.pinned = false;
        // The approval belongs to the entry bound to its session (main or extra).
        const owner = State.claudeTaskFor(req.sessionId)?.id ?? "integration_claude";
        State.updateTask(owner, "working");
        State.setPillBadge(owner, null);
        this.setView(State.defaultView());
      },
      toggleSound: () => {
        State.settings.soundEnabled = !State.settings.soundEnabled;
        Sound.setEnabled(State.settings.soundEnabled);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setVolume: (v) => {
        State.settings.soundVolume = v;
        Sound.setVolume(v);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setAutoClose: (s) => {
        State.settings.autoCloseInterval = s;
        this.fsm.homeToPetitDelay = s;
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      openSettingsWindow: () => void Bridge.openSettingsWindow(),
      blip: () => Sound.play("blip"),
    };

    this.wakeStrip = h("div", { id: "wake-strip" });
    this.botGlow = h("div", { id: "bot-glow" });
    this.botCanvas = h("canvas", { id: "bot-canvas" });
    this.snapCanvas = h("canvas", { id: "bot-snapshot" });
    this.snapCanvas.style.display = "none";
    this.botLayer = h("div", { id: "bot-layer" }, this.botGlow, this.snapCanvas, this.botCanvas);
    this.greetingCanvas = h("canvas", { id: "greeting-canvas" });
    this.miniGrid = h("div", { id: "mini-grid" });
    this.countdown = h("div", { id: "countdown" });

    this.header = buildHeader(actions);
    this.views = buildViews(actions, () => this.animateGeometry(false));
    this.viewsEl = h("div", { id: "views" });
    for (const v of this.views.values()) this.viewsEl.append(v.el);
    this.contentEl = h("div", { id: "content" }, this.header.el, this.viewsEl);

    // The drop sequence draws the card, the bar and its own Mochi. It sits under
    // the header, which stays visible on top of it exactly as on macOS.
    this.uploadCanvas = new UploadCanvas({
      ask: () => {
        State.promptContext = State.droppedFile
          ? { kind: "file", name: State.droppedFile.name, path: State.droppedFile.path }
          : null;
        this.setView("prompt");
      },
      cancel: () => this.setView(State.defaultView()),
    });

    this.clipEl = h(
      "div",
      { id: "island-clip" },
      this.greetingCanvas,
      this.uploadCanvas.el,
      this.contentEl,
    );
    this.islandEl = h(
      "div",
      { id: "island" },
      this.clipEl,
      this.botLayer,
      this.miniGrid,
      this.countdown,
    );

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.greetingCanvas.width = Math.round(EXPANDED_W * dpr);
    this.greetingCanvas.height = Math.round(150 * dpr);
    this.greetingCanvas.style.width = `${EXPANDED_W}px`;
    this.greetingCanvas.style.height = "150px";

    this.root.append(this.wakeStrip, this.islandEl);
    this.applyGeometry();
  }

  // ── FSM ─────────────────────────────────────────────────────────────────────

  private wireFsm() {
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    this.fsm.onTransition = (from, to) => {
      switch (to) {
        case "hidden":
          this.setMode("hidden");
          break;
        case "petit":
          if (from === "coucou") this.greeting.interrupt();
          else if (from === "hidden") Sound.play("peek");
          this.setMode("compact");
          if (from === "coucou") State.view = State.defaultView();
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "home":
          this.expand(State.defaultView());
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "coucou":
          this.expand("greeting");
          this.greeting.start();
          break;
      }
      State.notify();
    };
  }

  launch() {
    this.fsm.launch();
  }

  // ── Mode / view ─────────────────────────────────────────────────────────────

  private setMode(mode: IslandMode) {
    const prev = State.mode;
    if (mode === prev) return;
    State.mode = mode;
    if (mode === "expanded") Sound.play("open");
    if (prev === "expanded") {
      Sound.play("close");
      State.isPinned = false;
      void Bridge.focusWindow(false);
    }
    if (mode !== "expanded") {
      this.engine.resetMorph();
      // Nothing can be seen of the sequence once the island is shut, and leaving
      // it running would keep the frame loop awake — the island must cost
      // nothing while hidden.
      UploadSeq.deactivate();
    }
    this.updateWindowCollapsed();
    this.animateGeometry(modeOrder(mode) < modeOrder(prev));
    State.notify();
  }

  /** True while the drop sequence owns the island body. */
  private get uploadActive(): boolean {
    return State.mode === "expanded" && UploadSeq.isActive && UPLOAD_VIEWS.has(State.view);
  }

  /** Navigating out of the drop flow ends the sequence, as on macOS. */
  private stopSequenceIfLeaving(view: IslandViewName) {
    if (UploadSeq.isActive && !UPLOAD_VIEWS.has(view)) UploadSeq.deactivate();
  }

  expand(view: IslandViewName) {
    this.stopSequenceIfLeaving(view);
    State.view = view;
    if (State.mode !== "expanded") this.setMode("expanded");
    else this.animateGeometry(false);
    State.lastActivity = performance.now();
    this.homeCollapseAt = null;
    State.notify();
  }

  setView(view: IslandViewName) {
    this.stopSequenceIfLeaving(view);
    if (State.mode !== "expanded") {
      this.fsm.forceHome();
      State.view = view;
      this.animateGeometry(false);
      State.notify();
      return;
    }
    const grew = VIEW_LAYOUTS[view].height >= VIEW_LAYOUTS[State.view].height;
    State.view = view;
    State.lastActivity = performance.now();
    this.animateGeometry(!grew);
    State.notify();
  }

  collapse() {
    State.isPinned = false;
    this.fsm.pinned = false;
    // Drive the state machine rather than the mode: setting the mode behind its
    // back left it thinking the island was still open, and a click on the compact
    // island then did nothing — the island could never be reopened.
    this.fsm.forcePetit();
  }

  /** Alert from the hook server: open on this view. Pinned alerts never auto-close. */
  alert(view: IslandViewName) {
    this.fsm.pinned = State.isPinned;
    // Nobody opened this one: give it time to be read. Hovering switches back to the setting.
    this.fsm.homeToPetitDelay = ALERT_CLOSE_S;
    this.fsm.forceHome();
    this.expand(view);
  }

  reveal() {
    this.fsm.reveal();
  }

  /** An alert stopped waiting for an answer: let the island auto-close again. */
  dropPin() {
    this.fsm.pinned = false;
  }

  // ── File drop ───────────────────────────────────────────────────────────────

  private onDragDrop(e: { type: string; paths?: string[] }) {
    if (e.type !== "over") void Bridge.log(`drag ${e.type} ${e.paths?.length ?? 0} file(s)`);
    if (State.paused) return;
    switch (e.type) {
      case "enter":
      case "over": {
        if (State.fileDragOver) return;
        State.fileDragOver = true;
        this.engine.animateMorph(1);
        // enterZone must run before the island expands, so the sequence is
        // already active by the time the view becomes `upload`.
        UploadSeq.enterZone(State.mouseInIsland.x, State.mouseInIsland.y);
        this.alert("upload");
        break;
      }
      case "leave": {
        if (!State.fileDragOver) return;
        State.fileDragOver = false;
        this.engine.animateMorph(0);
        // The island deliberately stays open: the drag session is still alive.
        UploadSeq.exitZone();
        State.notify();
        break;
      }
      case "drop": {
        State.fileDragOver = false;
        const path = e.paths?.[0];
        if (!path) {
          this.engine.animateMorph(0);
          this.setView(State.defaultView());
          return;
        }
        this.swallow(path);
        break;
      }
    }
  }

  /**
   * Mochi eats the file. Nothing here waits on the file system: the copy into
   * the inbox runs in the background and swaps the path in when it lands, so a
   * slow disk can never stall the animation — same as FileDropHandler on macOS.
   */
  private swallow(path: string) {
    const name = path.split(/[\\/]/).pop() || "file";
    State.droppedFile = { name, path };
    State.promptContext = { kind: "file", name, path };
    State.chatHistory = [];
    void Bridge.chatReset();

    UploadSeq.performDrop(State.uploadDuration);
    this.uploadTens = 0;
    this.uploadDone = false;

    this.engine.gulp();
    Sound.play("approve");
    this.engine.triggerEmote("happy");
    this.engine.animateMorph(0);

    State.uploadProgress = 0;
    this.setView("uploading");
    this.ensureRunning();

    void Bridge.ingestFile(path)
      .then((file) => {
        State.droppedFile = { name: file.name, path: file.path };
        State.promptContext = { kind: "file", name: file.name, path: file.path };
        State.notify();
      })
      .catch((err) => {
        UploadSeq.deactivate();
        State.noteMessage = String(err).replace(/^Error:\s*/, "");
        this.engine.animateMorph(0);
        this.setView("note");
        Sound.play("error");
        window.setTimeout(() => this.setView(State.defaultView()), 2400);
      });
  }

  /**
   * Sounds and view changes hung off the canvas timeline: a `tick` every 10 %,
   * the ✓ chime when the bar completes, then `choose` once Mochi has grown back.
   */
  private stepSequence() {
    const since = UploadSeq.sinceDrop();
    if (since == null) return;
    const dur = State.uploadDuration;
    const p = Math.max(0, Math.min(1, (since - PRE_PROGRESS) / dur));

    const tens = Math.floor(p * 10);
    if (tens > this.uploadTens && tens < 10) {
      this.uploadTens = tens;
      Sound.play("tick");
    }

    if (!this.uploadDone && since >= PRE_PROGRESS + dur) {
      this.uploadDone = true;
      Sound.play("approve");
      this.engine.triggerEmote("happy");
    }
    // The extra second is the grow-back, after which the choose card is up.
    if (since >= PRE_PROGRESS + dur + 1 && State.view === "uploading") {
      this.setView("choose");
    }
  }

  // ── Geometry ────────────────────────────────────────────────────────────────

  private targetSize(): { w: number; h: number; r: number } {
    const { w, h } = islandSize(State.mode, State.view, State.chatHistory.length);
    const r = State.mode === "expanded" ? EXPANDED_CORNER : ROUNDED_CORNER;
    return { w, h, r };
  }

  private animateGeometry(shrinking: boolean) {
    const { w, h, r } = this.targetSize();
    if (shrinking) {
      this.width.curveTowards(w);
      this.height.curveTowards(h);
      this.radius.curveTowards(r);
    } else {
      this.width.springTo(w);
      this.height.springTo(h);
      this.radius.springTo(r);
    }
    this.ensureRunning();
  }

  private applyGeometry() {
    const w = this.width.value;
    const hh = this.height.value;
    const r = this.radius.value;
    this.islandEl.style.width = `${w}px`;
    this.islandEl.style.height = `${hh}px`;
    this.islandEl.style.borderRadius = `0 0 ${r}px ${r}px`;
    this.islandEl.style.transform = `translateX(-50%)`;
    // These follow the island as it resizes, so they belong here rather than in
    // the state-driven DOM sync.
    this.miniGrid.style.left = `${w - 40 - 14.5}px`;
    this.miniGrid.style.top = `${hh / 2 - 14.5}px`;
    this.greetingCanvas.style.left = `${(w - EXPANDED_W) / 2}px`;
    this.uploadCanvas.el.style.left = `${(w - EXPANDED_W) / 2}px`;

    const rect = { x: (PANEL_W - w) / 2, y: 0, w, h: hh };
    const p = this.pushedRect;
    if (Math.abs(p.x - rect.x) > 0.5 || Math.abs(p.w - rect.w) > 0.5 || Math.abs(p.h - rect.h) > 0.5) {
      this.pushedRect = rect;
      void Bridge.setIslandRect(rect.x, rect.y, rect.w, rect.h);
    }
  }

  /** Island rect in window coordinates (origin top-left of the 720×320 window). */
  private islandRect(): { x: number; y: number; w: number; h: number } {
    const w = this.width.value;
    const hh = this.height.value;
    return { x: (PANEL_W - w) / 2, y: 0, w, h: hh };
  }

  // ── Window collapse (hidden → tiny wake strip, zero polling) ────────────────

  private updateWindowCollapsed() {
    if (this.collapseTimer != null) {
      window.clearTimeout(this.collapseTimer);
      this.collapseTimer = null;
    }
    if (State.mode === "hidden") {
      // Let the island finish retracting, then drop the window to the wake strip:
      // from there the OS delivers no cursor events, so nothing polls at all.
      this.collapseTimer = window.setTimeout(() => {
        this.collapseTimer = null;
        if (State.mode !== "hidden") return;
        this.collapsed = true;
        void Bridge.setCollapsed(true);
      }, 420);
    } else if (this.collapsed) {
      // Grow the window back before the island animates open.
      this.collapsed = false;
      void Bridge.setCollapsed(false);
    }
  }

  // ── Input ───────────────────────────────────────────────────────────────────

  private wireInput() {
    // The wake strip is the only thing the OS can hit while the island is hidden.
    this.wakeStrip.addEventListener("mouseenter", () => {
      Sound.resume();
      if (State.mode === "hidden") this.fsm.mouseEntered();
    });

    this.islandEl.addEventListener("mousedown", (e) => {
      Sound.resume();
      State.lastActivity = performance.now();
      if (State.mode !== "expanded") {
        this.fsm.click();
        return;
      }
      if (this.isBotHit(e.clientX, e.clientY)) {
        this.onBotClick();
        this.engine.slap();
      }
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && State.mode === "expanded" && !State.isPinned) this.collapse();
      State.lastActivity = performance.now();
    });

    void onDragDrop((e) => this.onDragDrop(e));

    // Outside Tauri (plain browser) drive the cursor from DOM events so the
    // island can be inspected with `npm run dev`.
    if (!IS_TAURI) this.followPageCursor();
  }

  /**
   * Takes the cursor from the page's own mouse events instead of Rust's poll.
   * Used where the OS has no global cursor position (Wayland): the events only
   * fire while the pointer is over the island, so leaving the window is
   * reported as a cursor far away, which is what the poll would have said.
   */
  followPageCursor() {
    window.addEventListener("mousemove", (e) => this.onCursor(e.clientX, e.clientY));
    window.addEventListener("mouseout", (e) => {
      if (e.relatedTarget == null) this.onCursor(-10_000, -10_000);
    });
  }

  /** Cursor in window-logical coordinates. */
  onCursor(x: number, y: number) {
    State.mouse = { x, y };
    const rect = this.islandRect();
    State.mouseInIsland = { x: x - rect.x, y: y - rect.y };

    // Windows sends no cursor position with an OLE drag, so the drop sequence is
    // fed from the Win32 cursor poll instead — it runs throughout the drag.
    if (UploadSeq.isActive && !UploadSeq.dropped) {
      UploadSeq.updateCursor(State.mouseInIsland.x, State.mouseInIsland.y);
    }

    const inIsland =
      x >= rect.x - HIT_MARGIN && x <= rect.x + rect.w + HIT_MARGIN &&
      y >= rect.y - HIT_MARGIN && y <= rect.y + rect.h + HIT_MARGIN;

    if (inIsland && !this.wasInIsland) {
      if (this.fsm.state === "coucou") this.greeting.hover();
      this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
      this.fsm.mouseEntered();
      this.homeCollapseAt = null;
    }
    if (!inIsland && this.wasInIsland) {
      this.fsm.mouseLeft();
      if (this.fsm.state === "home" && !State.isPinned) {
        this.homeCollapseAt = performance.now() + this.fsm.homeToPetitDelay * 1000;
      }
    }
    this.wasInIsland = inIsland;

    this.ensureRunning();
  }

  private isBotHit(x: number, y: number): boolean {
    const rect = this.islandRect();
    const cx = rect.x + this.botCx.value;
    const cy = rect.y + this.botCy.value;
    const radius = this.botSize.value / 2;
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
  }

  /**
   * Double-click on a Claude session's Mochi opens its chat. The open waits a beat
   * so a third click (dizzy) can still cancel it.
   */
  private onBotClick() {
    const t = performance.now();
    if (this.openChatTimer != null) {
      window.clearTimeout(this.openChatTimer);
      this.openChatTimer = null;
      this.lastBotClickAt = 0;
      return;
    }
    if (t - this.lastBotClickAt < DOUBLE_CLICK_MS) {
      this.lastBotClickAt = 0;
      this.openChatTimer = window.setTimeout(() => {
        this.openChatTimer = null;
        const task = State.focusTask;
        if (task?.source !== "claudeCode" || !task.sessionId) return;
        void Bridge.openSession(task.sessionCwd ?? null, task.hostSessionId ?? null);
        this.collapse();
      }, DOUBLE_CLICK_MS);
      return;
    }
    this.lastBotClickAt = t;
  }

  /** Three slaps → dizzy + confused view for 3.3 s, then back. */
  private handleDizzy() {
    this.prevViewBeforeConfused = State.view;
    State.stateOverride = "dizzy";
    this.engine.setState("dizzy");
    Sound.play("dizzy");
    this.alert("confused");
    if (this.confusedRecovery != null) window.clearTimeout(this.confusedRecovery);
    this.confusedRecovery = window.setTimeout(() => {
      this.confusedRecovery = null;
      State.stateOverride = null;
      this.engine.setState(State.effectiveState);
      if (State.view === "confused") {
        const fallback = State.defaultView();
        this.setView(this.prevViewBeforeConfused === "confused" ? fallback : this.prevViewBeforeConfused);
      }
      this.engine.triggerEmote("happy");
    }, 3300);
  }

  // ── Frame loop ──────────────────────────────────────────────────────────────

  /** The stage Mochi celebrates: confetti, a hop and the proud sound. */
  celebrate() {
    if (State.mode === "hidden") return;
    this.engine.celebrate(State.focusTask?.color);
    Sound.play("proud");
    this.ensureRunning();
  }

  /** A long turn finished off stage; the first time that session is on stage, it celebrates. */
  private celebratePendingIfFocused() {
    const t = State.focusTask;
    if (!t?.celebratePending || State.mode === "hidden") return;
    t.celebratePending = false;
    this.celebrate();
  }

  /**
   * One wake-up timer for the next idle fidget. Armed only while the island is
   * shown and the stage is idle (engine.fidgetDueAt is null otherwise); always
   * replaces the previous timer, so a hide or state change leaves none behind.
   */
  private syncFidgetTimer() {
    if (this.fidgetTimer != null) {
      window.clearTimeout(this.fidgetTimer);
      this.fidgetTimer = null;
    }
    const due = this.engine.fidgetDueAt;
    if (due == null || State.mode === "hidden") return;
    const wait = Math.max(0, due * 1000 - performance.now()) + 5;
    this.fidgetTimer = window.setTimeout(() => {
      this.fidgetTimer = null;
      if (State.mode !== "hidden") this.ensureRunning();
    }, wait);
  }

  /** Dev: plays one fidget now (window.__coucouFidget). */
  triggerFidget() {
    this.engine.triggerFidget();
    this.ensureRunning();
  }

  ensureRunning() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  private frame = (nowMs: number) => {
    const dt = Math.min(0.05, (nowMs - this.lastFrame) / 1000);
    this.lastFrame = nowMs;

    this.width.step(dt, nowMs);
    this.height.step(dt, nowMs);
    this.radius.step(dt, nowMs);
    this.applyGeometry();

    if (this.dirty) {
      this.dirty = false;
      this.syncDom();
    }

    this.syncDrill(nowMs);
    this.updateBotTargets();
    this.botCx.step(dt);
    this.botCy.step(dt);
    this.botSize.step(dt);
    this.slide.step(dt);
    this.bump.step(dt);
    this.fly.step(dt);
    if (this.fly.settled && this.fly.value !== this.fly.target) {
      this.fly.value = this.fly.target;
      this.fly.velocity = 0;
      this.slideDirty = true;
    }
    this.applySlide();
    this.applyFlyer();

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    if (greetingActive) {
      const gctx = this.greetingCanvas.getContext("2d");
      if (gctx) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        // Follow a pixel ratio change after a move to another display.
        const gw = Math.round(EXPANDED_W * dpr);
        if (this.greetingCanvas.width !== gw) {
          this.greetingCanvas.width = gw;
          this.greetingCanvas.height = Math.round(150 * dpr);
        }
        gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.greeting.draw(gctx);
      }
    } else {
      // Kept running even while the drop canvas is up, so the island's own Mochi
      // is already in the right place the moment the canvas fades out.
      this.drawBot(dt);
    }

    const uploadActive = this.uploadActive;
    if (uploadActive) this.uploadCanvas.draw(UploadSeq.frame(), nowMs / 1000);
    this.uploadCanvas.el.classList.toggle("on", uploadActive);
    this.viewsEl.classList.toggle("hidden-by-upload", uploadActive);

    tickMiniBots(dt);
    this.views.get(State.view)?.tick?.(nowMs);
    if (UploadSeq.isActive) this.stepSequence();
    this.updateCountdown(nowMs);

    // Nothing is drawn while the island is hidden, so nothing may keep the loop
    // alive either. This used to read `... || this.engine.busy || State.mode !==
    // "hidden"`, and engine.busy is permanently true for any state with a
    // looping animation — breathing, ratelimit sweat, sleeping z's, the search
    // sweep — so a hidden island went on burning frames in exactly the states it
    // spends most of its life in. Geometry still has to finish retracting.
    // Idle fidgets obey the same rule: engine.busy is true only while one is
    // playing. Between fidgets nothing runs; a single setTimeout (syncFidgetTimer,
    // armed when the loop stops and on state changes, never while hidden or
    // outside idle) calls ensureRunning() at the due time. No intervals, no RAF.
    const settling =
      this.width.animating || this.height.animating || this.radius.animating;
    const busy = State.mode === "hidden"
      ? settling
      : settling ||
        !this.botCx.settled || !this.botCy.settled || !this.botSize.settled ||
        this.sliding || !this.bump.settled ||
        !this.fly.settled || this.finishingAt != null || this.minisRunning() ||
        greetingActive || this.engine.busy || UploadSeq.isActive;

    if (busy) {
      requestAnimationFrame(this.frame);
    } else {
      this.running = false;
      Sound.idle();
      this.syncFidgetTimer();
    }
  };

  // ── Carousel ────────────────────────────────────────────────────────────────

  /** Wheel notch: next / previous agent, or a small bounce at either end. */
  private stepFocus(dir: Dir) {
    // In a subagent view the wheel backs out first; it never switches agent on that notch.
    if (State.drillAgentId) {
      this.drillOut();
      return;
    }
    const cur = State.tasks.findIndex((t) => t.id === State.focusTask?.id);
    const r = stepIndex(cur, dir, State.tasks.length);
    if (r.bounce) {
      this.bump.value = -dir * BUMP_PX;
      this.bump.target = 0;
      this.bump.velocity = 0;
      this.ensureRunning();
      return;
    }
    State.setFocus(State.tasks[r.index].id);
    Sound.play("blip");
  }

  /**
   * Runs on every State change, before the next frame redraws the bot: when the
   * focus moved while the overview is on screen, the canvas still holds the old
   * agent's last frame, so it becomes the outgoing snapshot.
   */
  private noteFocus() {
    const id = State.focusTask?.id ?? null;
    if (id === this.lastFocusId) return;
    const prev = this.lastFocusId;
    this.lastFocusId = id;
    if (prev == null || id == null) return;
    if (State.mode !== "expanded" || State.view !== "overview" || this.uploadActive) return;

    const src = this.botCanvas;
    const snap = this.snapCanvas;
    snap.width = src.width;
    snap.height = src.height;
    snap.style.width = src.style.width;
    snap.style.height = src.style.height;
    snap.style.left = src.style.left;
    snap.style.top = src.style.top;
    snap.getContext("2d")?.drawImage(src, 0, 0);
    snap.style.display = "block";

    this.slideDir = State.focusDir;
    this.slide.value = 0;
    this.slide.target = 1;
    this.slide.velocity = 0;
    this.sliding = true;
    this.slideDirty = true;
  }

  /** Applies the slide / bounce offsets to the bot layer; cleans up when settled. */
  private applySlide() {
    const overview = State.mode === "expanded" && State.view === "overview";
    if (this.sliding && (!overview || this.slide.settled)) {
      this.sliding = false;
      this.slideDirty = true;
      this.slide.set(1);
    }
    const bumping = !this.bump.settled;
    const flying = !this.fly.settled || this.fly.value !== 0;
    if (!this.sliding && !bumping && !this.slideDirty && !flying) return;
    // The parent's Mochi glides up and out while a subagent's takes the stage.
    const flyDy = -clamp(this.fly.value, 0, 1.2) * SLIDE_D;

    const live = this.botCanvas.style;
    const glow = this.botGlow.style;
    if (this.sliding) {
      const p = this.slide.value;
      const dy = (1 - p) * this.slideDir * SLIDE_D + this.bump.value + flyDy;
      live.transform = glow.transform = `translateY(${dy}px)`;
      this.snapCanvas.style.transform = `translateY(${-p * this.slideDir * SLIDE_D}px)`;
      this.snapCanvas.style.opacity = String(clamp(1 - p * 1.4, 0, 1));
      // Clip to the stage so the bot never slides over the header or the panel.
      const right = this.width.value - STAGE.left - STAGE.w;
      this.botLayer.style.clipPath = `inset(${STAGE.top}px ${right}px ${STAGE.bottomInset}px ${STAGE.left}px round 20px)`;
    } else {
      const dy = (overview ? this.bump.value : 0) + flyDy;
      live.transform = glow.transform = dy ? `translateY(${dy}px)` : "";
      this.snapCanvas.style.display = "none";
      this.botLayer.style.clipPath = "";
      if (!bumping) this.bump.set(0);
    }
    this.slideDirty = false;
  }

  // ── Subagent drill-in ───────────────────────────────────────────────────────

  /** The row's mini Mochis (or the flyer) are on screen and must keep animating. */
  private minisRunning(): boolean {
    if (State.mode !== "expanded" || State.view !== "overview") return false;
    return this.flyer != null || (State.focusTask?.subagents?.length ?? 0) > 0;
  }

  /** Click on a mini Mochi: it grows and glides to the stage while the panel slides. */
  private drillIn(agentId: string, slot: HTMLElement) {
    if (State.drillAgentId) return;
    const r = slot.getBoundingClientRect();
    const ir = this.islandEl.getBoundingClientRect();
    this.flyFrom = { cx: r.left + r.width / 2 - ir.left, cy: r.top + r.height / 2 - ir.top, size: r.width };
    this.flyer = { el: h("div", { id: "bot-flyer" }), agentId };
    // Hidden now, so the panel's outgoing copy does not show it twice.
    slot.style.visibility = "hidden";
    this.animatedExit = false;
    State.drillAgentId = agentId;
    Sound.play("blip");
    State.notify();
  }

  /** Back arrow, wheel over the stage, or the end of the done tick. */
  private drillOut() {
    if (!State.drillAgentId) return;
    this.animatedExit = true;
    State.drillAgentId = null;
    Sound.play("blip");
    State.notify();
  }

  /** The mini Mochi of this subagent in the row, when the row is on screen. */
  private rowSlot(agentId: string): HTMLElement | null {
    return this.islandEl.querySelector<HTMLElement>(`.cl-sub[data-agent="${agentId}"] .mini`);
  }

  private clearFlyer() {
    if (this.flyer) {
      const slot = this.rowSlot(this.flyer.agentId);
      if (slot) slot.style.visibility = "";
      this.flyer.el.remove();
    }
    this.flyer = null;
    this.slideDirty = true;
  }

  /**
   * Follows State.drillAgentId (set by the click, the back arrow, a focus change...).
   * Leaving for any reason but the back arrow / finish is instant.
   */
  private syncDrill(nowMs: number) {
    // A takeover (approval, question), a collapse or another screen ends the view at once.
    if (State.drillAgentId && (State.mode !== "expanded" || State.view !== "overview")) {
      State.drillAgentId = null;
      this.animatedExit = false;
    }
    const id = State.drillAgentId;
    const task = State.focusTask;
    const sub = task?.subagents?.find((x) => x.agentId === id) ?? null;

    if (id !== this.drillId) {
      this.drillId = id;
      this.finishingAt = null;
      if (id && this.flyer) {
        // Entering: the flyer is a body-size Mochi scaled down to the mini, so it stays sharp when it grows.
        const bodyD = VIEW_LAYOUTS.overview.botDiameter;
        const fl = this.flyer;
        fl.el.replaceChildren(
          createMiniBot(
            { id: `fly_${id}`, name: "", color: task?.color ?? "#D97757", state: "working",
              stepIndex: 0, steps: [], source: "claudeCode", isIntegration: false },
            bodyD,
          ),
        );
        this.botLayer.append(fl.el);
        this.fly.target = 1;
      } else if (id) {
        State.drillAgentId = null; // not a click we know how to animate
        this.drillId = null;
      } else if (this.animatedExit && this.flyer) {
        this.fly.target = 0;
      } else {
        this.fly.set(0);
        this.clearFlyer();
      }
      this.animatedExit = false;
    }

    // The viewed subagent finished: brief done tick, then glide back out.
    if (id && !sub && this.flyer && this.finishingAt == null) {
      this.finishingAt = nowMs + DONE_TICK_MS;
      const mini = this.flyer.el.firstElementChild as HTMLElement | null;
      if (mini) emoteMiniBot(mini, "happy", 1.2);
      this.flyer.el.append(h("span", { class: "fly-tick" }, svg(ICONS.check, 12, { stroke: 3 })));
      Sound.play("approve");
      State.notify(); // the panel and name switch to the finished view
    }
    if (this.finishingAt != null && nowMs >= this.finishingAt) {
      this.finishingAt = null;
      this.drillOut();
    }

    // Glide finished (back at the row): the flyer has done its job.
    if (!id && this.flyer && this.fly.settled && this.fly.target === 0) this.clearFlyer();
  }

  /** Places the flyer between the mini Mochi's spot (0) and the stage (1). */
  private applyFlyer() {
    const fl = this.flyer;
    if (!fl) return;
    const bodyD = VIEW_LAYOUTS.overview.botDiameter;
    const p = this.fly.value;
    // Back out: aim at the mini's live spot (the panel is still sliding in); when it
    // is gone (the subagent finished), shrink and fade at the old spot instead.
    let from = this.flyFrom;
    let present = 1;
    const slot = this.rowSlot(fl.agentId);
    if (slot) {
      if (!State.drillAgentId) slot.style.visibility = "hidden";
      const r = slot.getBoundingClientRect();
      const ir = this.islandEl.getBoundingClientRect();
      if (r.width > 0) {
        from = { cx: r.left + r.width / 2 - ir.left, cy: r.top + r.height / 2 - ir.top, size: r.width };
        this.flyFrom = from;
      }
    } else if (!State.drillAgentId) {
      present = clamp(p * 1.5, 0, 1);
    }
    const cx = from.cx + (this.botCx.value - from.cx) * p;
    const cy = from.cy + (this.botCy.value - from.cy) * p;
    const size = from.size + (bodyD - from.size) * p;
    const st = fl.el.style;
    st.transform = `translate(${cx - bodyD / 2}px, ${cy - bodyD / 2}px) scale(${Math.max(0.05, size / bodyD)})`;
    st.opacity = String(present);
  }

  private updateBotTargets() {
    const p = botPosition(State.mode, State.view, this.height.value, State.uploadProgress);
    this.botCx.target = p.cx;
    this.botCy.target = p.cy;
    this.botSize.target = p.diameter / 0.6;

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    // The drop canvas draws its own Mochi; two of them would overlap.
    const visible = p.opacity > 0 && !greetingActive && !this.uploadActive;
    // The parent's Mochi leaves as the subagent's arrives (fly 0 -> 1).
    const away = clamp(1 - this.fly.value * 1.4, 0, 1);
    this.botCanvas.style.opacity = visible
      ? String((this.sliding ? clamp(this.slide.value, 0, 1) : 1) * away)
      : "0";

    if (State.mode === "expanded" && State.view !== "uploading" && !greetingActive && !this.uploadActive) {
      const d = p.diameter;
      // Busy states glow in the agent's own colour; alerts keep their signal colours.
      const st = State.effectiveState;
      const busy = st === "working" || st === "thinking" || st === "searching";
      const color = busy && State.focusTask?.color ? State.focusTask.color : botGlowColor(st);
      this.botGlow.style.display = "block";
      this.botGlow.style.width = `${d * 2.2}px`;
      this.botGlow.style.height = `${d * 2.2}px`;
      this.botGlow.style.left = `${this.botCx.value - d * 1.1}px`;
      this.botGlow.style.top = `${this.botCy.value - d * 1.1}px`;
      this.botGlow.style.background = `radial-gradient(circle, ${color} 0%, transparent 62%)`;
      this.botGlow.style.opacity = String(botGlowOpacity(State.effectiveState) * away);
    } else {
      this.botGlow.style.display = "none";
    }
  }

  private drawBot(dt: number) {
    const size = this.botSize.value;
    const w = Math.max(1, Math.round(size));
    const wCss = w + BOT_FX_PAD * 2;
    const hCss = w + BOT_OVERHANG + BOT_FX_PAD * 2;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvasPx !== w || this.canvasDpr !== dpr) {
      this.canvasPx = w;
      this.canvasDpr = dpr;
      this.botCanvas.width = Math.round(wCss * dpr);
      this.botCanvas.height = Math.round(hCss * dpr);
      this.botCanvas.style.width = `${wCss}px`;
      this.botCanvas.style.height = `${hCss}px`;
    }
    this.botCanvas.style.left = `${this.botCx.value - wCss / 2}px`;
    this.botCanvas.style.top = `${this.botCy.value - BOT_OVERHANG / 2 - hCss / 2}px`;

    const ctx = this.botCanvas.getContext("2d");
    if (!ctx) return;

    const focus = State.focusTask;
    this.engine.bodyColor = focus?.isIntegration ? hexToRGB(focus.color) : null;
    this.engine.setAccessory(focus?.isIntegration ? focus.accessory ?? null : null);
    this.engine.particleOverhang = BOT_OVERHANG;
    this.engine.setActivity(State.activityOverride ?? focus?.toolAnim ?? null);
    this.engine.lookX = this.lookX();
    this.engine.lookY = this.lookY();
    if (this.engine.morph > 0.3) {
      this.engine.slotHTarget = State.fileDragOver ? 0.2 : 0;
    } else {
      this.engine.slotHTarget = 0;
      if (this.engine.morph < 0.05) {
        this.engine.slotH = 0;
        this.engine.slotHVel = 0;
      }
    }
    this.engine.update(dt);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, wCss, hCss);
    this.engine.draw(ctx, wCss, hCss, w);
  }

  /** BotCanvasView.lookX / lookY — tanh of the distance to the bot. */
  private lookX(): number {
    const rect = this.islandRect();
    const botScreenX = rect.x + this.botCx.value;
    return Math.tanh((State.mouse.x - botScreenX) / 260);
  }

  private lookY(): number {
    return -Math.tanh((State.mouse.y - this.botCy.value) / 200);
  }

  private updateCountdown(nowMs: number) {
    if (State.mode !== "expanded" || State.isPinned || this.homeCollapseAt == null) {
      this.countdown.style.width = "0px";
      return;
    }
    const autoClose = this.fsm.homeToPetitDelay;
    const windowS = Math.min(10, autoClose * 0.6);
    const remaining = (this.homeCollapseAt - nowMs) / 1000;
    this.countdown.style.width =
      remaining < windowS ? `${Math.max(0, clamp(remaining / windowS, 0, 1) * 160)}px` : "0px";
  }

  // ── DOM sync ────────────────────────────────────────────────────────────────

  private syncDom() {
    const expanded = State.mode === "expanded";
    const greetingActive = expanded && State.view === "greeting";

    this.contentEl.style.opacity = expanded && !greetingActive ? "1" : "0";
    this.contentEl.style.pointerEvents = expanded && !greetingActive ? "auto" : "none";
    this.greetingCanvas.style.display = greetingActive ? "block" : "none";

    this.header.sync();
    for (const [name, view] of this.views) {
      const on = name === State.view;
      if (!on && view.el.classList.contains("on")) view.leave?.();
      view.el.classList.toggle("on", on);
      if (on) view.sync();
    }

    // The chat is the only view with a text field, so it is the only time the
    // island is allowed to take keyboard focus.
    if (this.lastSyncedView !== State.view) {
      const wasChat = this.lastSyncedView === "prompt";
      this.lastSyncedView = State.view;
      if (State.view === "prompt") {
        void Bridge.focusWindow(true);
        window.setTimeout(() => this.views.get("prompt")?.focus?.(), 120);
      } else if (wasChat) {
        void Bridge.focusWindow(false);
      }
    }

    // Compact mini grid
    const showGrid = State.mode === "compact";
    this.miniGrid.style.opacity = showGrid ? "1" : "0";
    if (showGrid) {
      const others = State.otherTasks.slice(0, 4);
      const key = others.map((t) => t.id).join("|");
      if (this.miniGrid.dataset.key !== key) {
        this.miniGrid.dataset.key = key;
        this.miniGrid.replaceChildren();
        for (const t of others) {
          this.miniGrid.append(createMiniBot(t, 13));
        }
        pruneMiniBots();
      }
    }

    // Rebuilt panels leave their old mini Mochis behind; stop ticking those.
    pruneMiniBots();
    syncMiniBotStates(State.tasks);
    this.engine.setState(State.effectiveState);
    this.syncFidgetTimer(); // cleared when the state left idle, re-armed (fresh gap) when it entered it
  }

  /** Applies settings coming from Rust at boot. */
  applySettings() {
    Sound.setEnabled(State.settings.soundEnabled);
    Sound.setVolume(State.settings.soundVolume);
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    State.notify();
  }

  get panelSize() {
    return { w: PANEL_W, h: PANEL_H };
  }

  get chatHeight() {
    return chatPromptHeight(State.chatHistory.length);
  }
}
