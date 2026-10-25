// Small canvas area chart for the sysinfo cards. Colors are CSS variable names
// resolved at draw time, so theme switches apply on the next frame.
import { useEffect, useRef, useState, type ReactNode } from "react";
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

/** room at the right edge for the current-value marker */
const PAD_RIGHT = 6;
const PAD_Y = 3;

/** Index of the sample drawn nearest to `x`, or -1 left of the oldest one. */
function sampleAt(x: number, width: number, capacity: number, n: number): number {
  const step = (width - PAD_RIGHT) / Math.max(1, capacity - 1);
  const i = n - 1 - Math.round((width - PAD_RIGHT - x) / step);
  return i >= 0 && i < n ? i : -1;
}

function ago(secs: number): string {
  if (secs < 1) return "now";
  if (secs < 60) return `${Math.round(secs)}s ago`;
  return `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s ago`;
}

export function Chart({
  series,
  max,
  capacity,
  stepMs,
  format,
  fillAlpha = 0.3,
  className,
  children,
}: {
  series: ChartSeries[];
  max: number;
  /** number of samples the full width represents (newest is at the right edge) */
  capacity: number;
  /** time between samples, for the hover readout */
  stepMs: number;
  /** value text in the hover readout */
  format: (v: number) => string;
  fillAlpha?: number;
  className?: string;
  /** overlay content (axis labels) */
  children?: ReactNode;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** pointer position over the chart (CSS px) and the chart width at that moment */
  const [hover, setHover] = useState<{ x: number; w: number } | null>(null);
  const props = useRef({ series, max, capacity, fillAlpha, hover });
  props.current = { series, max, capacity, fillAlpha, hover };

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

    const { series, max, capacity, fillAlpha, hover } = props.current;
    const plotW = width - PAD_RIGHT;
    const step = plotW / Math.max(1, capacity - 1);
    const yOf = (v: number) => height - PAD_Y - clamp(max > 0 ? v / max : 0, 0, 1) * (height - PAD_Y * 2);

    // grid: quarter lines
    ctx.strokeStyle = withAlpha(cssVar("--border", "#262e3a"), 0.75);
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = Math.round(PAD_Y + ((height - PAD_Y * 2) * i) / 4) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    const surface = cssVar("--surface", "#151a21");
    const drawn = series
      .filter((s) => s.data.length)
      .map((s) => {
        const n = s.data.length;
        const color = cssVar(s.color, "#7c9cff");
        const pts = s.data.map((v, i): [number, number] => [plotW - (n - 1 - i) * step, yOf(v)]);
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
        return { s, n, color, pts, line, last };
      });

    // fills first so no series hides another one's line; the gradient starts at
    // the series' peak so low values still get a visible fill
    for (const { color, pts, line, last } of drawn) {
      const area = new Path2D(line);
      area.lineTo(last[0], height);
      area.lineTo(pts[0][0], height);
      area.closePath();
      const top = Math.min(...pts.map((p) => p[1]));
      const grad = ctx.createLinearGradient(0, top, 0, height);
      grad.addColorStop(0, withAlpha(color, fillAlpha));
      grad.addColorStop(1, withAlpha(color, fillAlpha * 0.12));
      ctx.fillStyle = grad;
      ctx.fill(area);
    }
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const { color, line } of drawn) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke(line);
    }

    const dot = (x: number, y: number, color: string) => {
      ctx.fillStyle = withAlpha(color, 0.25);
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.strokeStyle = surface;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    };

    const hi = hover && drawn.length ? sampleAt(hover.x, width, capacity, drawn[0].n) : -1;
    if (hi >= 0) {
      const x = Math.round(plotW - (drawn[0].n - 1 - hi) * step) + 0.5;
      ctx.strokeStyle = withAlpha(cssVar("--text-dim", "#8892a3"), 0.55);
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const { s, color } of drawn) dot(x, yOf(s.data[hi]), color);
    } else {
      // current-value marker
      for (const { color, last } of drawn) dot(last[0], last[1], color);
    }
  };

  // redraw after every render (new samples, hover)
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

  const onPointerMove = (e: React.PointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    // snapped to the sample grid, so moving within one sample doesn't re-render
    const step = (r.width - PAD_RIGHT) / Math.max(1, capacity - 1);
    const x = r.width - PAD_RIGHT - Math.round((r.width - PAD_RIGHT - (e.clientX - r.left)) / step) * step;
    setHover((h) => (h && h.x === x && h.w === r.width ? h : { x, w: r.width }));
  };

  // hover readout: values under the pointer and how long ago they were sampled
  let tip: ReactNode = null;
  const n = series[0]?.data.length ?? 0;
  const hi = hover ? sampleAt(hover.x, hover.w, capacity, n) : -1;
  if (hover && hi >= 0) {
    tip = (
      <div className={cx("sysinfo-tip", hover.x > hover.w / 2 && "flip")} style={{ left: hover.x }}>
        {series.map((s, k) => (
          <span key={k} className="sysinfo-tip-value">
            {series.length > 1 && <span className="sysinfo-dot" style={{ background: `var(${s.color})` }} />}
            {format(s.data[hi] ?? 0)}
          </span>
        ))}
        <span className="dim">{ago(((n - 1 - hi) * stepMs) / 1000)}</span>
      </div>
    );
  }

  return (
    <div ref={wrapRef} className={cx("sysinfo-chart", className)} onPointerMove={onPointerMove} onPointerLeave={() => setHover(null)}>
      <canvas ref={canvasRef} />
      {children}
      {tip}
    </div>
  );
}
