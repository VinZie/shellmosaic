// Authenticode checks, fetched in the background (a few at a time) and cached per
// path for the life of the pane, so the Modules tab fills its Signature column as
// results come in without blocking anything.
import { useEffect, useState } from "react";
import { ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import { Chip, errorText, sm, type Signature } from "../../../shared";

export type SigEntry = { state: "pending" } | { state: "done"; sig: Signature } | { state: "error"; message: string };

const MAX_PARALLEL = 4;
const cache = new Map<string, SigEntry>();
const queue: string[] = [];
let running = 0;
let version = 0;
let scheduled = false;
const listeners = new Set<() => void>();

const keyOf = (path: string) => path.toLowerCase();

/** Results arrive in bursts; tell the UI at most every ~80 ms. */
function changed() {
  version++;
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    listeners.forEach((l) => l());
  }, 80);
}

function pump() {
  while (running < MAX_PARALLEL && queue.length) {
    const path = queue.shift()!;
    const k = keyOf(path);
    running++;
    sm.process
      .signature(path)
      .then(
        (sig) => cache.set(k, { state: "done", sig }),
        (e) => cache.set(k, { state: "error", message: errorText(e) }),
      )
      .finally(() => {
        running--;
        changed();
        pump();
      });
  }
}

/** Queue a check unless it's cached (or queued) already; `urgent` jumps the queue. */
export function requestSignature(path: string | null | undefined, urgent = false) {
  if (!path) return;
  const k = keyOf(path);
  const cur = cache.get(k);
  if (cur) {
    if (urgent && cur.state === "pending") {
      const i = queue.findIndex((p) => keyOf(p) === k);
      if (i > 0) queue.unshift(...queue.splice(i, 1));
    }
    return;
  }
  cache.set(k, { state: "pending" });
  if (urgent) queue.unshift(path);
  else queue.push(path);
  pump();
}

/** Check again now, ignoring the cache. */
export async function checkSignatureNow(path: string): Promise<Signature> {
  const k = keyOf(path);
  cache.set(k, { state: "pending" });
  changed();
  try {
    const sig = await sm.process.signature(path);
    cache.set(k, { state: "done", sig });
    return sig;
  } catch (e) {
    cache.set(k, { state: "error", message: errorText(e) });
    throw e;
  } finally {
    changed();
  }
}

export const getSignature = (path: string | null | undefined): SigEntry | undefined => (path ? cache.get(keyOf(path)) : undefined);

/** Re-renders whenever new results arrive; the number changes each time. */
export function useSignatureVersion(): number {
  const [v, setV] = useState(version);
  useEffect(() => {
    const l = () => setV(version);
    listeners.add(l);
    l();
    return () => {
      listeners.delete(l);
    };
  }, []);
  return v;
}

export function useSignature(path: string | null | undefined, urgent = false): SigEntry | undefined {
  useSignatureVersion();
  useEffect(() => {
    requestSignature(path, urgent);
  }, [path, urgent]);
  return getSignature(path);
}

/** For sorting: trusted first, then unknown, unsigned, invalid. */
export function sigRank(e: SigEntry | undefined): number {
  if (!e || e.state === "pending") return 5;
  if (e.state === "error") return 4;
  return { valid: 0, unknown: 1, unsigned: 2, invalid: 3 }[e.sig.status] ?? 4;
}

export function sigText(e: SigEntry | undefined): string {
  if (!e || e.state === "pending") return "Checking…";
  if (e.state === "error") return `Couldn't check: ${e.message}`;
  const s = e.sig;
  switch (s.status) {
    case "valid":
      return s.signer ? `Signed · ${s.signer}` : "Signed";
    case "unsigned":
      return "Not signed";
    case "invalid":
      return `Invalid signature: ${s.detail}`;
    default:
      return s.detail || "Signature unknown";
  }
}

export function SigChip({ entry }: { entry: SigEntry | undefined }) {
  if (!entry || entry.state === "pending") return <Chip tone="dim">Checking signature…</Chip>;
  if (entry.state === "error")
    return (
      <Chip tone="dim" title={entry.message}>
        <span>Couldn't check signature</span>
      </Chip>
    );
  const s = entry.sig;
  const title = [s.detail, s.signer && `Signer: ${s.signer}`, s.catalog && "Signed through a security catalog"].filter(Boolean).join("\n");
  const text = <span>{sigText(entry)}</span>;
  switch (s.status) {
    case "valid":
      return (
        <Chip tone="success" title={title} icon={<ShieldCheck size={12} />}>
          {text}
        </Chip>
      );
    case "unsigned":
      return (
        <Chip tone="warning" title={title} icon={<ShieldAlert size={12} />}>
          {text}
        </Chip>
      );
    case "invalid":
      return (
        <Chip tone="danger" title={title} icon={<ShieldX size={12} />}>
          {text}
        </Chip>
      );
    default:
      return (
        <Chip tone="dim" title={title}>
          {text}
        </Chip>
      );
  }
}
