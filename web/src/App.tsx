import { useCallback, useEffect, useRef, useState } from "react";
import { Bond } from "./components/Bond";
import { Inspector } from "./components/Inspector";
import { Patience } from "./components/Patience";
import { SessionClock } from "./components/SessionClock";
import { Spring } from "./components/Spring";
import { Kicker } from "./components/ui";
import { short } from "./lib/format";
import { GITHUB_URL, HOOKS, POOL_MANAGER, client, explorer } from "./lib/chain";
import { SESSION_FEES, pct, sessionAt } from "./lib/model";
import { connect, useNow, useWallets, type Session } from "./lib/wallet";

function Logo() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="lg" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#5eead4" />
          <stop offset="1" stopColor="#38bdf8" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="15" fill="none" stroke="url(#lg)" strokeWidth="1.5" opacity=".5" />
      <path d="M4 18c3-3 6-3 9 0s6 3 9 0 4-2 6-1" fill="none" stroke="url(#lg)" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M19 6v8a4 4 0 0 1-8 0" fill="none" stroke="#e6ecf7" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

function Wallet({ session, setSession, toast }: { session: Session | null; setSession: (s: Session | null) => void; toast: (m: string) => void }) {
  const wallets = useWallets();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  if (session)
    return (
      <div className="wallet">
        <button className="btn" onClick={() => setSession(null)} title="Disconnect">
          <span className="dot" /> <span className="mono">{short(session.account)}</span>
        </button>
      </div>
    );

  return (
    <div className="wallet" ref={ref}>
      <button className="btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>Connect</button>
      {open && (
        <div className="menu" role="menu">
          {wallets.length === 0 && <p className="muted">No browser wallet found. Install one that supports EIP-6963.</p>}
          {wallets.map((w) => (
            <button
              key={w.info.uuid}
              className="btn"
              role="menuitem"
              onClick={async () => {
                setOpen(false);
                try {
                  setSession(await connect(w));
                } catch (e) {
                  toast((e as Error).message.split("\n")[0]);
                }
              }}
            >
              <img src={w.info.icon} alt="" /> {w.info.name}
            </button>
          ))}
          <p className="dim">Robinhood Chain · 4663. Nothing is remembered after you leave.</p>
        </div>
      )}
    </div>
  );
}

