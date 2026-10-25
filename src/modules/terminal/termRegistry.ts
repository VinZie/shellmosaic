// xterm.js instances live outside React so they survive layout changes: a pane
// component only lends its DOM node; the terminal (and its PTY attachment) stays.
import { Channel } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ITerminalOptions } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { errorText, ipc, type PtyMessage } from "../../lib/ipc";
import { getState, useModel } from "../../state/store";
import { spawnSpec } from "../../state/profiles";
import { settings, useSettings } from "../../state/settings";
import { activeTheme, findTheme, useThemes, xtermTheme } from "../../state/themes";
import { ui } from "../../state/ui";
import { leaves } from "../../state/layout";
import { tabOfPane, windowOfWorkspace, workspaceOfTab, type Pane } from "../../state/model";

export interface TermEntry {
  paneId: string;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  host: HTMLDivElement;
  opened: boolean;
  webgl?: WebglAddon;
  token: number | null;
  attaching: boolean;
  suppress: boolean;
  alive: boolean;
  visible: boolean;
  lastSize: { cols: number; rows: number };
  ro: ResizeObserver;
  fitTimer?: ReturnType<typeof setTimeout>;
}

const entries = new Map<string, TermEntry>();

export const getTerm = (paneId: string) => entries.get(paneId);
export const allTerms = () => [...entries.values()];

function paneOf(paneId: string): Pane | undefined {
  return getState().model.panes[paneId];
}

/** The saved SSH host a terminal pane connects to (none: a local shell). */
export function sshHostOf(pane: Pane | undefined): string | null {
  const id = pane?.meta.ssh;
  return typeof id === "string" && id ? id : null;
}

function options(pane: Pane | undefined): ITerminalOptions {
  const s = settings();
  const t = s.terminal;
  const theme = pane?.meta.theme ? findTheme(pane.meta.theme) : activeTheme(s);
  return {
    fontFamily: t.fontFamily,
    fontSize: pane?.meta.fontSize ?? t.fontSize,
    lineHeight: t.lineHeight,
    letterSpacing: t.letterSpacing,
    fontWeight: t.fontWeight as ITerminalOptions["fontWeight"],
    fontWeightBold: t.fontWeightBold as ITerminalOptions["fontWeightBold"],
    cursorStyle: t.cursorStyle,
    cursorBlink: t.cursorBlink,
    cursorInactiveStyle: "outline",
    scrollback: t.scrollback,
    minimumContrastRatio: t.minimumContrastRatio,
    drawBoldTextInBrightColors: t.drawBoldTextInBrightColors,
    theme: xtermTheme(theme, s),
    allowTransparency: true,
    allowProposedApi: true,
    rightClickSelectsWord: false,
    // ConPTY reflow hints; a remote shell's output doesn't come through ConPTY
    ...(sshHostOf(pane) ? {} : { windowsPty: { backend: "conpty", buildNumber: 22621 } as const }),
  };
}

function scheduleFit(e: TermEntry, delay = 30) {
  clearTimeout(e.fitTimer);
  e.fitTimer = setTimeout(() => fitNow(e), delay);
}

function fitNow(e: TermEntry) {
  openIfVisible(e);
  if (!e.opened || !e.host.isConnected || e.host.clientWidth < 20 || e.host.clientHeight < 20) return;
  try {
    e.fit.fit();
  } catch {
    return;
  }
  const { cols, rows } = e.term;
  if (cols !== e.lastSize.cols || rows !== e.lastSize.rows) {
    e.lastSize = { cols, rows };
    if (e.token !== null) ipc.ptyResize(e.paneId, cols, rows).catch(() => {});
  }
}

let bellCtx: AudioContext | null = null;
function beep() {
  try {
    bellCtx ??= new AudioContext();
    const osc = bellCtx.createOscillator();
    const gain = bellCtx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.08, bellCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, bellCtx.currentTime + 0.15);
    osc.connect(gain).connect(bellCtx.destination);
    osc.start();
    osc.stop(bellCtx.currentTime + 0.16);
  } catch {
    /* audio unavailable */
  }
}

export async function copySelection(e: TermEntry): Promise<boolean> {
  let text = e.term.getSelection();
  if (!text) return false;
  if (settings().terminal.trimSelection) text = text.split("\n").map((l) => l.replace(/\s+$/, "")).join("\n");
  await writeText(text);
  return true;
}

