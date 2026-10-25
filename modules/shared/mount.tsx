import { StrictMode, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { Overlays } from "./overlays";
import { ready, sm } from "./sdk";
import "./ui.css";

/**
 * Native controls (checkboxes, select popups, scrollbars) follow `color-scheme`, which
 * otherwise tracks the OS setting rather than the app's theme: derive it from --sm-bg.
 */
function syncColorScheme() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--sm-bg").trim();
  if (!bg) return;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#000";
  ctx.fillStyle = bg; // normalized to #rrggbb or rgba(…)
  const c = ctx.fillStyle;
  const m = c.startsWith("#") ? [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) : (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  if (m.length < 3) return;
  const lum = (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255;
  document.documentElement.style.colorScheme = lum > 0.5 ? "light" : "dark";
}

/** Render the module's root component (with the menu/dialog layer) into #root. */
export function mount(App: ComponentType) {
  const el = document.getElementById("root") ?? document.body.appendChild(document.createElement("div"));
  el.id = "root";
  ready()
    .then(() => {
      syncColorScheme();
      sm.on("theme", () => requestAnimationFrame(syncColorScheme));
    })
    .catch(() => {});
  // the app's own shortcuts (Ctrl+Shift+P …) are forwarded by the SDK; keep the
  // webview's defaults (find, print, reload) from firing inside a module
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey && ["f", "p", "r", "g", "u"].includes(e.key.toLowerCase()) && !(e.target as HTMLElement).closest("input, textarea")) || e.key === "F5")
      e.preventDefault();
  });
  window.addEventListener("contextmenu", (e) => {
    // the webview's own menu (Back, Reload, Inspect) makes no sense here; text fields keep theirs
    if (!(e.target as HTMLElement).closest("input, textarea, .sm-selectable, .sm-code, .sm-kv-value")) e.preventDefault();
  });
  createRoot(el).render(
    <StrictMode>
      <App />
      <Overlays />
    </StrictMode>,
  );
}
