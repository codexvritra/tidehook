import { useMemo, useState } from "react";
import { encodeAbiParameters, getAddress, isAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { patienceHookAbi } from "../lib/abis";
import { HOOKS, client } from "../lib/chain";
import { PATIENCE, patienceFee, pct } from "../lib/model";
import type { Session } from "../lib/wallet";
import { Code, Kicker, Range, Seg, Stat } from "./ui";
import { fmtDuration } from "../lib/format";

const MIN_LIMIT = 4295128740n; // TickMath.MIN_SQRT_PRICE + 1
const MAX_LIMIT = 1461446703485210103287273052203988822378723970341n; // TickMath.MAX_SQRT_PRICE - 1
const DYNAMIC_FEE = 0x800000;
const PLACEHOLDER_HOOK = "0x0000000000000000000000000000000000002080" as Address;

function poolIdOf(c0: Address, c1: Address, tickSpacing: number, hook: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [c0, c1, DYNAMIC_FEE, tickSpacing, hook],
    ),
  );
}

function FeeCurve({ age }: { age: number }) {
  const W = 560, H = 190, P = 34, max = 7200;
  const x = (t: number) => P + (t / max) * (W - 2 * P);
  const y = (f: number) => H - P - ((f - 0) / PATIENCE.baseFee) * (H - 2 * P);
  const pts: string[] = [];
  for (let t = 0; t <= max; t += 60) pts.push(`${x(t)},${y(patienceFee(t) ?? PATIENCE.baseFee)}`);
  const cur = patienceFee(age);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Fee as a function of commitment age">
      <defs>
        <linearGradient id="pf" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#5eead4" stopOpacity=".28" />
          <stop offset="1" stopColor="#5eead4" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0, 2500, 5000, 7500, 10000].map((f) => (
        <g key={f}>
          <line x1={P} x2={W - P} y1={y(f)} y2={y(f)} stroke="#1c2946" strokeDasharray="2 4" />
          <text x={2} y={y(f) + 4}>{(f / 10000).toFixed(1)}%</text>
        </g>
      ))}
      <rect x={x(0)} y={P} width={x(PATIENCE.minAge) - x(0)} height={H - 2 * P} fill="#fb7185" opacity=".1" />
      <polygon points={`${x(0)},${y(0)} ${pts.join(" ")} ${x(max)},${y(0)}`} fill="url(#pf)" />
      <polyline points={pts.join(" ")} fill="none" stroke="#5eead4" strokeWidth="2.2" />
      <line x1={x(age)} x2={x(age)} y1={P} y2={H - P} stroke="#e6ecf7" strokeOpacity=".5" />
      <circle cx={x(age)} cy={y(cur ?? PATIENCE.baseFee)} r="6" fill="#05080f" stroke={cur === null ? "#fb7185" : "#e6ecf7"} strokeWidth="2.5" />
      {["0", "30m", "1h", "1h30", "2h"].map((l, i) => (
        <text key={l} x={x((i * max) / 4)} y={H - 6} textAnchor="middle">{l}</text>
      ))}
    </svg>
  );
}