export async function pasteInto(e: TermEntry, text?: string | null) {
  const value = text ?? (await readText().catch(() => ""));
  if (!value) return;
  if (settings().terminal.confirmMultilinePaste && /\r|\n/.test(value.trim())) {
    const lines = value.split(/\r?\n/);
    const ok = await ui.confirm(
      "Paste multiple lines?",
      `You're pasting ${lines.length} lines. Each line may run as a separate command.\n\n${lines.slice(0, 8).join("\n")}${lines.length > 8 ? "\n…" : ""}`,
      { okLabel: "Paste" },
    );
    if (!ok) return;
  }
  e.term.paste(value);
  e.term.focus();
}

/** Get (or create) the terminal for a pane. It starts its shell once mounted. */
export function ensureTerm(paneId: string): TermEntry {
  let e = entries.get(paneId);
  if (e) return e;
  const onLink = (ev: MouseEvent, uri: string) => {
    ev.preventDefault();
    if (!ev.ctrlKey && !ev.metaKey) {
      ui.toast("Ctrl+click to open links", "info", 1800);
      return;
    }
    linkHandler(uri, paneId);
  };
  // OSC 8 hyperlinks go through the same handler (xterm's default is confirm() + window.open)
  const term = new Terminal({ ...options(paneOf(paneId)), linkHandler: { activate: onLink } });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.loadAddon(new WebLinksAddon(onLink));

  const host = document.createElement("div");
  host.className = "term-host";
  const ro = new ResizeObserver(() => e && scheduleFit(e));
  ro.observe(host);

  e = {
    paneId,
    term,
    fit,
    search,
    host,
    opened: false,
    token: null,
    attaching: false,
    suppress: false,
    alive: true,
    visible: false,
    lastSize: { cols: 0, rows: 0 },
    ro,
  };
  const entry = e;
  entries.set(paneId, entry);

  term.onData((data) => {
    if (entry.suppress) return;
    if (!entry.alive) {
      if (data.includes("\r")) restartTerm(paneId);
      return;
    }
    sendInput(paneId, data);
  });

  term.onBell(() => {
    const mode = settings().terminal.bell;
    if (mode === "visual" || mode === "both") {
      host.classList.remove("bell-flash");
      void host.offsetWidth;
      host.classList.add("bell-flash");
    }
    if (mode === "sound" || mode === "both") beep();
    if (!entry.visible || !document.hasFocus()) ui.setBadge(paneId, "bell");
  });

  term.onSelectionChange(() => {
    if (settings().terminal.copyOnSelect && term.hasSelection()) copySelection(entry).catch(() => {});
  });

  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== "keydown") return true;
    const t = settings().terminal;
    if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === "c" && t.ctrlCCopies && term.hasSelection()) {
      copySelection(entry).then(() => term.clearSelection());
      return false;
    }
    if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === "v" && t.ctrlVPastes) {
      return false; // the browser's paste event delivers the text (see paste listener)
    }
    return true;
  });

  host.addEventListener(
    "paste",
    (ev) => {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      pasteInto(entry, ev.clipboardData?.getData("text/plain") ?? "");
    },
    true,
  );

  return entry;
}

function linkHandler(uri: string, paneId: string) {
  if (settings().terminal.links === "webPane") {
    import("../../state/actions").then((a) => a.openWebPane(uri, paneId));
  } else {
    import("@tauri-apps/plugin-opener").then((o) => o.openUrl(uri)).catch((err) => ui.toast(errorText(err), "error"));
  }
}

/** Input from the user; mirrored to every terminal in the tab when broadcast is on. */
function sendInput(paneId: string, data: string) {
  const broadcast = ui.get().broadcast;
  if (Object.values(broadcast).some(Boolean)) {
    const tab = tabOfPane(getState().model, paneId);
    if (tab && broadcast[tab.id]) {
      for (const id of leaves(tab.root)) {
        const other = entries.get(id);
        if (other?.alive && other.token !== null) ipc.ptyWrite(id, data).catch(() => {});
      }
      return;
    }
  }
  ipc.ptyWrite(paneId, data).catch(() => {});
}

