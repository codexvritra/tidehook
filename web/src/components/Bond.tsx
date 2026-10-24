import { useState } from "react";
import { bondStep, canClaim, canSlash, type BondState } from "../lib/model";
import { Kicker } from "./ui";
import { fmtDuration } from "../lib/format";

const GRACE = 86_400;
const H = 3600;

type Entry = { t: number; text: string; tone?: "good" | "bad" };
type Sim = { now: number; below: boolean; b: BondState; log: Entry[] };

const start = (): Sim => ({
  now: 0,
  below: false,
  b: { isBelow: false, belowSince: 0, aboveSince: 0, slashed: false },
  log: [{ t: 0, text: "Creator bonds 1,000,000 tokens, floor = launch price, grace = 24h" }],
});

export function Bond() {
  const [s, setS] = useState<Sim>(start);
  const claim = canClaim(s.b, s.now, GRACE);
  const slash = canSlash(s.b, s.now, GRACE);

  const push = (next: Partial<Sim>, e: Entry) => setS((p) => ({ ...p, ...next, log: [e, ...p.log] }));

  function swapTo(below: boolean, text: string) {
    push({ below, b: bondStep(s.b, below, s.now, GRACE) }, { t: s.now, text });
  }

  function flashPump() {
    // Buy above floor, try to claim, dump back, all in one transaction.
    const up = bondStep(s.b, false, s.now, GRACE);
    const ok = canClaim(up, s.now, GRACE);
    const down = bondStep(up, true, s.now, GRACE);
    push(
      { below: true, b: down },
      {
        t: s.now,
        text: ok ? "Flash pump claimed (should never happen)" : "Flash pump: buy → claim → dump in one tx. Claim reverts: FloorNotHeld(0, 24h)",
        tone: ok ? "bad" : "good",
      },
    );
  }

  function wait(sec: number) {
    push({ now: s.now + sec }, { t: s.now + sec, text: `${fmtDuration(sec)} pass with price ${s.below ? "below" : "above"} the floor` });
  }

  function doSlash() {
    push({ b: { ...s.b, slashed: true } }, { t: s.now, text: "Anyone calls slash(): every unclaimed token is burned", tone: "bad" });
  }

  function doClaim() {
    push({}, { t: s.now, text: "Creator claims their vested tokens", tone: "good" });
  }

  const status = s.b.slashed
    ? { cls: "warn", text: "Slashed: unvested supply burned" }
    : slash
      ? { cls: "warn", text: "Slashable now" }
      : claim
        ? { cls: "ok", text: "Creator can claim" }
        : s.b.isBelow
          ? { cls: "moon", text: `Below floor: slash in ${fmtDuration(Math.max(0, GRACE - (s.now - s.b.belowSince)))}` }
          : { cls: "moon", text: `Floor must hold another ${fmtDuration(Math.max(0, GRACE - (s.now - s.b.aboveSince)))}` };

  return (
    <section id="bond">
      <div className="wrap hook">
        <div className="copy">
          <Kicker n="03">CreatorBondHook</Kicker>
          <h2>
            The creator's tokens <em>back the floor.</em>
          </h2>
          <p>
            The creator locks up their own allocation and picks a floor price. It unlocks over time, but they can
            only collect it once the price has stayed at or above the floor for a full grace period. If the price
            stays below the floor that long, anyone can trigger the slash and every token the creator hasn't
            collected is burned.
          </p>
          <ul className="facts">
            <li><span>→</span><span><b>Flash pumps can't claim.</b> Pumping the price, claiming and dumping in one transaction reverts.</span></li>
            <li><span>→</span><span><b>Round trips can't stall a slash.</b> A short stint above the floor doesn't restart the timer.</span></li>
            <li><span>→</span><span><b>No squatting.</b> Only whoever created the pool can bond, so nobody can grab the slot with a dust bond.</span></li>
          </ul>
        </div>

        <div className="panel">
          <div className="panel-head">
            <span className="tag">State machine · matches afterSwap()</span>
            <span className={`pill ${status.cls}`}>{status.text}</span>
          </div>
          <div className="actions">
            <button className="btn small" disabled={s.b.slashed} onClick={() => swapTo(true, "Sell-off pushes price below the floor")}>Price falls below floor</button>
            <button className="btn small" disabled={s.b.slashed} onClick={() => swapTo(false, "Buyers lift price back above the floor")}>Price recovers</button>
            <button className="btn small" disabled={s.b.slashed || !s.below} onClick={flashPump}>Try a flash pump</button>
          </div>
          <div className="actions" style={{ marginTop: 8 }}>
            <button className="btn small" disabled={s.b.slashed} onClick={() => wait(6 * H)}>+6h</button>
            <button className="btn small" disabled={s.b.slashed} onClick={() => wait(24 * H)}>+24h</button>
            <button className="btn small primary" disabled={!claim} onClick={doClaim}>claim()</button>
            <button className="btn small" disabled={!slash} onClick={doSlash} style={slash ? { borderColor: "var(--warn)", color: "var(--warn)" } : undefined}>slash()</button>
            <button className="btn small" onClick={() => setS(start())}>Reset</button>
          </div>
          <ul className="log" aria-live="polite">
            {s.log.map((e, i) => (
              <li key={s.log.length - i} className={e.tone ?? ""}>
                <span className="t">t+{fmtDuration(e.t)}</span>
                <span>{e.text}</span>
                <span />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
