// Notes: markdown notes scoped to a workspace, tab, pane or shared globally.
// Text autosaves (debounced) through notes_read/notes_write; panes showing the
// same note in this window stay in sync, and a pane re-reads its note when it
// becomes visible again (never over unsaved edits).
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../lib/icons";
import { errorText, ipc } from "../../lib/ipc";
import { cx, uid } from "../../lib/util";
import { setPaneMeta } from "../../state/actions";
import { workspaceOfTab, type Pane } from "../../state/model";
import { getState, useModel } from "../../state/store";
import { ui, type MenuItem } from "../../state/ui";
import { ModuleMessage } from "../common";
import type { ModuleDef, ModuleProps } from "../registry";
import { handleMarkdownClick, renderMarkdown, setTask, taskOffsets } from "./markdown";
import "./notes.css";

type Scope = "workspace" | "tab" | "pane" | "global";
type Mode = "edit" | "split" | "preview";

const SCOPES: Scope[] = ["workspace", "tab", "pane", "global"];
const SCOPE_LABEL: Record<Scope, string> = { workspace: "Workspace", tab: "Tab", pane: "Pane", global: "Global" };
const SCOPE_HINT: Record<Scope, string> = {
  workspace: "Shared by every Notes pane in this workspace",
  tab: "Only for this tab",
  pane: "Private to this pane",
  global: "One note shared everywhere",
};
const MODES: { id: Mode; icon: string; label: string }[] = [
  { id: "edit", icon: "pencil", label: "Edit" },
  { id: "split", icon: "columns-2", label: "Split" },
  { id: "preview", icon: "eye", label: "Preview" },
];

const paneScope = (pane: Pane): Scope => (SCOPES.includes(pane.meta.scope) ? pane.meta.scope : "workspace");

function noteKey(scope: Scope, ids: { wsId?: string; tabId: string; paneId: string }): string | null {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  switch (scope) {
    case "global":
      return "global";
    case "tab":
      return `tab-${clean(ids.tabId)}`;
    case "pane":
      return `pane-${clean(ids.paneId)}`;
    default:
      return ids.wsId ? `ws-${clean(ids.wsId)}` : null;
  }
}

// ── same-window sync between panes showing the same note ────────────────

type Listener = (text: string, source: string) => void;
const listeners = new Map<string, Set<Listener>>();

function subscribe(key: string, fn: Listener) {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (!set!.size) listeners.delete(key);
  };
}

function publish(key: string, text: string, source: string) {
  listeners.get(key)?.forEach((fn) => fn(text, source));
}

// ── helpers ─────────────────────────────────────────────────────────────

function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const width = Math.round(e.contentRect.width);
      if (width > 0) setW(width); // hidden tabs report 0; keep the last real size
    });
    ro.observe(el);
    if (el.clientWidth) setW(el.clientWidth);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/** Insert text at the caret through the browser's editing pipeline (keeps undo). */
