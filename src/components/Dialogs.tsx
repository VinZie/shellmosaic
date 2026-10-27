import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon, PICKER_ICONS } from "../lib/icons";
import { cx, toHex6, uid } from "../lib/util";
import * as A from "../state/actions";
import { GRADIENTS } from "../state/menus";
import { WORKSPACE_COLORS, updateWorkspace, type Background } from "../state/model";
import { useSettings } from "../state/settings";
import { commit, useModel } from "../state/store";
import { ui, useUi, type Dialog, type UpdateChoice } from "../state/ui";
import { BackgroundLayer } from "./Workspace";

export function Modal({ title, children, onClose, footer, wide }: { title: ReactNode; children: ReactNode; onClose: () => void; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  // keys must not keep going to the terminal behind it (dialogs that focus a field still do so)
  useEffect(() => {
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={cx("modal", wide && "wide")} role="dialog" tabIndex={-1}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} title="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

function PromptDialog({ d }: { d: Extract<Dialog, { kind: "prompt" }> }) {
  const [value, setValue] = useState(d.value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.select(), []);
  const done = (v: string | null) => {
    ui.closeDialog();
    d.resolve(v);
  };
  return (
    <Modal
      title={d.title}
      onClose={() => done(null)}
      footer={
        <>
          <button className="btn" onClick={() => done(null)}>Cancel</button>
          <button className="btn primary" onClick={() => done(value)}>{d.okLabel ?? "OK"}</button>
        </>
      }
    >
      {d.label && <label className="field-label">{d.label}</label>}
      <input
        ref={ref}
        className="input wide"
        type={d.secret ? "password" : "text"}
        autoComplete={d.secret ? "off" : undefined}
        spellCheck={d.secret ? false : undefined}
        value={value}
        placeholder={d.placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && done(value)}
      />
    </Modal>
  );
}

function ConfirmDialog({ d }: { d: Extract<Dialog, { kind: "confirm" }> }) {
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => okRef.current?.focus(), []);
  const done = (v: boolean) => {
    ui.closeDialog();
    d.resolve(v);
  };
  return (
    <Modal
      title={d.title}
      onClose={() => done(false)}
      footer={
        <>
          <button className="btn" onClick={() => done(false)}>Cancel</button>
          <button ref={okRef} className={cx("btn", d.danger ? "danger" : "primary")} onClick={() => done(true)}>
            {d.okLabel ?? "OK"}
          </button>
        </>
      }
    >
      <div className="confirm-message">{d.message}</div>
    </Modal>
  );
}

function WorkspaceEditor({ workspaceId }: { workspaceId: string | null }) {
  const ws = useModel((s) => (workspaceId ? s.model.workspaces[workspaceId] : undefined));
  const [name, setName] = useState(ws?.name ?? "");
  const [icon, setIcon] = useState(ws?.icon ?? "square-terminal");
  const [color, setColor] = useState(ws?.color ?? WORKSPACE_COLORS[0]);
  const [emoji, setEmoji] = useState("");
  // deleted meanwhile (e.g. from another window): an invisible open dialog would block every shortcut
  useEffect(() => {
    if (!ws) ui.closeDialog();
  }, [ws]);
  if (!ws) return null;
  const save = () => {
    commit((m) => updateWorkspace(m, ws.id, { name: name.trim() || ws.name, icon: emoji.trim() || icon, color }));
    ui.closeDialog();
  };
  return (
    <Modal
      title="Workspace"
      onClose={ui.closeDialog}
      footer={
        <>
          <button className="btn danger subtle" onClick={() => { ui.closeDialog(); A.deleteWorkspace(ws.id); }}>
            <Icon name="trash" size={14} /> Delete
          </button>
          <span className="grow" />
          <button className="btn" onClick={ui.closeDialog}>Cancel</button>
          <button className="btn primary" onClick={save}>Save</button>
        </>
      }
    >
      <div className="ws-editor">
        <div className="ws-preview" style={{ color, background: `color-mix(in srgb, ${color} 16%, transparent)` }}>
          <Icon name={emoji.trim() || icon} size={30} />
        </div>
        <div className="grow">
          <label className="field-label">Name</label>
          <input className="input wide" value={name} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
        </div>
      </div>
      <label className="field-label">Color</label>
      <div className="swatch-row">
        {WORKSPACE_COLORS.map((c) => (
          <button key={c} className={cx("swatch big", c === color && "selected")} style={{ background: c }} onClick={() => setColor(c)} />
        ))}
        <label className="swatch big custom" title="Custom color">
          <input type="color" value={toHex6(color)} onChange={(e) => setColor(e.target.value)} />
          <Icon name="palette" size={14} />
        </label>
      </div>
      <label className="field-label">Icon</label>
      <div className="icon-grid">
        {PICKER_ICONS.map((n) => (
          <button key={n} className={cx("icon-choice", n === icon && !emoji && "selected")} onClick={() => { setIcon(n); setEmoji(""); }} title={n}>
            <Icon name={n} size={18} />
          </button>
        ))}
      </div>
      <label className="field-label">…or an emoji</label>
      <input className="input" style={{ width: 120 }} value={emoji} maxLength={4} placeholder="🚀" onChange={(e) => setEmoji(e.target.value)} />
    </Modal>
  );
}

function BackgroundDialog({ target }: { target: { kind: "workspace" | "tab" | "global"; id?: string } }) {
  const current = useModel((s) =>
    target.kind === "workspace" ? s.model.workspaces[target.id!]?.background : target.kind === "tab" ? s.model.tabs[target.id!]?.background : undefined,
  );
  const globalBg = useSettings((s) => s.settings.window.background);
  const [bg, setBg] = useState<Background | null>((target.kind === "global" ? globalBg : current) ?? null);
  const update = (patch: Partial<Background>) => setBg((b) => (b ? { ...b, ...patch } : b));
  return (
    <Modal
      title={`Background — ${target.kind === "global" ? "whole window" : target.kind}`}
      onClose={ui.closeDialog}
      wide
      footer={
        <>
          <button className="btn subtle" onClick={() => setBg(null)}>Remove</button>
          <span className="grow" />
          <button className="btn" onClick={ui.closeDialog}>Cancel</button>
          <button className="btn primary" onClick={() => { A.setBackground(target, bg); ui.closeDialog(); }}>Apply</button>
        </>
      }
    >
      <div className="bg-editor">
        <div className="bg-preview">
          <BackgroundLayer bg={bg} />
          {!bg && <span className="dim">No background</span>}
        </div>
        <div className="bg-controls">
          <button
            className="btn"
            onClick={async () => {
              const path = await A.pickBackgroundImage();
              if (path) setBg({ kind: "image", value: path, opacity: bg?.opacity ?? 0.35, fit: "cover", blur: 0 });
            }}
          >
            <Icon name="image" size={14} /> Choose image…
          </button>
          <div className="gradient-grid">
            {GRADIENTS.map((g) => (
              <button
                key={g.name}
                className={cx("gradient-choice", bg?.value === g.css && "selected")}
                style={{ background: g.css }}
                onClick={() => setBg({ kind: "css", value: g.css, opacity: bg?.opacity ?? 0.6 })}
                title={g.name}
              />
            ))}
          </div>
          <label className="field-label">CSS background (color, gradient)</label>
          <input
            className="input wide"
            placeholder="e.g. #101820 or linear-gradient(…)"
            value={bg?.kind === "css" ? bg.value : ""}
            onChange={(e) => setBg({ kind: "css", value: e.target.value, opacity: bg?.opacity ?? 0.6 })}
          />
          {bg && (
            <>
              <label className="field-label">Opacity · {Math.round(bg.opacity * 100)}%</label>
              <input type="range" min={0.05} max={1} step={0.05} value={bg.opacity} onChange={(e) => update({ opacity: Number(e.target.value) })} />
              <label className="field-label">Blur · {bg.blur ?? 0}px</label>
              <input type="range" min={0} max={30} step={1} value={bg.blur ?? 0} onChange={(e) => update({ blur: Number(e.target.value) })} />
              {bg.kind === "image" && (
                <>
                  <label className="field-label">Fit</label>
                  <div className="segmented">
                    {(["cover", "contain", "tile"] as const).map((f) => (
                      <button key={f} className={cx(bg.fit === f && "on")} onClick={() => update({ fit: f })}>{f}</button>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

const PERMISSION_TEXT: Record<string, string> = {
  "terminal.write": "Type into terminals in its tab",
  "terminal.read": "Read recent terminal output",
  "terminal.run": "Open new terminals that run commands",
  "fs.read": "Read files and folders on your computer",
  "fs.write": "Create and change files on your computer",
  "shell.exec": "Run programs on your computer",
  "system.read": "Read CPU, memory and network statistics",
  clipboard: "Read and write the clipboard",
  net: "Connect to the internet (HTTPS)",
  "claude.usage": "Read your Claude plan usage (not your sign-in)",
  "process.inspect": "Look inside running processes (modules, threads, handles, memory)",
  "process.control": "Suspend and resume processes and threads, change priority",
  "eventlog.read": "Read the Windows event logs",
  sqlite: "Open SQLite databases and change them when you allow it",
  "agents.read": "See your Claude Code agents: tasks, activity, pending requests and terminal output",
  "agents.manage": "Start, stop and instruct Claude Code agents. Agents run commands and change files on this computer using your Claude account",
};

function PluginPermissions({ d }: { d: Extract<Dialog, { kind: "plugin-permissions" }> }) {
  const done = (ok: boolean) => {
    ui.closeDialog();
    d.resolve(ok);
  };
  const risky = d.permissions.some((p) => ["shell.exec", "fs.write", "terminal.write", "terminal.run", "process.control", "sqlite", "agents.manage"].includes(p));
  return (
    <Modal
      title={`Allow "${d.name}"?`}
      onClose={() => done(false)}
      footer={
        <>
          <button className="btn" onClick={() => done(false)}>Don't allow</button>
          <button className={cx("btn", risky ? "danger" : "primary")} onClick={() => done(true)}>Allow</button>
        </>
      }
    >
      <p>This plugin asks to:</p>
      <ul className="perm-list">
        {d.permissions.map((p) => (
          <li key={p}>
            <Icon name={p.startsWith("fs") ? "folder" : p.startsWith("terminal") ? "terminal" : p === "net" ? "globe" : p === "shell.exec" ? "zap" : p === "claude.usage" ? "gauge" : p.startsWith("process") ? "cpu" : p === "eventlog.read" ? "logs" : p === "sqlite" ? "database" : p.startsWith("agents") ? "bot" : "shield"} size={14} />
            <span>{PERMISSION_TEXT[p] ?? p}</span>
            <code>{p}</code>
          </li>
        ))}
      </ul>
      {risky && <p className="warn-text">Only allow plugins you trust. You can revoke this any time in Settings → Plugins.</p>}
    </Modal>
  );
}

function UpdateDialog({ d }: { d: Extract<Dialog, { kind: "update" }> }) {
  const done = (choice: UpdateChoice) => {
    ui.closeDialog();
    d.resolve(choice);
  };
  return (
    <Modal
      title="An update is available"
      onClose={() => done("later")}
      footer={
        <>
          <button className="btn subtle" onClick={() => done("skip")} title="Don't offer this version again">
            Skip this version
          </button>
          <span className="grow" />
          <button className="btn" onClick={() => done("later")}>Later</button>
          <button className="btn primary" onClick={() => done("update")}>
            <Icon name="download" size={14} /> Update now
          </button>
        </>
      }
    >
      <p>
        Shellmosaic <b>{d.version}</b> is available. You have {d.current}.
      </p>
      {/* (plain text: release notes are not rendered as HTML) */}
      {d.notes.trim() && <div className="update-notes selectable">{d.notes.slice(0, 4000)}</div>}
      <p className="dim">The app closes while the update installs, then starts again. Your workspaces and sessions are restored.</p>
    </Modal>
  );
}

function About() {
  const [version, setVersion] = useState("");
  useEffect(() => {
    getVersion().then(setVersion, () => {});
  }, []);
  return (
    <Modal title="Shellmosaic" onClose={ui.closeDialog}>
      <p>A modular, workspace-based terminal for Windows.</p>
      <p className="dim">Version {version} · Tauri 2 · Rust · xterm.js</p>
      <p className="dim">
        Built-in themes Dracula, Nord, Catppuccin, Tokyo Night, Gruvbox and Solarized are used under their MIT licenses.
      </p>
    </Modal>
  );
}

export function DialogHost() {
  const d = useUi((s) => s.dialog);
  // a new dialog object is a new dialog: React must not reuse the previous one's state (typed text)
  const key = useMemo(() => uid(), [d]);
  if (!d) return null;
  switch (d.kind) {
    case "prompt":
      return <PromptDialog key={key} d={d} />;
    case "confirm":
      return <ConfirmDialog key={key} d={d} />;
    case "workspace":
      return <WorkspaceEditor workspaceId={d.workspaceId} />;
    case "background":
      return <BackgroundDialog target={d.target} />;
    case "plugin-permissions":
      return <PluginPermissions d={d} />;
    case "update":
      return <UpdateDialog d={d} />;
    case "about":
      return <About />;
    default:
      return null;
  }
}
