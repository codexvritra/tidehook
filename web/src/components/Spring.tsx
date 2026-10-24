import { useState } from "react";
import { SPRING, pct, relax, springFee } from "../lib/model";
import { Kicker, Range, Stat } from "./ui";

const SPAN = 400;

function Coil({ rest, tick }: { rest: number; tick: number }) {
  const W = 560, H = 160, mid = 82;
  const x = (t: number) => W / 2 + (Math.max(-SPAN, Math.min(SPAN, t - rest)) / SPAN) * (W / 2 - 30);
  const band = SPRING.band;
  const a = x(rest), b = x(tick);
  const n = 22;
  const stretch = Math.min(Math.abs(tick - rest) / SPAN, 1);
  const amp = 22 - stretch * 16;
  let d = `M ${a} ${mid}`;
  for (let i = 1; i < n; i++) d += ` L ${a + ((b - a) * i) / n} ${mid + (i % 2 ? -amp : amp)}`;
  d += ` L ${b} ${mid}`;
  const tense = Math.abs(tick - rest) > band;
  const color = tense ? (Math.abs(tick - rest) > 250 ? "#fb7185" : "#fbbf24") : "#5eead4";
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Spot price stretched away from the rest price">
      <rect x={x(rest - band)} y={22} width={x(rest + band) - x(rest - band)} height={H - 52} rx="8" fill="#5eead4" opacity=".07" />
      <line x1={24} x2={W - 24} y1={mid} y2={mid} stroke="#1c2946" />
      <path d={d} fill="none" stroke={color} strokeWidth="2.2" strokeLinejoin="round" />
      <line x1={a} x2={a} y1={26} y2={H - 30} stroke="#8b9abb" strokeDasharray="3 4" />
      <text x={a} y={16} textAnchor="middle">rest {rest}</text>
      {[-SPAN, -SPAN / 2, SPAN / 2, SPAN].map((d) => (
        <text key={d} x={x(rest + d)} y={mid + 34} textAnchor="middle" opacity=".6">{d > 0 ? "+" : ""}{d}</text>
      ))}
      <circle cx={b} cy={mid} r="11" fill="#05080f" stroke={color} strokeWidth="3" />
      <text x={b} y={H - 12} textAnchor="middle" style={{ fill: "#e6ecf7" }}>spot {tick - rest > 0 ? "+" : ""}{tick - rest} ticks</text>
    </svg>
  );
}

export function Spring() {
  const [rest, setRest] = useState(0);
  const [tick, setTick] = useState(-320);
  const [clock, setClock] = useState(0);
  const stretch = tick - rest;
  const below = stretch < 0;
  // The stretching direction moves price further from rest.
  const pushFee = springFee(tick, rest, below, false);
  const pullBounded = springFee(tick, rest, !below, true);
  const pullOpen = springFee(tick, rest, !below, false);

  function wait(sec: number) {
    setRest((r) => relax(r, tick, sec));
    setClock((c) => c + sec);
  }

  return (
    <section id="spring">
      <div className="wrap hook">
        <div className="copy">
          <Kicker n="02">SpringHook</Kicker>
          <h2>
            Fees that work like <em>a spring.</em>
          </h2>
          <p>
            The pool remembers where its price rests: a time-weighted average of the tick. Near rest, every swap pays
            the same. Pull the price away and each extra tick costs more. Swaps that bring the price back get the
            cheapest fill in the pool.
          </p>
          <ul className="facts">
            <li><span>→</span><span><b>Dumps price themselves.</b> The fee is base + stiffness × distance past the band (Hooke's law), up to a 5% cap.</span></li>
            <li><span>→</span><span><b>Can't be gamed inside one block.</b> Rest moves only as time passes, so a burst of swaps moves the price but not the anchor.</span></li>
            <li><span>→</span><span><b>No overshoot discount.</b> A restoring swap gets the 0.05% fee only if its price limit stops at rest.</span></li>
          </ul>
        </div>

        <div className="panel">
          <div className="panel-head">
            <span className="tag">Spring simulator · matches quoteFee()</span>
            <span className="pill">t + {Math.round(clock / 60)} min</span>
          </div>
          <Coil rest={rest} tick={tick} />
          <div className="field">
            <label>
              <span>Move spot (same block)</span>
              <span className="mono">tick {tick}</span>
            </label>
            <Range label="Spot tick" value={tick} min={rest - SPAN} max={rest + SPAN} onChange={setTick} />
          </div>
          <div className="stats">
            <Stat label={below ? "Sell further" : "Buy further"} value={pct(pushFee)} tone={pushFee > SPRING.baseFee ? "bad" : undefined} />
            <Stat label="Restore, limit at rest" value={pct(pullBounded)} tone={pullBounded < SPRING.baseFee ? "hi" : undefined} />
            <Stat label="Restore, open limit" value={pct(pullOpen)} />
          </div>
          <div className="actions" style={{ marginTop: 16 }}>
            <button className="btn small" onClick={() => wait(15 * 60)}>Let 15 min pass</button>
            <button className="btn small" onClick={() => wait(3600)}>Let 1 h pass</button>
            <button className="btn small" onClick={() => { setRest(0); setTick(-320); setClock(0); }}>Reset</button>
          </div>
          <p className="note">
            Drag the spot price as far as you like. The rest point stays put until time passes, which is how the
            contract treats swaps that land in the same block.
          </p>
        </div>
      </div>
    </section>
  );
}
