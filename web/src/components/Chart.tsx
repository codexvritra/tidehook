import { useMemo } from "react";
import { priceParts } from "../lib/price";

function label(p: number): string {
  const parts = priceParts(p);
  if ("plain" in parts) return parts.plain;
  return `0.0{${parts.zeros}}${parts.digits}`.replace(/\{(\d+)\}/, (_, z) => `(${z})`);
}

/** Terminal-style step chart of the price after every swap. No chart library, crisp at any width. */
export function PriceChart({ points, symbol }: { points: { t: number; p: number }[]; symbol: string }) {
  const W = 900,
    H = 340,
    PL = 8,
    PR = 92,
    PT = 16,
    PB = 18;
  const d = useMemo(() => {
    if (points.length < 2) return null;
    const ps = points.map((x) => x.p);
    let lo = Math.min(...ps),
      hi = Math.max(...ps);
    const pad = (hi - lo) * 0.12 || hi * 0.05 || 1;
    lo -= pad;
    hi += pad;
    const x = (i: number) => PL + (i / (points.length - 1)) * (W - PL - PR);
    const y = (p: number) => PT + (1 - (p - lo) / (hi - lo)) * (H - PT - PB);
    let line = `M${x(0).toFixed(1)},${y(ps[0]).toFixed(1)}`;
    for (let i = 1; i < ps.length; i++) line += ` H${x(i).toFixed(1)} V${y(ps[i]).toFixed(1)}`;
    const grid = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * (i + 0.5)) / 5);
    const last = ps[ps.length - 1];
    return { line, area: `${line} V${H - PB} H${x(0)} Z`, grid, y, last, lastY: y(last), lastX: x(ps.length - 1), up: last >= ps[0] };
  }, [points]);

  if (!d) return <div className="chart-empty">No trades yet. The chart starts with the first {symbol} swap.</div>;
  const c = d.up ? "#2bc235" : "#f23645";
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${symbol} price after each trade`}>
      <defs>
        <linearGradient id="pc" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={c} stopOpacity=".22" />
          <stop offset="1" stopColor={c} stopOpacity="0" />
        </linearGradient>
      </defs>
      {d.grid.map((g) => (
        <g key={g}>
          <line x1={PL} x2={W - PR} y1={d.y(g)} y2={d.y(g)} stroke="#1f2937" strokeDasharray="3 5" vectorEffect="non-scaling-stroke" />
          <text x={W - PR + 8} y={d.y(g) + 3}>
            {label(g)}
          </text>
        </g>
      ))}
      <line x1={W - PR} x2={W - PR} y1={PT} y2={H - PB} stroke="#1f2937" vectorEffect="non-scaling-stroke" />
      <path d={d.area} fill="url(#pc)" />
      <path d={d.line} fill="none" stroke={c} strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
      <line x1={PL} x2={W - PR} y1={d.lastY} y2={d.lastY} stroke={c} strokeOpacity=".5" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
      <rect x={W - PR + 2} y={d.lastY - 9} width={PR - 4} height={18} fill={c} />
      <text x={W - PR + 8} y={d.lastY + 3.5} style={{ fill: "#fff", fontWeight: 700 }}>
        {label(d.last)}
      </text>
    </svg>
  );
}