/** Move the terminal's element into a pane's container and start the shell if needed. */
export function mountTerm(paneId: string, container: HTMLElement) {
  const e = ensureTerm(paneId);
  if (e.host.parentElement !== container) container.appendChild(e.host);
  openIfVisible(e);
  fitNow(e);
  // the shell starts even in a hidden tab; xterm buffers output until it's opened
  if (e.token === null && !e.attaching) startPty(e, true);
}

/** xterm measures its font on open, which fails inside display:none — so open lazily. */
function openIfVisible(e: TermEntry) {
  if (e.opened || !e.host.isConnected || e.host.offsetParent === null) return;
  e.term.open(e.host);
  e.opened = true;
  if (settings().terminal.webgl) loadWebgl(e);
}

export function unmountTerm(paneId: string, container: HTMLElement) {
  const e = entries.get(paneId);
  if (e && e.host.parentElement === container) container.removeChild(e.host);
}

function loadWebgl(e: TermEntry) {
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      webgl.dispose();
      e.webgl = undefined;
    });
    e.term.loadAddon(webgl);
    e.webgl = webgl;
  } catch (err) {
    console.warn("WebGL renderer unavailable, using DOM renderer", err);
  }
}

async function startPty(e: TermEntry, restore: boolean) {
  const pane = paneOf(e.paneId);
  if (!pane) return;
  e.attaching = true;
  const channel = new Channel<PtyMessage>();
  channel.onmessage = (msg) => {
    // disposed (pane closed or handed to another window) until the detach lands
    if (entries.get(e.paneId) !== e) return;
    if (msg instanceof ArrayBuffer) return onOutput(e, new Uint8Array(msg));
    if (msg instanceof Uint8Array) return onOutput(e, msg);
    if (Array.isArray(msg)) return onOutput(e, Uint8Array.from(msg));
    switch (msg.t) {
      case "replay-start":
        e.suppress = true;
        break;
      case "replay-end":
        // responses to queries inside the replay (e.g. cursor position) must not reach the shell
        e.term.write("", () => {
          e.suppress = false;
        });
        break;
      case "exit":
        onExit(e, msg.code ?? null);
        break;
    }
  };
  if (!e.lastSize.cols) {
    fitNow(e);
  }
  const cols = e.term.cols || 80;
  const rows = e.term.rows || 24;
  const ssh = sshHostOf(pane);
  try {
    const spec = { ...spawnSpec(pane.meta.profile, pane.meta.cwd, restore), ssh };
    const info = await ipc.ptyAttach(e.paneId, spec, cols, rows, channel);
    // disposed meanwhile (maybe already replaced by a new entry for the same pane)
    if (entries.get(e.paneId) !== e) {
      ipc.ptyDetach(e.paneId, info.token).catch(() => {});
      return;
    }
    e.token = info.token;
    e.alive = info.alive;
    e.lastSize = { cols, rows };
    if (info.cwd) ui.setCwd(e.paneId, info.cwd);
    fitNow(e);
    // a pane created to run something ("run task", plugin terminal.run) types it once
    const run = pane.meta.run as string | undefined;
    if (info.spawned && run) {
      setTimeout(() => ipc.ptyWrite(e.paneId, run + "\r").catch(() => {}), 350);
      import("../../state/actions").then((a) => a.setPaneMeta(e.paneId, { run: null }));
    }
  } catch (err) {
    if (ssh) {
      e.term.write(`\r\n\x1b[31mCould not connect: ${errorText(err)}\x1b[0m\r\n`);
      e.term.write(`\x1b[2mPress Enter to retry.\x1b[0m\r\n`);
    } else {
      e.term.write(`\r\n\x1b[31mCould not start the shell: ${errorText(err)}\x1b[0m\r\n`);
      e.term.write(`\x1b[2mCheck the profile in Settings → Profiles. Press Enter to retry.\x1b[0m\r\n`);
    }
    e.alive = false;
  } finally {
    e.attaching = false;
  }
}

function onOutput(e: TermEntry, data: Uint8Array) {
  e.term.write(data);
  if (!e.visible && !e.suppress) ui.setBadge(e.paneId, "activity");
}

