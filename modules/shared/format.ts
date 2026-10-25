const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "";
  let v = Math.abs(n);
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const s = i === 0 ? String(v) : v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
  return `${n < 0 ? "-" : ""}${s} ${UNITS[i]}`;
}

const nf = new Intl.NumberFormat();
export function formatNumber(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? "" : nf.format(n);
}

/** 3725000 → "1h 2m 5s"; small values keep milliseconds. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m ${sec}s`;
  if (m) return `${m}m ${sec}s`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/** Local date and time with seconds, e.g. "2026-10-25 14:03:07". */
export function formatDateTime(ms: number | null | undefined, withMs = false): string {
  if (!ms) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return withMs ? `${base}.${p(d.getMilliseconds(), 3)}` : base;
}

/** "5 s ago", "3 min ago", "2 h ago", or the date for older times. */
export function formatAgo(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return "";
  const s = Math.round((now - ms) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return formatDateTime(ms);
}

/** "0x1f" for numbers; strings that already are hex pass through. */
export function hex(v: number | string | null | undefined, pad = 0): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  return "0x" + (v >>> 0).toString(16).padStart(pad, "0");
}

/** Sort comparator that orders "file10" after "file9". */
export const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare;

/** Compare hex address strings ("0x…") without losing precision. */
export function compareHex(a: string | null | undefined, b: string | null | undefined): number {
  const x = toBig(a);
  const y = toBig(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** "0x7ff6…" (or a decimal string) as a BigInt; 0 when it isn't a number. */
export function toBig(v: string | number | null | undefined): bigint {
  if (v === null || v === undefined || v === "") return 0n;
  try {
    return BigInt(v);
  } catch {
    return 0n;
  }
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}
