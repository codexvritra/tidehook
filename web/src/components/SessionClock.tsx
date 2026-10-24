import { useEffect, useMemo, useState } from "react";
import { sessionHookAbi } from "../lib/abis";
import { HOOKS, client } from "../lib/chain";
import { SCHEDULE, SESSIONS, SESSION_FEES, pct, sessionAt, type Session } from "../lib/model";
import { useNow } from "../lib/wallet";
import { Kicker } from "./ui";
import { fmtDuration } from "../lib/format";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function segments(weekday: number): { s: Session; from: number; to: number }[] {
  if (weekday >= 5) return [{ s: "Weekend", from: 0, to: 24 }];
  const h = (x: number) => x / 3600;
  return [
    { s: "Closed", from: 0, to: h(SCHEDULE.preOpen) },
    { s: "Extended", from: h(SCHEDULE.preOpen), to: h(SCHEDULE.open) },
    { s: "Regular", from: h(SCHEDULE.open), to: h(SCHEDULE.close) },
    { s: "Extended", from: h(SCHEDULE.close), to: h(SCHEDULE.postClose) },
  ];
}

function nextChange(now: number): { at: number; to: Session } {
  const cur = sessionAt(now);
  let t = now - (now % 60) + 60;
  for (let i = 0; i < 7 * 24 * 60; i++, t += 60) {
    const s = sessionAt(t);
    if (s !== cur) return { at: t, to: s };
  }
  return { at: t, to: cur };
}

export function SessionClock() {
  const now = useNow(1000);
  const session = sessionAt(now);
  const next = useMemo(() => nextChange(now), [Math.floor(now / 60)]); // eslint-disable-line react-hooks/exhaustive-deps
  const day = Math.floor(now / 86_400);
  const weekdayMon0 = (day + 3) % 7; // 0 = Monday
  const secOfDay = now % 86_400;

  const [onchain, setOnchain] = useState<number | null>(null);
  useEffect(() => {
    if (!HOOKS.session) return;
    const read = () =>
      client
        .readContract({ address: HOOKS.session!, abi: sessionHookAbi, functionName: "currentFee" })
        .then((f) => setOnchain(Number(f)))
        .catch(() => setOnchain(null));
    read();
    const id = setInterval(read, 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <section id="session">
      <div className="wrap hook">
        <div className="copy">
          <Kicker n="04">SessionHook</Kicker>
          <h2>
            Fees that follow <em>the market clock.</em>
          </h2>
          <p>
            Robinhood Chain pairs tokens with tokenized stocks. When the exchange is closed, the pool can't be
            arbitraged against the real market, so LPs carry the risk of a price gap at the next open. Trading
            never stops here. The fee rises while the market is closed to pay LPs for that risk.
          </p>
          <ul className="facts">
            <li><span>→</span><span><b>Regular hours stay cheap.</b> The real market keeps the pool honest, so the fee is just 0.05%.</span></li>
            <li><span>→</span><span><b>Weekends and holidays cost the most.</b> They're the longest gaps.</span></li>
            <li><span>→</span><span><b>Calendar can be updated.</b> DST shifts and exchange holidays change without a redeploy.</span></li>
          </ul>
        </div>

        <div className="panel">
          <div className="panel-head">
            <span className="tag">Live · matches sessionAt()</span>
            <span className="pill tide">{onchain !== null ? `on-chain ${pct(onchain)}` : "computed in your browser"}</span>
          </div>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end", marginBottom: 22 }}>
            <div>
              <div className="muted" style={{ fontSize: 13 }}>Right now · {session}</div>
              <div className="big-fee">{pct(SESSION_FEES[session])}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div className="muted" style={{ fontSize: 13 }}>Switches to {next.to} ({pct(SESSION_FEES[next.to])}) in</div>
              <div className="mono" style={{ fontSize: 22 }}>{fmtDuration(next.at - now)}</div>
            </div>
          </div>
          <div className="week">
            {DAYS.map((d, i) => (
              <div key={d} style={{ display: "contents" }}>
                <span className={`d ${i === weekdayMon0 ? "today" : ""}`}>{d}</span>
                <div className="bar">
                  {segments(i).map((g, j) => (
                    <i key={j} className={`s-${g.s}`} style={{ width: `${((g.to - g.from) / 24) * 100}%` }} title={`${g.s} · ${pct(SESSION_FEES[g.s])}`} />
                  ))}
                  {i === weekdayMon0 && <span className="now" style={{ left: `${(secOfDay / 86_400) * 100}%` }} />}
                </div>
              </div>
            ))}
          </div>
          <div className="week-axis">
            <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00 UTC</span>
          </div>
          <div className="legend">
            {SESSIONS.map((s) => (
              <span key={s}>
                <i className={`s-${s}`} />
                {s} {pct(SESSION_FEES[s])}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