function onExit(e: TermEntry, code: number | null) {
  if (!e.alive && e.token === null) return;
  e.alive = false;
  if (sshHostOf(paneOf(e.paneId))) {
    e.term.write(`\r\n\x1b[2m[connection closed — press Enter to reconnect]\x1b[0m\r\n`);
  } else {
    const codeText = code === null ? "" : ` with code ${code}`;
    e.term.write(`\r\n\x1b[2m[process exited${codeText} — press Enter to restart]\x1b[0m\r\n`);
  }
  if (code && code !== 0) ui.setBadge(e.paneId, "error");
  else if (!e.visible) ui.setBadge(e.paneId, "done");
}

export async function restartTerm(paneId: string) {
  const e = entries.get(paneId);
  if (!e || e.attaching) return;
  // block a second restart (Enter pressed again, remount) while the old shell is being killed
  e.attaching = true;
  await ipc.ptyKill(paneId, false).catch(() => {});
  e.attaching = false;
  // closed or handed to another window meanwhile: don't spawn a shell for a disposed terminal
  if (entries.get(paneId) !== e) return;
  e.token = null;
  e.alive = true;
  e.term.write("\r\n");
  await startPty(e, false);
}

/** Free the xterm instance. The shell keeps running unless the pane is gone. */
export function disposeTerm(paneId: string) {
  const e = entries.get(paneId);
  if (!e) return;
  entries.delete(paneId);
  if (e.token !== null) ipc.ptyDetach(paneId, e.token).catch(() => {});
  e.ro.disconnect();
  e.host.remove();
  e.term.dispose();
}

export function setTermVisible(paneId: string, visible: boolean) {
  const e = entries.get(paneId);
  if (!e) return;
  e.visible = visible;
  if (visible) {
    ui.setBadge(paneId, null);
    // wait a frame so the tab's display:none is gone before measuring
    requestAnimationFrame(() => {
      openIfVisible(e);
      fitNow(e);
    });
  }
}

export function focusTerm(paneId: string) {
  entries.get(paneId)?.term.focus();
}

/** Write text into a terminal's input as if typed. */
export function typeInto(paneId: string, text: string) {
  return ipc.ptyWrite(paneId, text);
}

export function refitAll() {
  entries.forEach((e) => scheduleFit(e, 10));
}

// WebGL is (re)loaded when the setting gets turned on, not on every reapply: Chromium keeps ~16
// contexts per page, so reloading terminals that lost theirs would evict others' in a cascade
let webglOn = settings().terminal.webgl;

function reapplyOptions() {
  const turnedOn = settings().terminal.webgl && !webglOn;
  webglOn = settings().terminal.webgl;
  for (const e of entries.values()) {
    const opts = options(paneOf(e.paneId));
    for (const [k, v] of Object.entries(opts)) {
      if (k === "windowsPty" || k === "allowProposedApi") continue;
      // an equal but new theme object would still repaint the terminal and rebuild its glyph atlas
      // (this runs for every terminal on any settings change and whenever a terminal comes or goes)
      if (k === "theme" && JSON.stringify(e.term.options.theme) === JSON.stringify(v)) continue;
      (e.term.options as Record<string, unknown>)[k] = v;
    }
    if (turnedOn && !e.webgl && e.opened) loadWebgl(e);
    if (!settings().terminal.webgl && e.webgl) {
      e.webgl.dispose();
      e.webgl = undefined;
    }
    scheduleFit(e, 20);
  }
}

// live-apply settings, theme and per-pane overrides
useSettings.subscribe(reapplyOptions);
useThemes.subscribe(reapplyOptions);
let lastPaneMeta = "";
useModel.subscribe((s) => {
  // hand terminals over when their workspace is shown by another window (or they're gone)
  for (const id of [...entries.keys()]) {
    const pane = s.model.panes[id];
    if (!pane || pane.module !== "terminal") {
      disposeTerm(id);
      continue;
    }
    const tab = tabOfPane(s.model, id);
    const ws = tab ? workspaceOfTab(s.model, tab.id) : undefined;
    const owner = ws ? windowOfWorkspace(s.model, ws.id) : undefined;
    if (owner && owner !== s.label) disposeTerm(id);
  }
  const sig = [...entries.keys()].map((id) => `${id}:${s.model.panes[id]?.meta.fontSize}:${s.model.panes[id]?.meta.theme}`).join("|");
  if (sig !== lastPaneMeta) {
    lastPaneMeta = sig;
    reapplyOptions();
  }
});