export function Patience({ session, toast }: { session: Session | null; toast: (m: string) => void }) {
  const [age, setAge] = useState(1830);
  const [size, setSize] = useState(10_000);
  const fee = patienceFee(age);
  const fast = PATIENCE.baseFee;

  // commit builder
  const [c0, setC0] = useState("");
  const [c1, setC1] = useState("");
  const [dir, setDir] = useState<"sell0" | "sell1">("sell0");
  const [amount, setAmount] = useState("1000000000000000000");
  const [salt, setSalt] = useState<Hex>(() => toHex(crypto.getRandomValues(new Uint8Array(32))));
  const [busy, setBusy] = useState(false);

  const built = useMemo(() => {
    if (!isAddress(c0) || !isAddress(c1) || !/^\d+$/.test(amount) || BigInt(amount) === 0n) return null;
    let [a, b] = [getAddress(c0), getAddress(c1)];
    if (a.toLowerCase() > b.toLowerCase()) [a, b] = [b, a];
    const zeroForOne = dir === "sell0";
    const id = poolIdOf(a, b, 60, HOOKS.patience ?? PLACEHOLDER_HOOK);
    const commitment = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bool" }, { type: "int256" }, { type: "uint160" }, { type: "bytes32" }],
        [id, zeroForOne, -BigInt(amount), zeroForOne ? MIN_LIMIT : MAX_LIMIT, salt],
      ),
    );
    return { id, commitment, hookData: encodeAbiParameters([{ type: "bytes32" }], [salt]), zeroForOne, a, b };
  }, [c0, c1, dir, amount, salt]);

  async function post() {
    if (!session || !built || !HOOKS.patience) return;
    setBusy(true);
    try {
      const hash = await session.wallet.writeContract({
        address: HOOKS.patience,
        abi: patienceHookAbi,
        functionName: "commit",
        args: [built.commitment],
        account: session.account,
        chain: session.wallet.chain,
      });
      try {
        localStorage.setItem(`tidehook:salt:${built.commitment}`, salt);
      } catch {
        /* storage unavailable: the salt is still shown on screen */
      }
      toast("Commitment sent, waiting for confirmation…");
      await client.waitForTransactionReceipt({ hash });
      toast("Committed. Keep your salt: you need it to redeem.");
    } catch (e) {
      toast((e as Error).message.split("\n")[0]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="patience">
      <div className="wrap hook">
        <div className="copy">
          <Kicker n="01">PatienceHook</Kicker>
          <h2>
            Pay less for <em>waiting.</em>
          </h2>
          <p>
            Every pool gets two lanes. The fast lane swaps right away at 1%. The slow lane posts a salted hash of
            its exact swap first, waits, then reveals it. The fee falls to 0.05% the longer the commitment has aged.
          </p>
          <ul className="facts">
            <li><span>→</span><span><b>Snipers fund patient traders.</b> Anyone who has to buy in the launch block pays the most, and that money goes to LPs.</span></li>
            <li><span>→</span><span><b>Intent stays hidden.</b> Direction, size and limit are hashed, so nothing can be front-run from the commit.</span></li>
            <li><span>→</span><span><b>No pre-launch commits.</b> Age counts from when the pool was created, so hashing a launch swap early buys nothing.</span></li>
          </ul>
        </div>

        <div className="panel">
          <div className="panel-head">
            <span className="tag">Fee simulator · matches feeForAge()</span>
            <span className={`pill ${fee === null ? "warn" : "tide"}`}>{fee === null ? "reverts: too young" : `slow lane ${pct(fee)}`}</span>
          </div>
          <FeeCurve age={age} />
          <div className="field" style={{ marginTop: 10 }}>
            <label>
              <span>Commitment age</span>
              <span className="mono">{fmtDuration(age)}</span>
            </label>
            <Range label="Commitment age" value={age} min={0} max={7200} step={10} onChange={setAge} />
          </div>
          <div className="field">
            <label>
              <span>Trade size</span>
              <span className="mono">${size.toLocaleString()}</span>
            </label>
            <Range label="Trade size" value={size} min={100} max={100_000} step={100} onChange={setSize} />
          </div>
          <div className="stats">
            <Stat label="Fast lane" value={`$${((size * fast) / 1e6).toFixed(2)}`} tone="bad" />
            <Stat label="Slow lane" value={fee === null ? "—" : `$${((size * fee) / 1e6).toFixed(2)}`} tone="hi" />
            <Stat label="You keep" value={fee === null ? "—" : `$${((size * (fast - fee)) / 1e6).toFixed(2)}`} />
          </div>

          <div className="subpanel">
            <div className="panel-head">
              <span className="tag">Commit builder · matches commitmentOf()</span>
              <button className="btn small" onClick={() => setSalt(toHex(crypto.getRandomValues(new Uint8Array(32))))}>New salt</button>
            </div>
            <div className="row">
              <div className="field">
                <label>Token A</label>
                <input className="input mono" placeholder="0x…" value={c0} onChange={(e) => setC0(e.target.value.trim())} />
              </div>
              <div className="field">
                <label>Token B</label>
                <input className="input mono" placeholder="0x…" value={c1} onChange={(e) => setC1(e.target.value.trim())} />
              </div>
            </div>
            <div className="row" style={{ marginBottom: 14 }}>
              <Seg value={dir} onChange={setDir} options={[["sell0", "Sell currency0"], ["sell1", "Sell currency1"]]} />
              <div className="field" style={{ marginBottom: 0 }}>
                <input className="input mono" aria-label="Exact input amount (wei)" value={amount} onChange={(e) => setAmount(e.target.value.trim())} />
              </div>
            </div>
            {built ? (
              <div style={{ display: "grid", gap: 8 }}>
                <Code copy={built.commitment}>commitment {built.commitment}</Code>
                <Code copy={built.hookData}>hookData {built.hookData}</Code>
                <Code copy={salt}>salt {salt}</Code>
              </div>
            ) : (
              <p className="note">Enter both token addresses and an amount to build the commitment.</p>
            )}
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn primary" disabled={!built || !session || !HOOKS.patience || busy} onClick={post}>
                {busy ? "Posting…" : "Post commitment"}
              </button>
              <span className="note" style={{ margin: 0 }}>
                {!HOOKS.patience
                  ? "Hook not deployed yet: the hash uses a placeholder hook address."
                  : !session
                    ? "Connect a wallet to post."
                    : "Only the hash goes on-chain. The swap stays private until you reveal it."}
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
