// Small canvas area chart for the sysinfo cards. Colors are CSS variable names
// resolved at draw time, so theme switches apply on the next frame.
import { useEffect, useRef, type ReactNode } from "react";
import { clamp, cx, withAlpha } from "../../lib/util";
import { useSettings } from "../../state/settings";
import { useThemes } from "../../state/themes";

export interface ChartSeries {
  data: number[];
  /** CSS variable holding the series color, e.g. "--accent" */
  color: string;
}

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function Chart({
  series,
  max,
  capacity,
  fillAlpha = 0.38,
  className,
  children,
}: {
  series: ChartSeries[];
  max: number;
  /** number of samples the full width represents (newest is at the right edge) */
  capacity: number;
  fillAlpha?: number;
  className?: string;
  /** overlay content (axis labels) */
  children?: ReactNode;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const props = useRef({ series, max, capacity, fillAlpha });
  props.current = { series, max, capacity, fillAlpha };

  const draw = useRef(() => {});
  draw.current = () => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const { width, height } = wrap.getBoundingClientRect();
    if (width < 2 || height < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(width * dpr);
    const ph = Math.round(height * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const { series, max, capacity, fillAlpha } = props.current;

    // grid
    ctx.strokeStyle = withAlpha(cssVar("--border", "#262e3a"), 0.9);
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    for (let i = 1; i < 4; i++) {
      const y = Math.round((height * i) / 4) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    const pad = 2;
    const step = width / Math.max(1, capacity - 1);
    const yOf = (v: number) => height - pad - clamp(max > 0 ? v / max : 0, 0, 1) * (height - pad * 2);

    for (const s of series) {
      const n = s.data.length;
      if (!n) continue;
      const color = cssVar(s.color, "#7c9cff");
      const pts = s.data.map((v, i): [number, number] => [width - (n - 1 - i) * step, yOf(v)]);
      if (pts.length === 1) pts.unshift([pts[0][0] - step, pts[0][1]]);

      // smooth line through midpoints (stays within the data range, no overshoot)
      const line = new Path2D();
      line.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i][0] + pts[i + 1][0]) / 2;
        const my = (pts[i][1] + pts[i + 1][1]) / 2;
        line.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
      }
      const last = pts[pts.length - 1];
      line.lineTo(last[0], last[1]);

      const area = new Path2D(line);
      area.lineTo(last[0], height);
      area.lineTo(pts[0][0], height);
      area.closePath();
      const grad = ctx.createLinearGradient(0, 0, 0, height);
      grad.addColorStop(0, withAlpha(color, fillAlpha));
      grad.addColorStop(1, withAlpha(color, 0.02));
      ctx.fillStyle = grad;
      ctx.fill(area);

      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke(line);

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(last[0] - 2, last[1], 2.25, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  // redraw after every render (new samples)
  useEffect(() => draw.current());

  // redraw on resize, DPI change and theme/settings change. applyTheme runs in an
  // effect after settings change, so wait a beat before reading the variables.
  useEffect(() => {
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const now = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => draw.current());
    };
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(now, 40);
    };
    const ro = new ResizeObserver(now);
    if (wrapRef.current) ro.observe(wrapRef.current);
    window.addEventListener("resize", now);
    const unSettings = useSettings.subscribe(later);
    const unThemes = useThemes.subscribe(later);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", now);
      unSettings();
      unThemes();
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, []);

  return (
    <div ref={wrapRef} className={cx("sysinfo-chart", className)}>
      <canvas ref={canvasRef} />
      {children}
    </div>
  );
}
