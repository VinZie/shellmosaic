// Access to the Shellmosaic SDK (window.shellmosaic, loaded by /__sdk/shellmosaic.js
// before the module's own script). In `pnpm modules:dev` there is no host: the
// module's dev-mock.ts installs a stand-in first.
import type { PaneContext, ShellmosaicSdk } from "./api";

type ReadyInfo = PaneContext & { theme?: Record<string, string> };

declare global {
  interface Window {
    shellmosaic?: ShellmosaicSdk & { ready?: Promise<ReadyInfo> };
  }
}

function host(): ShellmosaicSdk {
  const s = window.shellmosaic;
  if (!s) throw new Error("The Shellmosaic SDK isn't loaded");
  return s;
}

/** The SDK. Safe to import before it's loaded; use it after `ready()`. */
export const sm: ShellmosaicSdk = new Proxy({} as ShellmosaicSdk, {
  get: (_t, key) => (host() as unknown as Record<string | symbol, unknown>)[key],
});

let readyPromise: Promise<ReadyInfo> | null = null;

/** Resolves once the host answered `ready` (permissions asked, theme applied). */
export function ready(): Promise<ReadyInfo> {
  if (!readyPromise) {
    const own = window.shellmosaic?.ready;
    readyPromise =
      own ??
      new Promise<ReadyInfo>((resolve) =>
        window.addEventListener("shellmosaic:ready", (e) => resolve((e as CustomEvent<ReadyInfo>).detail), { once: true }),
      );
  }
  return readyPromise;
}

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** The backend says this failed for lack of rights (running as administrator may help). */
export function isAccessDenied(e: unknown): boolean {
  return /access (is )?denied/i.test(errorText(e));
}

/** Copy text through the host (needs the `clipboard` permission) and say so. */
export async function copy(text: string, what = "text") {
  try {
    await sm.clipboard.writeText(text);
    sm.ui.notify(`Copied ${what}`, "success");
  } catch (e) {
    sm.ui.notify(`Couldn't copy: ${errorText(e)}`, "error");
  }
}
