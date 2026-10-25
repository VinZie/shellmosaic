import { useEffect, useRef, useState } from "react";
import { Icon } from "../../lib/icons";
import { cx } from "../../lib/util";
import { ipc } from "../../lib/ipc";
import { terminalMenu } from "../../state/menus";
import { settings } from "../../state/settings";
import { ui, useUi } from "../../state/ui";
import type { ModuleDef, ModuleProps } from "../registry";
import { copySelection, disposeTerm, focusTerm, getTerm, mountTerm, pasteInto, restartTerm, setTermVisible, sshHostOf, unmountTerm } from "./termRegistry";
import { basename } from "../../lib/util";
import { findProfile } from "../../state/profiles";
import { openSftp } from "../hosts/open";

function FindBar({ paneId }: { paneId: string }) {
  const [q, setQ] = useState("");
  const [opts, setOpts] = useState({ caseSensitive: false, regex: false, wholeWord: false });
  const [count, setCount] = useState<{ idx: number; total: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    const e = getTerm(paneId);
    if (!e) return;
    const sub = e.search.onDidChangeResults((r) => setCount({ idx: r.resultIndex + 1, total: r.resultCount }));
    return () => sub.dispose();
  }, [paneId]);
  const decorations = {
    matchBackground: "#f6b95855",
    activeMatchBackground: "#f6b958",
    matchOverviewRuler: "#f6b958",
    activeMatchColorOverviewRuler: "#ff8c42",
  };
  const find = (dir: 1 | -1, value = q) => {
    const e = getTerm(paneId);
    if (!e || !value) return;
    const o = { ...opts, decorations };
    if (dir === 1) e.search.findNext(value, o);
    else e.search.findPrevious(value, o);
  };
  const close = () => {
    getTerm(paneId)?.search.clearDecorations();
    ui.setFind(paneId, false);
    focusTerm(paneId);
  };
  return (
    <div className="find-bar" onPointerDown={(e) => e.stopPropagation()}>
      <Icon name="search" size={13} />
      <input
        ref={inputRef}
        value={q}
        placeholder="Find"
        onChange={(e) => {
          setQ(e.target.value);
          find(1, e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") find(e.shiftKey ? -1 : 1);
          if (e.key === "Escape") close();
          e.stopPropagation();
        }}
      />
      <span className="find-count">{q && count ? (count.total ? `${count.idx}/${count.total}` : "0") : ""}</span>
      <button className={cx("icon-btn", opts.caseSensitive && "on")} title="Match case" onClick={() => setOpts((o) => ({ ...o, caseSensitive: !o.caseSensitive }))}>
        <Icon name="case-sensitive" size={14} />
      </button>
      <button className={cx("icon-btn", opts.wholeWord && "on")} title="Whole word" onClick={() => setOpts((o) => ({ ...o, wholeWord: !o.wholeWord }))}>
        <Icon name="whole-word" size={14} />
      </button>
      <button className={cx("icon-btn", opts.regex && "on")} title="Regular expression" onClick={() => setOpts((o) => ({ ...o, regex: !o.regex }))}>
        <Icon name="regex" size={14} />
      </button>
      <button className="icon-btn" title="Previous (Shift+Enter)" onClick={() => find(-1)}>
        <Icon name="chevron-up" size={14} />
      </button>
      <button className="icon-btn" title="Next (Enter)" onClick={() => find(1)}>
        <Icon name="chevron-down" size={14} />
      </button>
      <button className="icon-btn" title="Close (Esc)" onClick={close}>
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

function TerminalPane({ pane, visible, focused }: ModuleProps) {
  const ref = useRef<HTMLDivElement>(null);
  const findOpen = useUi((s) => !!s.findOpen[pane.id]);

  useEffect(() => {
    const el = ref.current!;
    mountTerm(pane.id, el);
    return () => unmountTerm(pane.id, el);
  }, [pane.id]);

  useEffect(() => {
    setTermVisible(pane.id, visible);
    // unmounted (workspace switched, pane moved away): no longer on screen, so badges work again
    return () => setTermVisible(pane.id, false);
  }, [pane.id, visible]);

  useEffect(() => {
    if (focused && visible && !ui.get().dialog && !ui.get().palette.open) focusTerm(pane.id);
  }, [focused, visible, pane.id]);

  const onContextMenu = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const entry = getTerm(pane.id);
    const mode = settings().terminal.rightClick;
    if (entry && mode === "paste") return pasteInto(entry);
    if (entry && mode === "copyPaste") {
      if (entry.term.hasSelection()) {
        await copySelection(entry);
        entry.term.clearSelection();
      } else pasteInto(entry);
      return;
    }
    const at = { x: e.clientX, y: e.clientY };
    ui.openMenu(at, await terminalMenu(pane.id));
  };

  return (
    <div className="terminal-pane" onContextMenu={onContextMenu}>
      {findOpen && <FindBar paneId={pane.id} />}
      <div className="terminal-mount" ref={ref} />
    </div>
  );
}

function HeaderActions({ pane, tabId }: ModuleProps) {
  const broadcast = useUi((s) => !!s.broadcast[tabId]);
  return (
    <>
      {broadcast && <Icon name="radio" size={12} className="dim" />}
      <button className="icon-btn" title="Find (Ctrl+Shift+F)" onClick={() => ui.setFind(pane.id, true)}>
        <Icon name="search" size={13} />
      </button>
    </>
  );
}

export const terminalModule: ModuleDef = {
  id: "terminal",
  name: "Terminal",
  icon: "square-terminal",
  description: "A shell: PowerShell, cmd, Git Bash, WSL or your own profile",
  component: TerminalPane,
  headerActions: HeaderActions,
  title: (pane, rt) => {
    if (sshHostOf(pane)) {
      const name = typeof pane.meta.sshName === "string" && pane.meta.sshName ? pane.meta.sshName : "SSH";
      // (the remote shell's own title is usually "user@host: ~/dir")
      return rt.title ? `${name} (ssh) — ${rt.title}` : `${name} (ssh)`;
    }
    const profile = findProfile(pane.meta.profile);
    const where = rt.cwd ? basename(rt.cwd) || rt.cwd : "";
    if (rt.title && !/^(Windows PowerShell|PowerShell|Administrator:|C:\\|[A-Z]:\\)/.test(rt.title) && !rt.title.endsWith(".exe")) {
      return `${rt.title}${where ? ` — ${where}` : ""}`;
    }
    return `${profile?.name ?? "Terminal"}${where ? ` — ${rt.cwd}` : ""}`;
  },
  menu: (pane, tabId) => {
    const host = sshHostOf(pane);
    if (!host) return [];
    return [
      { label: "Reconnect", icon: "rotate-cw", onSelect: () => restartTerm(pane.id) },
      { label: "Open SFTP", icon: "folder-sync", onSelect: () => openSftp(host, pane.meta.sshName ?? "", { tabId, near: pane.id }) },
    ];
  },
  onRemove: (paneId) => {
    disposeTerm(paneId);
    ipc.ptyKill(paneId, true).catch(() => {});
  },
};