function useChainPulse() {
  const [block, setBlock] = useState<bigint | null>(null);
  const [pm, setPm] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = () => client.getBlockNumber().then((b) => alive && setBlock(b)).catch(() => {});
    tick();
    client.getCode({ address: POOL_MANAGER }).then((c) => alive && setPm(c ? (c.length - 2) / 2 : 0)).catch(() => {});
    const id = setInterval(() => document.visibilityState === "visible" && tick(), 4000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return { block, pm };
}

function Hero() {
  const { block, pm } = useChainPulse();
  const now = useNow(1000);
  const s = sessionAt(now);
  return (
    <header className="hero">
      <div className="wrap" style={{ position: "relative" }}>
        <span className="eyebrow"><span className="dot" /> Uniswap v4 · Robinhood Chain</span>
        <h1>
          Hooks that <em>price time.</em>
        </h1>
        <p className="lede">
          Four Uniswap v4 hooks where <strong>a trade is never blocked, only priced</strong>. What a swap costs
          depends on how long you waited, how long the price has held, whether the creator kept their promise, and
          whether the stock market is open.
        </p>
        <div className="cta">
          <a className="btn primary" href="#patience">Try the simulators</a>
          <a className="btn" href={GITHUB_URL} target="_blank" rel="noreferrer">Read the contracts</a>
        </div>
        <div className="live">
          <div><label>Robinhood Chain</label><b className="mono">{block ? `#${block.toLocaleString()}` : "…"}</b></div>
          <div><label>v4 PoolManager</label><b className={pm ? "ok" : ""}>{pm === null ? "…" : pm ? "verified ✓" : "not found"}</b></div>
          <div><label>Market session</label><b>{s}</b></div>
          <div><label>Session fee now</label><b className="tide">{pct(SESSION_FEES[s])}</b></div>
        </div>
      </div>
      <svg className="waves" viewBox="0 0 2880 120" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0 60 Q 180 20 360 60 T 720 60 T 1080 60 T 1440 60 T 1800 60 T 2160 60 T 2520 60 T 2880 60 V120 H0Z" fill="rgba(45,212,191,.08)" />
        <path d="M0 80 Q 240 50 480 80 T 960 80 T 1440 80 T 1920 80 T 2400 80 T 2880 80 V120 H0Z" fill="rgba(56,189,248,.07)" />
      </svg>
    </header>
  );
}

function Thesis() {
  return (
    <section id="thesis">
      <div className="wrap">
        <Kicker n="00">The idea</Kicker>
        <h2>
          Other hooks <em>block</em> trades. These <em>price</em> them.
        </h2>
        <p className="section-lede">
          Today's hook projects work with on/off rules: sell caps, allowlists, circuit breakers, trading-hours
          locks. A blocked trade earns nothing and frustrates the trader. tidehook lets every trade through and
          charges for the risk it adds, paid to the LPs who carry it.
        </p>
        <div className="contrast">
          <div className="them">
            <h3>Pass-or-revert hooks</h3>
            <ul>
              <li><span><b>Snipers</b> get blocked, or slip through on a list</span></li>
              <li><span><b>Dumps</b> hit a hard cap and fail</span></li>
              <li><span><b>Creator allocations</b> are locked for a fixed time, whatever the price does</span></li>
              <li><span><b>Stock pairs</b> charge one flat fee 24/7, even when the real market is shut</span></li>
            </ul>
          </div>
          <div className="us">
            <h3>tidehook</h3>
            <ul>
              <li><span><b>Snipers</b> pay a 20× higher fee than patient traders</span></li>
              <li><span><b>Dumps</b> get more expensive with every tick they push</span></li>
              <li><span><b>Creator allocations</b> unlock only while the floor holds, and burn if it doesn't</span></li>
              <li><span><b>Stock pairs</b> charge by session: open, extended, closed, weekend</span></li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

const ROWS: { key: keyof typeof HOOKS; name: string; perms: string; what: string }[] = [
  { key: "patience", name: "PatienceHook", perms: "beforeInitialize · beforeSwap", what: "Commit and reveal; the fee falls as the commitment ages" },
  { key: "spring", name: "SpringHook", perms: "before/afterInitialize · beforeSwap", what: "Fee as a restoring force around a time-weighted rest price" },
  { key: "bond", name: "CreatorBondHook", perms: "beforeInitialize · afterSwap", what: "Creator escrow that vests only while the floor holds; slashable" },
  { key: "session", name: "SessionHook", perms: "beforeInitialize · beforeSwap", what: "Fee by NYSE session for tokenized-stock pairs" },
];

function Contracts() {
  return (
    <section id="contracts">
      <div className="wrap">
        <Kicker n="06">Contracts</Kicker>
        <h2>
          Tested against <em>the real pool manager.</em>
        </h2>
        <p className="section-lede">
          Every hook is covered by unit tests, fuzz tests and a fork test that runs it against the live Uniswap v4
          PoolManager on Robinhood Chain (<a className="mono" href={explorer(POOL_MANAGER)} target="_blank" rel="noreferrer">{short(POOL_MANAGER)}</a>).
          The deploy script mines a CREATE2 salt for each hook so its address carries exactly the permission bits it needs.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Hook</th><th>Callbacks</th><th>What it does</th><th>Address</th></tr>
            </thead>
            <tbody>
              {ROWS.map((r) => {
                const a = HOOKS[r.key];
                return (
                  <tr key={r.key}>
                    <td><b>{r.name}</b></td>
                    <td className="mono dim">{r.perms}</td>
                    <td className="muted">{r.what}</td>
                    <td>{a ? <a className="mono" href={explorer(a)} target="_blank" rel="noreferrer">{short(a)}</a> : <span className="pill moon">deploy pending</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="proof">
          <div><b>16 / 16</b><p>Foundry tests passing: unit, exploit regressions, and 3 fuzz invariants × 256 runs.</p></div>
          <div><b>5 exploits</b><p>Found and fixed before launch: flash-pump claim, slash-timer reset, pre-launch commits, overshoot discount, and dust-bond squatting.</p></div>
          <div><b>0 servers</b><p>This site reads the chain from your browser. No indexer, no backend, no analytics.</p></div>
        </div>
      </div>
    </section>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const toast = useCallback((m: string) => {
    setMsg(m);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(null), 4500);
  }, []);

  return (
    <>
      <nav className="nav">
        <div className="wrap">
          <a className="brand" href="#top"><Logo /> tidehook</a>
          <div className="nav-links">
            <a href="#patience">Patience</a>
            <a href="#spring">Spring</a>
            <a href="#bond">Bond</a>
            <a href="#session">Session</a>
            <a href="#inspector">Inspector</a>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub</a>
          </div>
          <Wallet session={session} setSession={setSession} toast={toast} />
        </div>
      </nav>
      <main id="top">
        <Hero />
        <Thesis />
        <Patience session={session} toast={toast} />
        <Spring />
        <Bond />
        <SessionClock />
        <Inspector />
        <Contracts />
      </main>
      <footer>
        <div className="wrap">
          <p>
            tidehook is unaudited, experimental software. Nothing here is investment advice. Not affiliated with
            Robinhood Markets, Inc. or Uniswap Labs.
          </p>
          <p><a href={GITHUB_URL} target="_blank" rel="noreferrer">Source</a> · MIT</p>
        </div>
      </footer>
      {msg && <div className="toast" role="status">{msg}</div>}
    </>
  );
}
