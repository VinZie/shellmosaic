/** Short random id, safe for file names and Tauri labels. */
export function uid(len = 10): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = "";
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function formatBytes(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return "–";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (Math.abs(n) >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

export function formatDuration(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${Math.floor(secs % 60)}s`;
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  const wrapped = (...a: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  wrapped.flush = (...a: A) => {
    clearTimeout(t);
    fn(...a);
  };
  return wrapped;
}

export function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export function dirname(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (i < 0) return trimmed;
  if (i === 2 && trimmed[1] === ":") return trimmed.slice(0, 3); // C:\
  return trimmed.slice(0, i) || trimmed.slice(0, 1);
}

export function joinPath(dir: string, name: string): string {
  const sep = dir.includes("/") && !dir.includes("\\") ? "/" : "\\";
  return dir.endsWith("\\") || dir.endsWith("/") ? dir + name : dir + sep + name;
}

/** Quote a path for pasting into a shell (`kind` = the receiving profile's kind). */
export function shellQuote(p: string, kind?: string): string {
  // PowerShell and bash still expand $(…) and backticks inside "…", so a crafted
  // file name would run code: use single quotes there (PowerShell also treats ‘ ’ ‚ ‛ as ')
  if (kind === "bash" || kind === "wsl") return `'${p.replace(/'/g, `'\\''`)}'`;
  if (kind === "pwsh" || kind === "powershell") {
    return /^[\w.:\\/-]+$/.test(p) ? p : `'${p.replace(/['‘’‚‛]/g, "$&$&")}'`;
  }
  return /[\s&()[\]{}^=;!'+,`~$]/.test(p) ? `"${p}"` : p;
}

/** Simple subsequence fuzzy score; higher is better, -1 = no match. */
export function fuzzyScore(query: string, text: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct * 2 - (t.length - q.length) * 0.1;
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    streak = found === ti ? streak + 1 : 0;
    score += 10 + streak * 5 - (found - ti);
    ti = found + 1;
  }
  return score;
}

/** Keys of `value` that differ from `base` (recursively), for saving only user changes. */
export function deepDiff(base: unknown, value: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const d = deepDiff((base as Record<string, unknown>)[k], v);
      if (d !== undefined) out[k] = d;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return JSON.stringify(base) === JSON.stringify(value) ? undefined : value;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (isPlainObject(o) ? o[k] : undefined), obj);
}

export function setPath<T>(obj: T, path: string, value: unknown): T {
  const out = structuredClone(obj) as Record<string, unknown>;
  const keys = path.split(".");
  let cur = out;
  keys.slice(0, -1).forEach((k) => {
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  });
  cur[keys[keys.length - 1]] = value;
  return out as T;
}

/** Parse "#rrggbb", "#rrggbbaa", "#rgb" into [r,g,b,a]. */
export function parseColor(c: string): [number, number, number, number] | null {
  const m = c.trim().match(/^#([0-9a-f]{3,8})$/i);
  if (!m) {
    const rgb = c.match(/rgba?\(([^)]+)\)/i);
    if (!rgb) return null;
    const p = rgb[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p[3] ?? 1];
  }
  let h = m[1];
  if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join("");
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
}

export function withAlpha(color: string, alpha: number): string {
  const p = parseColor(color);
  if (!p) return color;
  return `rgba(${p[0]}, ${p[1]}, ${p[2]}, ${clamp(alpha * p[3], 0, 1).toFixed(3)})`;
}

export function toHex6(color: string): string {
  const p = parseColor(color);
  if (!p) return "#000000";
  return "#" + p.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}

/** Relative luminance, used to pick readable text on colored chips. */
export function luminance(color: string): number {
  const p = parseColor(color);
  if (!p) return 0;
  const [r, g, b] = p.slice(0, 3).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export const isMac = false; // Shellmosaic targets Windows
