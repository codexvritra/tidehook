import { useEffect, useState } from "react";
import { concat, formatEther, type Address, type Hex } from "viem";
import { useApp } from "../lib/appContext";
import { CREATE2_DEPLOYER, client, explorer } from "../lib/chain";
import { usePoll } from "../lib/data";
import { fmtDuration, short } from "../lib/format";
import { useChainNow } from "../lib/wallet";
import { errMsg, sendRaw, sendTx } from "../lib/tx";
import { tideLauncherAbi } from "../lib/abis";
import { ADDR } from "../lib/chain";
import { isAddress } from "viem";
import { Spinner } from "../components/bits";
import { EarningsPanel } from "../components/Earnings";
import { usd, useEthUsd } from "../lib/ethPrice";
import { ETH } from "../lib/chain";
import { PAIR_ASSETS } from "../lib/stocks";
import { parseEther } from "viem";

type Item = { name: string; address: Address; salt: Hex; initCode: Hex };

const ROLE: Record<string, string> = {
  PatienceHook: "Commit-reveal swaps, 2% launchpad tax",
  SpringHook: "Rest-price tracking, 2% launchpad tax",
  CreatorBondHook: "Creator escrow and floor",
  SessionHook: "Stock-pair hook, 2% launchpad tax",
  TideLauncher: "Token + pool + locked liquidity in one tx; rename and migrate",
  TideTokenFactory: "Deploys each launch's ERC20",
  TideMigrator: "Moves locked liquidity to a new hook or pair",
  TideRouter: "Swaps with quotes, slippage and refunds",
  TideOrders: "Limit orders and DCA in every launch pool",
};

