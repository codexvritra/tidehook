import { useEffect, useMemo, useRef, useState } from "react";
import { ColorType, CrosshairMode, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { priceParts } from "../lib/price";

export type Tick = { time: number; price: number; volume: number; buy: boolean };

const FRAMES = [
  ["1m", 60],
  ["5m", 300],
  ["15m", 900],
  ["1h", 3600],
  ["4h", 14400],
  ["D", 86400],
] as const;

const SUBS = "₀₁₂₃₄₅₆₇₈₉";
/** Price label with subscript zeros (0.0₈82), like the rest of the app. */
function fmt(p: number): string {
  if (!isFinite(p)) return "";
  if (p >= 1e6) return `${(p / 1e6).toFixed(2)}M`;
  if (p >= 1e3) return `${(p / 1e3).toFixed(2)}K`;
  const parts = priceParts(p);
  if ("plain" in parts) return parts.plain;
  return `0.0${[...String(parts.zeros)].map((d) => SUBS[Number(d)]).join("")}${parts.digits}`;
}

function candles(ticks: Tick[], frame: number, scale: number) {
  const out: { time: UTCTimestamp; open: number; high: number; low: number; close: number }[] = [];
  const vol: { time: UTCTimestamp; value: number; color: string }[] = [];
  let prev: number | null = null;
  for (const t of ticks) {
    const bucket = (Math.floor(t.time / frame) * frame) as UTCTimestamp;
    const p = t.price * scale;
    const last = out[out.length - 1];
    if (last && last.time === bucket) {
      last.high = Math.max(last.high, p);
      last.low = Math.min(last.low, p);
      last.close = p;
      vol[vol.length - 1].value += t.volume;
    } else {
      const open = prev ?? p;
      out.push({ time: bucket, open, high: Math.max(open, p), low: Math.min(open, p), close: p });
      vol.push({ time: bucket, value: t.volume, color: "" });
    }
    prev = p;
  }
  out.forEach((c, i) => (vol[i].color = c.close >= c.open ? "rgba(43,194,53,.45)" : "rgba(242,54,69,.45)"));
  return { out, vol };
}

/** TradingView-style candles built from on-chain swaps: timeframes, volume, price or market cap. */
export function CandleChart({ ticks, symbol, quote, supply }: { ticks: Tick[]; symbol: string; quote: string; supply: number }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<{ c: ISeriesApi<"Candlestick">; v: ISeriesApi<"Histogram"> } | null>(null);
  const [frame, setFrame] = useState<number>(() => {
    const span = ticks.length > 1 ? ticks[ticks.length - 1].time - ticks[0].time : 0;
    return span > 7 * 86400 ? 3600 : span > 86400 ? 900 : 60;
  });
  const [mode, setMode] = useState<"price" | "mcap">("price");
  // The chart can't step below ~1e-10, so values are shifted by 10^k into a sane range and labels shift back.
  const data = useMemo(() => {
    const unit = mode === "mcap" ? supply : 1;
    const max = Math.max(...ticks.map((t) => t.price * unit), 1e-30);
    const k = Math.max(0, Math.ceil(-Math.log10(max)) + 3);
    return { ...candles(ticks, frame, unit * 10 ** k), k };
  }, [ticks, frame, mode, supply]);
  const shift = useRef(0);
  shift.current = data.k;

  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "#070808" }, textColor: "#9ca3af", fontFamily: "JetBrains Mono, monospace", fontSize: 11 },
      grid: { vertLines: { color: "#12161a" }, horzLines: { color: "#12161a" } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#1f2937", scaleMargins: { top: 0.1, bottom: 0.25 } },
      timeScale: { borderColor: "#1f2937", timeVisible: true, secondsVisible: false, rightOffset: 4 },
      localization: { priceFormatter: (v: number) => fmt(v / 10 ** shift.current) },
    });
    const cs = c.addCandlestickSeries({
      upColor: "#2bc235",
      downColor: "#f23645",
      borderVisible: false,
      wickUpColor: "#2bc235",
      wickDownColor: "#f23645",
      priceFormat: { type: "custom", formatter: (v: number) => fmt(v / 10 ** shift.current), minMove: 0.0001 },
    });
    const vs = c.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    chart.current = c;
    series.current = { c: cs, v: vs };
    return () => {
      c.remove();
      chart.current = null;
      series.current = null;
    };
  }, []);

  useEffect(() => {
    if (!series.current) return;
    series.current.c.setData(data.out);
    series.current.v.setData(data.vol);
    chart.current?.timeScale().fitContent();
  }, [data]);

  const last = data.out[data.out.length - 1];
  return (
    <div className="cchart">
      <div className="cchart-bar">
        {FRAMES.map(([label, s]) => (
          <button key={label} className={frame === s ? "on" : ""} onClick={() => setFrame(s)}>
            {label}
          </button>
        ))}
        <span className="cchart-sep" />
        <button className={mode === "price" ? "on" : ""} onClick={() => setMode("price")}>
          Price
        </button>
        <span className="dim">/</span>
        <button className={mode === "mcap" ? "on" : ""} onClick={() => setMode("mcap")}>
          MCap
        </button>
        {last && (
          <span className="cchart-ohlc">
            {symbol}/{quote} · O <b>{fmt(last.open / 10 ** data.k)}</b> H <b>{fmt(last.high / 10 ** data.k)}</b> L <b>{fmt(last.low / 10 ** data.k)}</b> C{" "}
            <b className={last.close >= last.open ? "up" : "down"}>{fmt(last.close / 10 ** data.k)}</b>
          </span>
        )}
      </div>
      <div className="cchart-box" ref={box}>
        {ticks.length < 2 && <div className="chart-empty">No trades yet. Candles start with the first {symbol} swap.</div>}
      </div>
    </div>
  );
}