function insertAtCaret(ta: HTMLTextAreaElement, s: string) {
  ta.focus();
  if (!document.execCommand("insertText", false, s)) {
    ta.setRangeText(s, ta.selectionStart, ta.selectionEnd, "end");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

function lineBounds(value: string, pos: number) {
  const start = value.lastIndexOf("\n", pos - 1) + 1;
  const nl = value.indexOf("\n", pos);
  return { start, end: nl < 0 ? value.length : nl };
}

const LIST_RE = /^(\s*)([-*+]|(\d{1,9})([.)]))(\s+)(\[[ xX]\]\s+)?/;

// ── component ───────────────────────────────────────────────────────────

type Status = "idle" | "pending" | "saving" | "saved" | "error";

function NotesPane({ pane, tabId, visible, focused }: ModuleProps) {
  const scope = paneScope(pane);
  const wsId = useModel((s) => workspaceOfTab(s.model, tabId)?.id);
  const key = noteKey(scope, { wsId, tabId, paneId: pane.id });

  const rootRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const width = useWidth(rootRef);
  const mode: Mode = MODES.some((m) => m.id === pane.meta.mode) ? pane.meta.mode : width >= 720 ? "split" : "edit";
  const narrow = width > 0 && width < 480;

  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<Status>("idle");
  const textRef = useRef(text);
  const keyRef = useRef<string | null>(null); // the note `text` belongs to
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const instance = useRef(uid()).current;

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    const k = keyRef.current;
    if (!dirty.current || !k) return;
    const t = textRef.current;
    dirty.current = false;
    setStatus("saving");
    try {
      await ipc.notesWrite(k, t);
      publish(k, t, instance);
      if (!dirty.current) setStatus("saved");
    } catch (e) {
      dirty.current = true;
      setStatus("error");
      ui.toast(`Couldn't save note: ${errorText(e)}`, "error");
    }
  }, [instance]);

  const applyRemote = useCallback((t: string) => {
    if (t === textRef.current) return;
    textRef.current = t;
    setText(t);
  }, []);

  const reload = useCallback(
    async (k: string) => {
      try {
        const t = (await ipc.notesRead(k)).replace(/\r\n?/g, "\n");
        if (dirty.current || keyRef.current !== k) return;
        applyRemote(t);
      } catch (e) {
        ui.toast(`Couldn't read note: ${errorText(e)}`, "error");
      } finally {
        if (keyRef.current === k) setLoading(false);
      }
    },
    [applyRemote],
  );

  // switch notes (scope change / first mount): save the old one, load the new one
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    (async () => {
      if (keyRef.current && keyRef.current !== key && dirty.current) await flush();
      if (cancelled) return;
      keyRef.current = key;
      dirty.current = false;
      setStatus("idle");
      setLoading(true);
      textRef.current = "";
      setText("");
      await reload(key);
    })();
    return () => {
      cancelled = true;
    };
  }, [key, flush, reload]);

  // re-read when the pane comes back on screen or the window regains focus
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (visible && !wasVisible.current && key && keyRef.current === key && !dirty.current) reload(key);
    wasVisible.current = visible;
  }, [visible, key, reload]);
  useEffect(() => {
    const onFocus = () => {
      if (visible && key && keyRef.current === key && !dirty.current) reload(key);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [visible, key, reload]);

  // live updates from other panes editing the same note
  useEffect(() => {
    if (!key) return;
    return subscribe(key, (t, source) => {
      if (source !== instance && !dirty.current && keyRef.current === key) applyRemote(t);
    });
  }, [key, instance, applyRemote]);

  // save on close / reload
  useEffect(() => {
    const onUnload = () => void flush();
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      void flush();
    };
  }, [flush]);

  const onEdit = useCallback(
    (v: string) => {
      textRef.current = v;
      setText(v);
      dirty.current = true;
      setStatus("pending");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), 500);
    },
    [flush],
  );

  // focus the editor when the pane gets focus
  useEffect(() => {
    if (!focused || !visible || mode === "preview") return;
    const active = document.activeElement;
    if (active && rootRef.current?.contains(active)) return;
    if (ui.get().dialog || ui.get().palette.open) return;
    editorRef.current?.focus({ preventScroll: true });
  }, [focused, visible, mode]);

  const setMode = (m: Mode) => {
    setPaneMeta(pane.id, { mode: m });
    if (m !== "preview") requestAnimationFrame(() => editorRef.current?.focus());
  };
  const setScope = (s: Scope) => {
    if (s !== scope) setPaneMeta(pane.id, { scope: s });
  };

  // ── editor key handling ──
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    if (e.key === "s" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      void flush();
      return;
    }
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: en, value } = ta;
      const multi = value.slice(s, en).includes("\n");
      if (!multi && !e.shiftKey) return insertAtCaret(ta, "  ");
      const start = lineBounds(value, s).start;
      const lines = value.slice(start, en).split("\n");
      const next = lines.map((l) => (e.shiftKey ? l.replace(/^( {1,2}|\t)/, "") : "  " + l)).join("\n");
      ta.setSelectionRange(start, en);
      insertAtCaret(ta, next);
      if (multi) ta.setSelectionRange(start, start + next.length);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.nativeEvent.isComposing) {
      const { selectionStart: s, selectionEnd: en, value } = ta;
      if (s !== en) return;
      const { start, end } = lineBounds(value, s);
      const before = value.slice(start, s);
      const m = before.match(LIST_RE);
      if (!m) return;
      e.preventDefault();
      if (before.length === m[0].length && !value.slice(s, end).trim()) {
        // Enter on an empty item ends the list
        ta.setSelectionRange(start, end);
        insertAtCaret(ta, "");
        return;
      }
      const bullet = m[3] ? `${Number(m[3]) + 1}${m[4]}` : m[2];
      insertAtCaret(ta, `\n${m[1]}${bullet}${m[5]}${m[6] ? "[ ] " : ""}`);
    }
  };

  const appendBlock = (block: string) => {
    const cur = textRef.current;
    const sep = !cur ? "" : cur.endsWith("\n\n") ? "" : cur.endsWith("\n") ? "\n" : "\n\n";
    onEdit(cur + sep + block + "\n");
  };

  const insertChecklist = async () => {
    const ta = editorRef.current;
    if (!ta || mode === "preview") {
      const item = await ui.prompt("New checklist item", "", { placeholder: "What needs doing?", okLabel: "Add" });
      if (item?.trim()) {
        const cur = textRef.current;
        onEdit(cur + (!cur || cur.endsWith("\n") ? "" : "\n") + `- [ ] ${item.trim()}\n`);
      }
      return;
    }
    const { selectionStart: s, value } = ta;
    const { start, end } = lineBounds(value, s);
    const line = value.slice(start, end);
    const bullet = line.match(/^(\s*)([-*+]|\d{1,9}[.)])\s+/);
    if (!line.trim()) {
      ta.setSelectionRange(start, end);
      insertAtCaret(ta, "- [ ] ");
    } else if (bullet && !/^\s*([-*+]|\d{1,9}[.)])\s+\[[ xX]\]/.test(line)) {
      // turn a plain bullet into a task
      const at = start + bullet[0].length;
      ta.setSelectionRange(at, at);
      insertAtCaret(ta, "[ ] ");
      ta.setSelectionRange(end + 4, end + 4);
    } else {
      const indent = bullet?.[1] ?? "";
      ta.setSelectionRange(end, end);
      insertAtCaret(ta, `\n${indent}- [ ] `);
    }
  };

  const insertCode = async () => {
    const ta = editorRef.current;
    if (!ta || mode === "preview") {
      const cmd = await ui.prompt("New code block", "", { placeholder: "A command you can run from the preview", okLabel: "Add" });
      if (cmd?.trim()) appendBlock("```\n" + cmd.trim() + "\n```");
      return;
    }
    const { selectionStart: s, selectionEnd: en, value } = ta;
    const atLineStart = s === 0 || value[s - 1] === "\n";
    const prefix = atLineStart ? "" : "\n";
    const sel = value.slice(s, en);
    if (sel) {
      insertAtCaret(ta, `${prefix}\`\`\`\n${sel.replace(/\n$/, "")}\n\`\`\`\n`);
    } else {
      insertAtCaret(ta, `${prefix}\`\`\`\n\n\`\`\``);
      const caret = s + prefix.length + 4;
      ta.setSelectionRange(caret, caret);
    }
  };

  // ── preview ──
  const deferred = useDeferredValue(text);
  const rendered = useMemo(() => (mode === "edit" ? null : renderMarkdown(deferred, { tasks: true })), [deferred, mode]);

  const onPreviewClick = (e: React.MouseEvent) => {
    if (!rendered) return;
    handleMarkdownClick(e, {
      codes: rendered.codes,
      tabId,
      onTask: (i, checked) => {
        const next = setTask(textRef.current, i, checked);
        if (next === null) {
          ui.toast("Couldn't find that checkbox in the note", "warning");
          return false;
        }
        onEdit(next);
        return true;
      },
    });
  };

  // keep the preview roughly aligned with the editor in split mode
  const onEditorScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    if (mode !== "split" || !previewRef.current) return;
    const ta = e.currentTarget;
    const max = ta.scrollHeight - ta.clientHeight;
    const p = previewRef.current;
    p.scrollTop = max > 0 ? (ta.scrollTop / max) * (p.scrollHeight - p.clientHeight) : 0;
  };

  // ── footer stats ──
  const stats = useMemo(() => {
    const trimmed = deferred.trim();
    const words = trimmed ? trimmed.split(/\s+/).length : 0;
    const lines = deferred ? deferred.split("\n").length : 0;
    const offsets = taskOffsets(deferred);
    const done = offsets.filter((o) => deferred[o] !== " ").length;
    return { words, lines, chars: deferred.length, tasks: offsets.length, done };
  }, [deferred]);

  if (!key) {
    return (
      <div className="module notes" ref={rootRef}>
        <ModuleMessage icon="notebook" title="No workspace for this note">
          <p>Switch the scope to Global to keep writing.</p>
          <div className="row">
            <button className="btn" onClick={() => setScope("global")}>
              Use the global note
            </button>
          </div>
        </ModuleMessage>
      </div>
    );
  }

  return (
    <div className={cx("module notes", `notes-mode-${mode}`, narrow && "notes-narrow")} ref={rootRef}>
      <div className="toolbar notes-toolbar">
        {narrow ? (
          <select className="input notes-scope-select" value={scope} title={SCOPE_HINT[scope]} onChange={(e) => setScope(e.target.value as Scope)}>
            {SCOPES.map((s) => (
              <option key={s} value={s}>
                {SCOPE_LABEL[s]}
              </option>
            ))}
          </select>
        ) : (
          <div className="segmented" role="radiogroup" aria-label="Note scope">
            {SCOPES.map((s) => (
              <button key={s} className={cx(scope === s && "on")} title={SCOPE_HINT[s]} onClick={() => setScope(s)}>
                {SCOPE_LABEL[s]}
              </button>
            ))}
          </div>
        )}
        <div className="toolbar-sep" />
        <div className="segmented notes-modes" role="radiogroup" aria-label="View">
          {MODES.map((m) => (
            <button key={m.id} className={cx(mode === m.id && "on")} title={m.label} onClick={() => setMode(m.id)}>
              <Icon name={m.icon} size={13} />
              {width >= 640 && <span>{m.label}</span>}
            </button>
          ))}
        </div>
        <div className="grow" />
        <button className="icon-btn" title="Insert checklist item" onMouseDown={(e) => e.preventDefault()} onClick={insertChecklist}>
          <Icon name="list-checks" size={15} />
        </button>
        <button className="icon-btn" title="Insert code block (runnable from the preview)" onMouseDown={(e) => e.preventDefault()} onClick={insertCode}>
          <Icon name="code" size={15} />
        </button>
      </div>

      <div className="notes-body">
        {mode !== "preview" && (
          <textarea
            ref={editorRef}
            className="notes-editor selectable"
            value={text}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            placeholder={loading ? "" : `Notes for this ${scope === "global" ? "app" : scope} — Markdown supported.\n\n- [ ] a checklist item\n\n\`\`\`\nnpm run dev\n\`\`\``}
            onChange={(e) => onEdit(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => void flush()}
            onScroll={onEditorScroll}
          />
        )}
        {rendered && (
          <div className="notes-preview module-scroll" ref={previewRef}>
            {text.trim() ? (
              <div className="notes-md" onClick={onPreviewClick} dangerouslySetInnerHTML={{ __html: rendered.html }} />
            ) : (
              !loading && (
                <ModuleMessage icon="notebook" title="Nothing here yet">
                  <p>{mode === "preview" ? "Switch to Edit or Split to start writing." : "Start typing on the left."}</p>
                </ModuleMessage>
              )
            )}
          </div>
        )}
      </div>

      <div className="module-footer notes-footer">
        <span>
          {stats.words} {stats.words === 1 ? "word" : "words"} · {stats.lines} {stats.lines === 1 ? "line" : "lines"}
        </span>
        {stats.tasks > 0 && (
          <span title="Completed checklist items">
            <Icon name="list-checks" size={11} style={{ verticalAlign: -1, marginRight: 3 }} />
            {stats.done}/{stats.tasks}
          </span>
        )}
        <span className="grow" />
        <SaveStatus status={status} onRetry={() => void flush()} />
      </div>
    </div>
  );
}