export function Deploy() {
  const { session, requireWallet, toast, refreshDeploy } = useApp();
  const [plan, setPlan] = useState<Item[]>();
  useEffect(() => {
    import("../deploy/initcode.json").then((m) => setPlan(m.default as Item[]));
  }, []);
  const [live, , reload] = usePoll(
    async () => (plan ? Promise.all(plan.map(async (p) => ((await client.getCode({ address: p.address })) ?? "0x").length > 2)) : []),
    15_000,
    [plan?.length],
  );
  const [bal] = usePoll(() => (session ? client.getBalance({ address: session.account }) : Promise.resolve(0n)), 15_000, [session?.account]);
  const [busy, setBusy] = useState<string | null>(null);

  async function deployOne(p: Item) {
    const s = requireWallet();
    if (!s) return false;
    setBusy(p.name);
    try {
      await sendRaw(s, CREATE2_DEPLOYER, concat([p.salt, p.initCode]));
      const code = await client.getCode({ address: p.address });
      if (!code || code === "0x") throw new Error(`${p.name} did not land at ${p.address}`);
      toast(`${p.name} deployed.`);
      return true;
    } catch (e) {
      toast(`${p.name}: ${errMsg(e)}`, "err");
      return false;
    } finally {
      setBusy(null);
      reload();
      refreshDeploy();
    }
  }

  async function deployAll() {
    if (!plan || !live) return;
    for (let i = 0; i < plan.length; i++) {
      if (live[i]) continue;
      if (!(await deployOne(plan[i]))) return;
    }
    toast("tidehook is live on Robinhood Chain.");
  }

  const done = live && live.length > 0 && live.every(Boolean);

  return (
    <section className="tight">
      <div className="wrap">
        <div className="kicker">
          <span className="n">Deploy</span>
        </div>
        <h2>
          Put tidehook on <em>Robinhood Chain.</em>
        </h2>
        <p className="section-lede">
          Nine contracts go to fixed addresses through the standard CREATE2 deployer, so these
          addresses are the same no matter who deploys. Each hook's address was mined so its last 14 bits match the
          permissions Uniswap v4 requires. Your wallet signs every transaction, and the site never sees a key.
        </p>

        <div className="panel">
          <div className="panel-head">
            <span className="tag">Contracts</span>
            {done ? <span className="pill ok">all live</span> : <span className="pill moon">{live ? live.filter(Boolean).length : 0} / 6 live</span>}
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Contract</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(plan ?? []).map((p, i) => (
                  <tr key={p.name}>
                    <td>
                      <b>{p.name}</b>
                    </td>
                    <td className="muted">{ROLE[p.name]}</td>
                    <td>{live === undefined ? "…" : live[i] ? <span className="ok">✓ live</span> : <span className="dim">not deployed</span>}</td>
                    <td>
                      {live && !live[i] && (
                        <button className="btn small" disabled={!!busy} onClick={() => deployOne(p)}>
                          {busy === p.name ? <Spinner /> : "Deploy"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ marginTop: 18 }}>
            {done ? (
              <a className="btn primary" href="#/launch">
                Launch the first token →
              </a>
            ) : (
              <button className="btn primary" disabled={!!busy || !plan || !live} onClick={deployAll}>
                {busy ? (
                  <>
                    <Spinner /> Deploying {busy}…
                  </>
                ) : session ? (
                  "Deploy everything that's missing"
                ) : (
                  "Connect wallet to deploy"
                )}
              </button>
            )}
            {session && bal !== undefined && <span className="note" style={{ margin: 0 }}>Your balance: {Number(formatEther(bal)).toFixed(5)} ETH on Robinhood Chain</span>}
          </div>
          <p className="note">
            Deploying all eight costs gas only (each is one transaction of about 1–4M gas). The wallet that deploys SessionHook becomes
            its schedule admin (DST and holiday times; it cannot change launchpad pool fees, which are a flat 2%), and the wallet that deploys TideLauncher becomes the route admin
            (which quote assets launches may migrate to). Neither can move anyone's funds. The exact init code is committed in the repo at{" "}
            <span className="mono">deployments/robinhood.json</span>, and the forge script deploys the same bytes.
          </p>
        </div>
        {done && <PlatformPanel />}
        {done && <StockPairsPanel />}
        {done && <AdminPanel />}
      </div>
    </section>
  );
}

/** Platform admin: fee wallet (2-day delayed change), launch fee (set in dollars), platform fee payouts. */
function PlatformPanel() {
  const { session, toast } = useApp();
  const ethUsd = useEthUsd();
  const [cfg, , reload] = usePoll(
    async () => {
      const [admin, wallet, fee, count, pendingWallet, pendingAt] = await Promise.all([
        client.readContract({ address: ADDR.launcher, abi: tideLauncherAbi, functionName: "admin" }),
        client.readContract({ address: ADDR.launcher, abi: tideLauncherAbi, functionName: "feeRecipient" }),
        client.readContract({ address: ADDR.launcher, abi: tideLauncherAbi, functionName: "launchFee" }),
        client.readContract({ address: ADDR.launcher, abi: tideLauncherAbi, functionName: "launchCount" }),
        client.readContract({ address: ADDR.launcher, abi: tideLauncherAbi, functionName: "pendingFeeRecipient" }),
        client.readContract({ address: ADDR.launcher, abi: tideLauncherAbi, functionName: "pendingFeeRecipientReadyAt" }),
      ]);
      return { admin, wallet, fee, count: Number(count), pendingWallet, pendingAt: Number(pendingAt) };
    },
    60_000,
    [],
  );
  const [wallet, setWallet] = useState("");
  const [feeUsd, setFeeUsd] = useState("3");
  const [busy, setBusy] = useState<string | null>(null);
  const now = useChainNow();
  if (!session || !cfg || session.account.toLowerCase() !== cfg.admin.toLowerCase()) return null;
  const feeEth = Number(Number(formatEther(cfg.fee)).toPrecision(4));

  async function call(label: string, fn: string, args: readonly unknown[], ok: string) {
    if (!session) return;
    setBusy(label);
    try {
      await sendTx(session, { address: ADDR.launcher, abi: tideLauncherAbi, functionName: fn, args });
      toast(ok);
      reload();
    } catch (e) {
      toast(errMsg(e), "err");
    } finally {
      setBusy(null);
    }
  }

  const newFeeWei = ethUsd && Number(feeUsd) > 0 ? parseEther((Number(feeUsd) / ethUsd).toFixed(18)) : null;

  return (
    <>
      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <span className="tag">Platform</span>
          <span className="pill tide">you are admin</span>
        </div>
        <dl className="kv">
          <dt>Platform wallet</dt>
          <dd>
            <a href={explorer(cfg.wallet)} target="_blank" rel="noreferrer">
              {short(cfg.wallet)}
            </a>
          </dd>
          <dt>Launch fee</dt>
          <dd className="lime">
            {feeEth} ETH {ethUsd ? `≈ ${usd(feeEth, ethUsd)}` : ""}
          </dd>
          <dt>Trading fees</dt>
          <dd>buy 1% creator + 1% platform · sell 2% platform · no LP fee</dd>
        </dl>
        {cfg.pendingWallet !== "0x0000000000000000000000000000000000000000" && (
          <div className="row">
            <p className="note" style={{ flex: "1 1 320px", margin: 0 }}>
              Pending platform wallet {short(cfg.pendingWallet)}:{" "}
              {now >= cfg.pendingAt ? "ready to apply." : `applies after ${fmtDuration(cfg.pendingAt - now)} (public 2-day delay).`}
            </p>
            <button className="btn primary" disabled={!!busy || now < cfg.pendingAt} onClick={() => call("apply", "applyFeeRecipient", [], "Platform wallet updated.")}>
              {busy === "apply" ? <Spinner /> : "Apply"}
            </button>
          </div>
        )}
        <div className="row">
          <div className="field" style={{ flex: "1 1 320px" }}>
            <label>New platform wallet</label>
            <input className="input" placeholder="0x…" value={wallet} onChange={(e) => setWallet(e.target.value.trim())} />
          </div>
          <button className="btn primary" disabled={!!busy || !isAddress(wallet)} onClick={() => call("wallet", "proposeFeeRecipient", [wallet as Address], "New platform wallet announced. Apply it in 2 days.")}>
            {busy === "wallet" ? <Spinner /> : "Propose wallet"}
          </button>
        </div>
        <div className="row">
          <div className="field" style={{ flex: "1 1 200px" }}>
            <label>
              <span>Launch fee in USD</span>
              <span className="dim">{newFeeWei ? `= ${Number(formatEther(newFeeWei)).toFixed(6)} ETH at $${ethUsd?.toFixed(0)}` : "needs ETH price"}</span>
            </label>
            <input className="input" inputMode="decimal" value={feeUsd} onChange={(e) => setFeeUsd(e.target.value)} />
          </div>
          <button className="btn primary" disabled={!!busy || !newFeeWei} onClick={() => newFeeWei && call("fee", "setLaunchFee", [newFeeWei], "Launch fee updated.")}>
            {busy === "fee" ? <Spinner /> : "Set launch fee"}
          </button>
        </div>
        <p className="note">The launch fee is stored on-chain in ETH. Re-set it here when the ETH price moves to keep it near $3.</p>
      </div>
      <div style={{ marginTop: 16, maxWidth: 480 }}>
        <EarningsPanel asset={{ address: ETH, symbol: "ETH", decimals: 18 }} mode="platform" />
      </div>
    </>
  );
}

/** One click per pair: allow the stock/USDG as a migration target and register its real ETH route pool. */
function StockPairsPanel() {
  const { session, toast } = useApp();
  const [admin] = usePoll(() => client.readContract({ address: ADDR.launcher, abi: tideLauncherAbi, functionName: "admin" }), 120_000, []);
  const [state, , reload] = usePoll(
    () =>
      Promise.all(
        PAIR_ASSETS.map(async (a) => {
          const [allowed, route] = await Promise.all([
            client.readContract({ address: ADDR.launcher, abi: tideLauncherAbi, functionName: "quoteAllowed", args: [a.address] }),
            client.readContract({ address: ADDR.launcher, abi: tideLauncherAbi, functionName: "routeFor", args: [ETH, a.address] }),
          ]);
          return { allowed: allowed as boolean, routed: Number((route as { tickSpacing: number }).tickSpacing) !== 0 };
        }),
      ),
    60_000,
    [],
  );
  const [busy, setBusy] = useState<string | null>(null);
  if (!session || !admin || session.account.toLowerCase() !== admin.toLowerCase()) return null;

  async function enable(list: typeof PAIR_ASSETS) {
    if (!session) return;
    try {
      for (const a of list) {
        const i = PAIR_ASSETS.indexOf(a);
        setBusy(a.symbol);
        if (!state?.[i]?.allowed) await sendTx(session, { address: ADDR.launcher, abi: tideLauncherAbi, functionName: "setQuoteAllowed", args: [a.address, true] });
        if (!state?.[i]?.routed && a.route) await sendTx(session, { address: ADDR.launcher, abi: tideLauncherAbi, functionName: "setRoute", args: [a.route] });
      }
      toast("Stock pairs enabled.");
    } catch (e) {
      toast(errMsg(e), "err");
    } finally {
      setBusy(null);
      reload();
    }
  }

  const todo = PAIR_ASSETS.filter((a, i) => a.route && !(state?.[i]?.allowed && state?.[i]?.routed));
  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="panel-head">
        <span className="tag">Stock pairs</span>
        <span className="pill tide">{state ? `${PAIR_ASSETS.length - todo.length}/${PAIR_ASSETS.length} live` : "…"}</span>
      </div>
      <p className="note" style={{ marginTop: 0 }}>
        Anyone can launch paired with these today. Enabling one also lets existing coins switch their pair from ETH to it, converting
        through the deepest ETH pool on Uniswap v4 (found on-chain by <code>scripts/stocks.mjs</code>). Thin routes refuse large
        conversions rather than lose value.
      </p>
      <table className="kv-table">
        <tbody>
          {PAIR_ASSETS.map((a, i) => (
            <tr key={a.symbol}>
              <td>
                <b>{a.symbol}</b> <span className="dim">{a.name}</span>
              </td>
              <td className="mono dim">
                <a href={explorer(a.address)} target="_blank" rel="noreferrer">
                  {short(a.address)}
                </a>
              </td>
              <td className="dim">{a.route ? `route ${(a.route.fee / 10_000).toFixed(2)}%` : "no route"}</td>
              <td>{!state ? "…" : state[i].allowed && state[i].routed ? <span className="up">live</span> : busy === a.symbol ? <Spinner /> : <span className="dim">off</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn primary" style={{ marginTop: 12 }} disabled={!!busy || todo.length === 0} onClick={() => enable(todo)}>
        {busy ? <Spinner /> : todo.length ? `Enable ${todo.length} pair${todo.length === 1 ? "" : "s"} (${todo.length * 2} txs)` : "All pairs enabled"}
      </button>
    </div>
  );
}

/** Route admin: approve quote assets and the canonical v4 pools used to convert into them on migration. */
function AdminPanel() {
  const { session, toast } = useApp();
  const [admin] = usePoll(() => client.readContract({ address: ADDR.launcher, abi: tideLauncherAbi, functionName: "admin" }), 120_000, []);
  const [quote, setQuote] = useState("");
  const [c0, setC0] = useState("0x0000000000000000000000000000000000000000");
  const [c1, setC1] = useState("");
  const [fee, setFee] = useState("500");
  const [spacing, setSpacing] = useState("10");
  const [hooks, setHooks] = useState("0x0000000000000000000000000000000000000000");
  const [busy, setBusy] = useState(false);
  if (!session || !admin || session.account.toLowerCase() !== admin.toLowerCase()) return null;

  async function call(fn: string, args: readonly unknown[], ok: string) {
    if (!session) return;
    setBusy(true);
    try {
      await sendTx(session, { address: ADDR.launcher, abi: tideLauncherAbi, functionName: fn, args });
      toast(ok);
    } catch (e) {
      toast(errMsg(e), "err");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="panel-head">
        <span className="tag">Route admin</span>
        <span className="pill tide">you are admin</span>
      </div>
      <p className="note" style={{ marginTop: 0 }}>
        Pair changes are off until you approve a quote asset <b>and</b> register a deep v4 pool to convert through. Only add
        established assets and deep pools: a migrating launch swaps its whole quote balance through that route.
      </p>
      <div className="row">
        <div className="field" style={{ flex: "1 1 320px" }}>
          <label>Quote asset</label>
          <input className="input" placeholder="0x… (e.g. a USD stablecoin or tokenized stock)" value={quote} onChange={(e) => setQuote(e.target.value.trim())} />
        </div>
        <button className="btn primary" disabled={busy || !isAddress(quote)} onClick={() => call("setQuoteAllowed", [quote as Address, true], "Quote allowed.")}>
          Allow
        </button>
        <button className="btn" disabled={busy || !isAddress(quote)} onClick={() => call("setQuoteAllowed", [quote as Address, false], "Quote disallowed.")}>
          Disallow
        </button>
      </div>
      <div className="subpanel">
        <h3>Register route pool</h3>
        <div className="row">
          <div className="field">
            <label>currency0</label>
            <input className="input" value={c0} onChange={(e) => setC0(e.target.value.trim())} />
          </div>
          <div className="field">
            <label>currency1</label>
            <input className="input" value={c1} onChange={(e) => setC1(e.target.value.trim())} />
          </div>
        </div>
        <div className="row">
          <div className="field">
            <label>Fee (pips)</label>
            <input className="input" value={fee} onChange={(e) => setFee(e.target.value.replace(/\D/g, ""))} />
          </div>
          <div className="field">
            <label>Tick spacing</label>
            <input className="input" value={spacing} onChange={(e) => setSpacing(e.target.value.replace(/[^\d-]/g, ""))} />
          </div>
          <div className="field" style={{ flex: "2 1 280px" }}>
            <label>Hooks</label>
            <input className="input" value={hooks} onChange={(e) => setHooks(e.target.value.trim())} />
          </div>
        </div>
        <button
          className="btn primary"
          disabled={busy || !isAddress(c0) || !isAddress(c1) || !isAddress(hooks) || !fee || !spacing}
          onClick={() =>
            call(
              "setRoute",
              [{ currency0: c0 as Address, currency1: c1 as Address, fee: Number(fee), tickSpacing: Number(spacing), hooks: hooks as Address }],
              "Route registered.",
            )
          }
        >
          {busy ? <Spinner /> : "Register route"}
        </button>
      </div>
    </div>
  );
}
