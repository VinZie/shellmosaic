// Access masks: what a handle's granted access means, per object type.
import type { ProcHandle } from "../../../shared";

type Bits = [name: string, bit: number][];

const STANDARD: Bits = [
  ["DELETE", 0x10000],
  ["READ_CONTROL", 0x20000],
  ["WRITE_DAC", 0x40000],
  ["WRITE_OWNER", 0x80000],
  ["SYNCHRONIZE", 0x100000],
];

const TYPES: Record<string, { all?: [string, number]; bits: Bits }> = {
  Process: {
    all: ["ALL_ACCESS", 0x1fffff],
    bits: [
      ["TERMINATE", 0x1],
      ["CREATE_THREAD", 0x2],
      ["VM_OPERATION", 0x8],
      ["VM_READ", 0x10],
      ["VM_WRITE", 0x20],
      ["DUP_HANDLE", 0x40],
      ["CREATE_PROCESS", 0x80],
      ["SET_QUOTA", 0x100],
      ["SET_INFORMATION", 0x200],
      ["QUERY_INFORMATION", 0x400],
      ["SUSPEND_RESUME", 0x800],
      ["QUERY_LIMITED_INFORMATION", 0x1000],
    ],
  },
  Thread: {
    all: ["ALL_ACCESS", 0x1fffff],
    bits: [
      ["TERMINATE", 0x1],
      ["SUSPEND_RESUME", 0x2],
      ["GET_CONTEXT", 0x8],
      ["SET_CONTEXT", 0x10],
      ["SET_INFORMATION", 0x20],
      ["QUERY_INFORMATION", 0x40],
      ["SET_THREAD_TOKEN", 0x80],
      ["IMPERSONATE", 0x100],
      ["DIRECT_IMPERSONATION", 0x200],
      ["SET_LIMITED_INFORMATION", 0x400],
      ["QUERY_LIMITED_INFORMATION", 0x800],
    ],
  },
  File: {
    all: ["ALL_ACCESS", 0x1f01ff],
    bits: [
      ["READ_DATA", 0x1],
      ["WRITE_DATA", 0x2],
      ["APPEND_DATA", 0x4],
      ["READ_EA", 0x8],
      ["WRITE_EA", 0x10],
      ["EXECUTE", 0x20],
      ["DELETE_CHILD", 0x40],
      ["READ_ATTRIBUTES", 0x80],
      ["WRITE_ATTRIBUTES", 0x100],
    ],
  },
  Key: {
    all: ["ALL_ACCESS", 0xf003f],
    bits: [
      ["QUERY_VALUE", 0x1],
      ["SET_VALUE", 0x2],
      ["CREATE_SUB_KEY", 0x4],
      ["ENUMERATE_SUB_KEYS", 0x8],
      ["NOTIFY", 0x10],
      ["CREATE_LINK", 0x20],
    ],
  },
};

const hx = (n: number) => "0x" + (n >>> 0).toString(16);

/** The granted rights by name, e.g. ["VM_READ", "QUERY_INFORMATION", "SYNCHRONIZE"]. */
export function accessParts(type: string, access: number): [string, number][] {
  const spec = TYPES[type];
  let left = access >>> 0;
  const out: [string, number][] = [];
  if (spec?.all && (left & spec.all[1]) === spec.all[1]) {
    out.push(spec.all);
    left &= ~spec.all[1];
  } else {
    for (const [n, b] of spec?.bits ?? []) if (left & b) (out.push([n, b]), (left &= ~b));
    for (const [n, b] of STANDARD) if (left & b) (out.push([n, b]), (left &= ~b));
  }
  if (left >>> 0) out.push([spec ? "other" : "specific", left >>> 0]);
  return out;
}

export function accessNames(type: string, access: number): string {
  return accessParts(type, access)
    .map(([n, b]) => (n === "other" || n === "specific" ? hx(b) : n))
    .join(", ");
}

/** Multi-line tooltip: the mask, then one right per line. */
export function accessTooltip(type: string, access: number): string {
  const parts = accessParts(type, access);
  if (!parts.length) return `${hx(access)}: no access`;
  return [`${type} access ${hx(access)}`, ...parts.map(([n, b]) => `  ${n === "other" || n === "specific" ? `${n} rights` : n}  ${hx(b)}`)].join("\n");
}

export function attributeNames(attr: number): string {
  const out: string[] = [];
  if (attr & 0x2) out.push("Inherit");
  if (attr & 0x1) out.push("Protect from close");
  if (attr & 0x4) out.push("Audit on close");
  return out.join(", ");
}

const VM_OPERATION = 0x8;
const VM_READ = 0x10;
const VM_WRITE = 0x20;
const CREATE_THREAD = 0x2;
const ALL = 0x1fffff;
const SET_CONTEXT = 0x10;

/**
 * How interesting a handle is to someone hunting for cross-process access:
 * 2 = can write another process's memory (or full access), 1 = can read it / hijack its threads.
 */
export function handleRisk(h: ProcHandle, ownPid: number): 0 | 1 | 2 {
  if (h.targetPid === null || h.targetPid === ownPid) return 0;
  const a = h.access >>> 0;
  if (h.type === "Process") {
    if ((a & ALL) === ALL || a & VM_WRITE || (a & VM_OPERATION && a & CREATE_THREAD)) return 2;
    if (a & VM_READ) return 1;
  } else if (h.type === "Thread") {
    if ((a & ALL) === ALL || a & SET_CONTEXT) return 1;
  }
  return 0;
}

export function riskText(h: ProcHandle, risk: number): string {
  if (!risk) return "";
  if (h.type === "Thread") return "Can change the context of another process's thread (thread hijacking)";
  return risk === 2 ? "Can write another process's memory (or has full access to it)" : "Can read another process's memory";
}