function SaveStatus({ status, onRetry }: { status: Status; onRetry: () => void }) {
  if (status === "pending" || status === "saving")
    return (
      <span className="notes-status">
        <Icon name="loader" size={11} className="notes-spin" /> Saving…
      </span>
    );
  if (status === "saved")
    return (
      <span className="notes-status notes-status-saved">
        <Icon name="check" size={11} /> Saved
      </span>
    );
  if (status === "error")
    return (
      <button className="notes-status notes-status-error" onClick={onRetry} title="Retry saving">
        <Icon name="warning" size={11} /> Not saved — retry
      </button>
    );
  return null;
}

function noteKeyForPane(pane: Pane, tabId: string): string | null {
  const ws = workspaceOfTab(getState().model, tabId);
  return noteKey(paneScope(pane), { wsId: ws?.id, tabId, paneId: pane.id });
}

export const notesModule: ModuleDef = {
  id: "notes",
  name: "Notes",
  icon: "notebook",
  description: "Markdown notes per workspace, tab or pane — with runnable code blocks and checklists",
  component: NotesPane,
  defaultMeta: () => ({ scope: "workspace" }),
  title: (pane) => `Notes — ${paneScope(pane)}`,
  menu: (pane, tabId): MenuItem[] => [
    {
      label: "Note scope",
      icon: "layers",
      submenu: SCOPES.map<MenuItem>((s) => ({
        label: SCOPE_LABEL[s],
        hint: SCOPE_HINT[s],
        checked: paneScope(pane) === s,
        onSelect: () => setPaneMeta(pane.id, { scope: s }),
      })),
    },
    {
      label: "Copy note as Markdown",
      icon: "copy",
      onSelect: async () => {
        const key = noteKeyForPane(pane, tabId);
        if (!key) return;
        try {
          await writeText(await ipc.notesRead(key));
          ui.toast("Note copied", "success", 1500);
        } catch (e) {
          ui.toast(errorText(e), "error");
        }
      },
    },
  ],
};
