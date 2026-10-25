// Markdown rendering shared by the Notes module and the Files preview:
// marked (GFM) → DOMPurify, with "▶ Run" / "Copy" buttons on fenced code blocks
// and indexed task checkboxes that can be toggled back into the source.
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import DOMPurify, { type Config } from "dompurify";
import { Marked } from "marked";
import { errorText } from "../../lib/ipc";
import { uid } from "../../lib/util";
import { sendToTerminal } from "../../state/actions";
import { ui } from "../../state/ui";
import "./markdown.css";

export interface RenderedMarkdown {
  html: string;
  /**
   * source of each fenced/indented code block, keyed by its `data-code`. Keys are
   * random per render so raw HTML in the document can't forge a Run button.
   */
  codes: Map<string, string>;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// The rendered HTML lives in the app's own document (and the Files preview shows
// any .md on disk), so drop what could restyle the whole app, navigate it away
// (form submits) or put content in the top layer over it. No inline styles and
// none of the app's own CSS classes either: they could make a real button invisible
// and stretch it over the whole preview.
const PURIFY: Config = {
  FORBID_TAGS: ["style", "form"],
  FORBID_ATTR: ["style", "popover", "popovertarget", "popovertargetaction", "command", "commandfor"],
};
DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
  if (data.attrName === "class") {
    data.attrValue = data.attrValue
      .split(/\s+/)
      .filter((c) => /^(notes-md-[\w-]+|language-[\w+#-]+)$/.test(c))
      .join(" ");
  }
});

// render-pass state (parsing is synchronous, so module-level is safe)
let codes = new Map<string, string>();
let codeKey = "";
let taskIdx = 0;
let tasksEnabled = false;
let runEnabled = true;

const md = new Marked({ gfm: true, breaks: false });
md.use({
  renderer: {
    code(token) {
      const key = `${codeKey}-${codes.size}`;
      codes.set(key, token.text);
      const lang = (token.lang ?? "").match(/^\S*/)?.[0] ?? "";
      const run = runEnabled ? `<button type="button" class="notes-md-code-btn" data-act="run" title="Type into the terminal and press Enter">▶ Run</button>` : "";
      return (
        `<div class="notes-md-code" data-code="${key}">` +
        `<div class="notes-md-code-bar"><span class="notes-md-code-lang">${esc(lang)}</span>${run}` +
        `<button type="button" class="notes-md-code-btn" data-act="copy">Copy</button></div>` +
        `<pre><code>${esc(token.text)}</code></pre></div>\n`
      );
    },
    checkbox({ checked }) {
      const i = taskIdx++;
      return `<input type="checkbox" class="notes-md-task" data-task="${i}"${checked ? " checked" : ""}${tasksEnabled ? "" : " disabled"}> `;
    },
  },
});

export function renderMarkdown(src: string, opts: { tasks?: boolean; run?: boolean } = {}): RenderedMarkdown {
  codes = new Map();
  codeKey = uid(12);
  taskIdx = 0;
  tasksEnabled = !!opts.tasks;
  runEnabled = opts.run ?? true;
  let html: string;
  try {
    html = md.parse(src, { async: false }) as string;
  } catch (e) {
    html = `<pre>${esc(errorText(e))}</pre>`;
  }
  return { html: DOMPurify.sanitize(html, PURIFY), codes };
}

/**
 * Character offset of the mark inside each task checkbox ("[ ]" / "[x]") in
 * source order, skipping fenced code blocks — the same order marked renders them.
 */
export function taskOffsets(src: string): number[] {
  const out: number[] = [];
  let fence: string | null = null;
  let pos = 0;
  for (const line of src.split("\n")) {
    const f = line.match(/^\s*(?:>\s*)*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = null;
    } else if (f) {
      fence = f[1];
    } else {
      const m = line.match(/^((?:\s*>)*\s*(?:[-*+]|\d{1,9}[.)])\s+)\[[ xX]\] +\S/);
      if (m) out.push(pos + m[1].length + 1);
    }
    pos += line.length + 1;
  }
  return out;
}

/** Set the `index`-th task's state in the source; null if it can't be found. */
export function setTask(src: string, index: number, checked: boolean): string | null {
  const at = taskOffsets(src)[index];
  if (at === undefined) return null;
  return src.slice(0, at) + (checked ? "x" : " ") + src.slice(at + 1);
}

function safeDecode(s: string): string {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

/** `file:///C:/x` → `C:\x`, `file://host/share/x` → `\\host\share\x`; null if it can't be parsed. */
function fileUrlPath(href: string): string | null {
  try {
    const u = new URL(href);
    const p = decodeURIComponent(u.pathname).replace(/\//g, "\\");
    return u.host && u.host !== "localhost" ? `\\\\${u.host}${p}` : p.replace(/^\\(?=[a-zA-Z]:)/, "");
  } catch {
    return null;
  }
}

/** Shell input for a code block: each line is "typed" and confirmed. */
function asTerminalInput(code: string): string {
  return code.replace(/\s+$/, "").replace(/\r?\n/g, "\r");
}

/**
 * Click handling for rendered markdown (event delegation on the container):
 * code-block buttons, task checkboxes and links. Returns true if handled.
 */
export function handleMarkdownClick(
  e: React.MouseEvent,
  ctx: {
    codes: Map<string, string>;
    tabId?: string;
    /** a task checkbox was clicked; return false to revert it */
    onTask?: (index: number, checked: boolean) => boolean | void;
    /** links that aren't absolute URLs (relative paths) */
    onRelativeLink?: (href: string) => void;
  },
): boolean {
  const t = e.target as HTMLElement;
  const btn = t.closest<HTMLElement>("[data-act]");
  // only our own code-block buttons (raw HTML can carry data-* attributes too);
  // anything else falls through so links inside it are still intercepted
  const code = btn ? ctx.codes.get(btn.closest<HTMLElement>("[data-code]")?.dataset.code ?? "") : undefined;
  if (btn && code !== undefined) {
    e.preventDefault();
    if (btn.dataset.act === "run") {
      sendToTerminal(asTerminalInput(code), { tabId: ctx.tabId, enter: true }).catch((err) => ui.toast(errorText(err), "error"));
    } else if (btn.dataset.act === "copy") {
      writeText(code)
        .then(() => ui.toast("Copied to clipboard", "success", 1500))
        .catch((err) => ui.toast(errorText(err), "error"));
    }
    return true;
  }
  if (t instanceof HTMLInputElement && t.type === "checkbox" && t.dataset.task !== undefined) {
    if (!ctx.onTask) {
      e.preventDefault();
      return true;
    }
    if (ctx.onTask(Number(t.dataset.task), t.checked) === false) t.checked = !t.checked;
    return true;
  }
  // (image-map <area>s navigate like links)
  const a = t.closest("a, area");
  if (a) {
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (!href) return true;
    if (href.startsWith("#")) {
      const root = (e.currentTarget as HTMLElement) ?? document;
      const id = safeDecode(href.slice(1));
      root.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
    } else if (/^file:/i.test(href) && ctx.onRelativeLink) {
      // a document from disk: a file: URL is a local path like any other (preview it, don't
      // run it through the shell; \\host\share ones get the same check as plain paths)
      const path = fileUrlPath(href);
      if (path) ctx.onRelativeLink(path);
    } else if (/^(https?|mailto|ftp|file):/i.test(href)) {
      openUrl(href).catch((err) => ui.toast(errorText(err), "error"));
    } else if (/^[a-z]:[\\/]/i.test(href) || !/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      // a local path: absolute (C:\…) or relative to the document
      const path = safeDecode(href);
      if (ctx.onRelativeLink) ctx.onRelativeLink(path);
      else if (/^[a-z]:[\\/]/i.test(path)) openPath(path).catch((err) => ui.toast(errorText(err), "error"));
    }
    return true;
  }
  return false;
}
