import { useMemo } from "react";

/** Minimal SVG price line: no chart library, crisp at any width. */
export function PriceChart({ points, symbol }: { points: { t: number; p: number }[]; symbol: string }) {
  const W = 720,
    H = 220,
    P = 10;
  const d = useMemo(() => {
    if (points.length < 2) return null;
    const ps = points.map((x) => x.p);
    const lo = Math.min(...ps),
      hi = Math.max(...ps);
    const span = hi - lo || hi * 0.1 || 1;
    const x = (i: number) => P + (i / (points.length - 1)) * (W - 2 * P);
    const y = (p: number) => H - P - ((p - lo) / span) * (H - 2 * P);
    const line = points.map((pt, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(pt.p).toFixed(1)}`).join(" ");
    return { line, area: `${line} L${x(points.length - 1)},${H - P} L${P},${H - P} Z`, up: ps[ps.length - 1] >= ps[0] };
  }, [points]);

  if (!d)
    return (
      <div className="chart-empty">
        <span className="muted">No trades yet. The chart starts with the first {symbol} swap.</span>
      </div>
    );
  const c = d.up ? "#4ade80" : "#fb7185";
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${symbol} price history`}>
      <defs>
        <linearGradient id="pc" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={c} stopOpacity=".25" />
          <stop offset="1" stopColor={c} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={d.area} fill="url(#pc)" />
      <path d={d.line} fill="none" stroke={c} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
