// Process actions and helpers shared by the Processes and Ports modules.
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorText, ipc } from "../../lib/ipc";
import { setPaneMeta } from "../../state/actions";
import type { Pane } from "../../state/model";
import { ui } from "../../state/ui";

/** Filter text that starts from `pane.meta.filter` and is saved back (debounced). */
export function usePaneFilter(pane: Pane): [string, (v: string) => void] {
  const [value, setValue] = useState<string>(() => (typeof pane.meta.filter === "string" ? pane.meta.filter : ""));
  const pending = useRef<{ timer: ReturnType<typeof setTimeout>; value: string } | null>(null);
  const paneId = pane.id;
  const save = useCallback((v: string) => setPaneMeta(paneId, { filter: v || null }), [paneId]);
  useEffect(
    () => () => {
      // flush a pending save when the pane unmounts
      if (pending.current) {
        clearTimeout(pending.current.timer);
        save(pending.current.value);
        pending.current = null;
      }
    },
    [save],
  );
  const set = useCallback(
    (v: string) => {
      setValue(v);
      if (pending.current) clearTimeout(pending.current.timer);
      pending.current = {
        value: v,
        timer: setTimeout(() => {
          pending.current = null;
          save(v);
        }, 600),
      };
    },
    [save],
  );
  return [value, set];
}

/** Ask, then end a process (or its whole tree). Resolves true when it was killed (or had already exited). */
export async function confirmEndProcess(p: { pid: number; name?: string | null }, tree = false): Promise<boolean> {
  const name = p.name || "Unknown process";
  const ok = await ui.confirm(
    tree ? "End process tree?" : "End process?",
    <>
      <b>{name}</b> (PID {p.pid}){tree ? " and every process it started" : ""} will be terminated immediately. Unsaved work
      in {tree ? "them" : "it"} will be lost.
    </>,
    { okLabel: tree ? "End process tree" : "End process", danger: true },
  );
  if (!ok) return false;
  // the row (and the dialog) can be seconds old and Windows reuses PIDs quickly: don't kill a stranger
  if (p.name) {
    const now = await ipc.procList().catch(() => null);
    const cur = now?.find((x) => x.pid === p.pid);
    if (now && cur?.name !== p.name) {
      ui.toast(`${name} (PID ${p.pid}) has already exited`, "info", 2200);
      return true;
    }
  }
  try {
    await ipc.procKill(p.pid, tree);
    ui.toast(`Ended ${name} (PID ${p.pid})`, "success", 2200);
    return true;
  } catch (e) {
    ui.toast(`Couldn't end ${name}: ${errorText(e)}`, "error");
    return false;
  }
}

export async function copyText(text: string, what = "text") {
  try {
    await writeText(text);
    ui.toast(`Copied ${what}`, "success", 1500);
  } catch (e) {
    ui.toast(errorText(e), "error");
  }
}

export async function revealPath(path: string) {
  try {
    await revealItemInDir(path);
  } catch (e) {
    ui.toast(`Couldn't open file location: ${errorText(e)}`, "error");
  }
}
