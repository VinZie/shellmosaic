// Small helpers shared by the inspector's tabs.
import type { PriorityClass, Tone } from "../../../shared";
import { toBig } from "../../../shared";

export const PRIORITIES: { id: PriorityClass; label: string }[] = [
  { id: "idle", label: "Idle" },
  { id: "belowNormal", label: "Below normal" },
  { id: "normal", label: "Normal" },
  { id: "aboveNormal", label: "Above normal" },
  { id: "high", label: "High" },
  { id: "realtime", label: "Realtime" },
];

export const priorityLabel = (p: PriorityClass | null | undefined) => PRIORITIES.find((x) => x.id === p)?.label ?? "";

/** The process is gone: the backend's answer for a PID that no longer runs. */
export const isExited = (msg: string | null | undefined): boolean => !!msg && /\bexited\b|no longer running|has terminated|no such process/i.test(msg);

/** Bits set in a decimal (or hex) mask string. */
export function maskBits(mask: string | null | undefined): number[] {
  let m = toBig(mask);
  const out: number[] = [];
  for (let i = 0; m > 0n && i < 1024; i++, m >>= 1n) if (m & 1n) out.push(i);
  return out;
}

/** [0,1,2,3,6,8,9] → "0–3, 6, 8–9" */
export function cpuRanges(bits: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < bits.length; ) {
    let j = i;
    while (j + 1 < bits.length && bits[j + 1] === bits[j] + 1) j++;
    parts.push(j === i ? String(bits[i]) : j === i + 1 ? `${bits[i]}, ${bits[j]}` : `${bits[i]}–${bits[j]}`);
    i = j + 1;
  }
  return parts.join(", ");
}

export function affinityText(affinity: string | null, system: string | null): string {
  const bits = maskBits(affinity);
  if (!bits.length) return "";
  const all = maskBits(system);
  if (all.length && bits.length === all.length && toBig(affinity) === toBig(system)) return `All ${all.length} CPUs (${cpuRanges(bits)})`;
  return `CPU ${cpuRanges(bits)}${all.length ? ` of ${all.length}` : ""}`;
}

/** Tone of an integrity level chip. */
export function integrityTone(level: string | null | undefined): Tone | undefined {
  switch ((level ?? "").toLowerCase()) {
    case "untrusted":
    case "low":
      return "dim";
    case "high":
      return "warning";
    case "system":
    case "protected":
      return "danger";
    default:
      return undefined;
  }
}

/** Folders any user can write to: where dropped DLLs and payloads usually come from. */
const USER_WRITABLE = /\\(appdata|temp|tmp|downloads|desktop)\\|\\users\\public\\|^[a-z]:\\(perflogs|temp|tmp)\\/i;
export const isUserWritable = (path: string | null | undefined) => !!path && USER_WRITABLE.test(path);

/** A local path Explorer can reveal. */
export const isLocalPath = (p: string | null | undefined): p is string => !!p && /^[a-z]:\\/i.test(p);

export const baseName = (p: string) => p.slice(Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")) + 1);

/** "Yes"/"No" for booleans, "" for null. */
export const yesNo = (v: boolean | null | undefined) => (v === null || v === undefined ? "" : v ? "Yes" : "No");

export interface Recent {
  pid: number;
  name: string;
}
