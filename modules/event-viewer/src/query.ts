// The filter model and the XPath event query generated from it.

export type RangeId = "any" | "1h" | "12h" | "24h" | "7d" | "30d";
export type Audit = "" | "success" | "failure";

export const RANGES: { value: RangeId; label: string; short: string; ms: number }[] = [
  { value: "any", label: "Any time", short: "Any time", ms: 0 },
  { value: "1h", label: "Last hour", short: "1 h", ms: 3_600_000 },
  { value: "12h", label: "Last 12 hours", short: "12 h", ms: 43_200_000 },
  { value: "24h", label: "Last 24 hours", short: "24 h", ms: 86_400_000 },
  { value: "7d", label: "Last 7 days", short: "7 days", ms: 604_800_000 },
  { value: "30d", label: "Last 30 days", short: "30 days", ms: 2_592_000_000 },
];

export interface Filters {
  /** 1 Critical, 2 Error, 3 Warning, 4 Information (also Level 0), 5 Verbose; empty = every level */
  levels: number[];
  /** Security keywords */
  audit: Audit;
  /** "4624, 4625, 4700-4710, -4672" */
  ids: string;
  providers: string[];
  range: RangeId;
}

export const NO_FILTERS: Filters = { levels: [], audit: "", ids: "", providers: [], range: "any" };

export interface IdSpec {
  include: [number, number][];
  exclude: [number, number][];
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** "4624, 4625, 4700-4710, -4672": IDs, ranges, and `-` for excludes (commas, spaces or semicolons between). */
export function parseIds(text: string): Parsed<IdSpec> {
  const include: [number, number][] = [];
  const exclude: [number, number][] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    if (!raw) continue;
    const m = /^(-)?(\d+)(?:-(\d+))?$/.exec(raw);
    if (!m) {
      return { ok: false, error: /^-?\d+-$/.test(raw) ? `"${raw}" is missing the end of the range` : `"${raw}" isn't an event ID or a range like 4700-4710` };
    }
    const lo = Number(m[2]);
    const hi = m[3] !== undefined ? Number(m[3]) : lo;
    if (lo > 65535 || hi > 65535) return { ok: false, error: `${lo > 65535 ? lo : hi} is too big: event IDs go up to 65535` };
    if (hi < lo) return { ok: false, error: `${raw}: the range ends before it starts` };
    (m[1] ? exclude : include).push([lo, hi]);
  }
  return { ok: true, value: { include, exclude } };
}

const one = ([lo, hi]: [number, number]) => (lo === hi ? `EventID=${lo}` : `(EventID>=${lo} and EventID<=${hi})`);

/** A string literal for XPath 1.0, which has no escapes: pick the quote the value doesn't contain. */
export function xpathString(s: string): string {
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  throw new Error(`"${s}" contains both kinds of quotes`);
}

const AUDIT_MASK: Record<Exclude<Audit, "">, string> = {
  failure: "4503599627370496", // 0x0010000000000000
  success: "9007199254740992", // 0x0020000000000000
};

/** The XPath for the filters; null for "every event". Throws only for impossible provider names. */
export function buildXPath(f: Filters, ids: IdSpec | null): string | null {
  const conds: string[] = [];
  const levels = [...new Set(f.levels)].filter((l) => l >= 1 && l <= 5).sort();
  if (levels.length && levels.length < 5) {
    const parts = levels.flatMap((l) => (l === 4 ? ["Level=4", "Level=0"] : [`Level=${l}`]));
    conds.push(parts.length === 1 ? parts[0] : `(${parts.join(" or ")})`);
  }
  if (f.audit) conds.push(`band(Keywords,${AUDIT_MASK[f.audit]})`);
  if (ids?.include.length) {
    const parts = ids.include.map(one);
    conds.push(parts.length === 1 ? parts[0] : `(${parts.join(" or ")})`);
  }
  if (ids?.exclude.length) conds.push(`not(${ids.exclude.map(one).join(" or ")})`);
  const providers = f.providers.filter(Boolean);
  if (providers.length) conds.push(`Provider[${providers.map((p) => `@Name=${xpathString(p)}`).join(" or ")}]`);
  const range = RANGES.find((r) => r.value === f.range);
  if (range?.ms) conds.push(`TimeCreated[timediff(@SystemTime) <= ${range.ms}]`);
  return conds.length ? `*[System[${conds.join(" and ")}]]` : null;
}

export function filterCount(f: Filters): number {
  return (f.levels.length && f.levels.length < 5 ? 1 : 0) + (f.audit ? 1 : 0) + (f.ids.trim() ? 1 : 0) + (f.providers.length ? 1 : 0) + (f.range !== "any" ? 1 : 0);
}

/** Add `-id` to an ID filter (dropping a plain `id` include of the same number). */
export function excludeId(ids: string, id: number): string {
  const parts = ids
    .split(/[\s,;]+/)
    .filter(Boolean)
    .filter((p) => p !== String(id) && p !== `-${id}`);
  return [...parts, `-${id}`].join(", ");
}
