import { useEffect, useState } from "react";
import { concat, formatEther, type Address, type Hex } from "viem";
import { useApp } from "../lib/appContext";
import { CREATE2_DEPLOYER, client, explorer } from "../lib/chain";
import { usePoll } from "../lib/data";
import { short } from "../lib/format";
import { errMsg, sendRaw, sendTx } from "../lib/tx";
import { tideLauncherAbi } from "../lib/abis";
import { ADDR } from "../lib/chain";
import { isAddress } from "viem";
import { Spinner } from "../components/bits";
import { EarningsPanel } from "../components/Earnings";
import { usd, useEthUsd } from "../lib/ethPrice";
import { ETH } from "../lib/chain";
import { parseEther } from "viem";

type Item = { name: string; address: Address; salt: Hex; initCode: Hex };

const ROLE: Record<string, string> = {
  PatienceHook: "Commit-reveal fee lane",
  SpringHook: "Restoring-force fees",
  CreatorBondHook: "Creator escrow and floor",
  SessionHook: "Market-session fees",
  TideLauncher: "Token + pool + locked liquidity in one tx; rename and migrate",
  TideTokenFactory: "Deploys each launch's ERC20",
  TideMigrator: "Moves locked liquidity to a new hook or pair",
  TideRouter: "Swaps with quotes, slippage and refunds",
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
          Six contracts go to fixed addresses through the standard CREATE2 deployer (<span className="mono">{short(CREATE2_DEPLOYER)}</span>), so these
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
                  <th>Address</th>
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
                    <td>
                      <a className="mono" href={explorer(p.address)} target="_blank" rel="noreferrer">
                        {short(p.address)}
                      </a>
                    </td>
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
            its schedule admin (DST and holiday times, fees capped at 5%), and the wallet that deploys TideLauncher becomes the route admin
            (which quote assets launches may migrate to). Neither can move anyone's funds. The exact init code is committed in the repo at{" "}
            <span className="mono">deployments/robinhood.json</span>, and the forge script deploys the same bytes.
          </p>
        </div>
        {done && <PlatformPanel />}
        {done && <AdminPanel />}
      </div>
    </section>
  );
}

/** Platform admin: fee wallet, launch fee (set in dollars), platform fee payouts and LP-fee sweeps. */
function PlatformPanel() {
  const { session, toast } = useApp();
  const ethUsd = useEthUsd();
  const [cfg, , reload] = usePoll(
    async () => {
      const [admin, wallet, fee, count] = await Promise.all([
        client.readContract({ address: ADDR.launcher, abi: tideLauncherAbi, functionName: "admin" }),
        client.readContract({ address: ADDR.launcher, abi: tideLauncherAbi, functionName: "feeRecipient" }),
        client.readContract({ address: ADDR.launcher, abi: tideLauncherAbi, functionName: "launchFee" }),
        client.readContract({ address: ADDR.launcher, abi: tideLauncherAbi, functionName: "launchCount" }),
      ]);
      return { admin, wallet, fee, count: Number(count) };
    },
    60_000,
    [],
  );
  const [wallet, setWallet] = useState("");
  const [feeUsd, setFeeUsd] = useState("3");
  const [busy, setBusy] = useState<string | null>(null);
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

  async function sweepAll() {
    if (!session || !cfg) return;
    setBusy("sweep");
    let swept = 0;
    try {
      for (let id = 0; id < cfg.count; id++) {
        try {
          const { result } = await client.simulateContract({ account: session.account, address: ADDR.launcher, abi: tideLauncherAbi, functionName: "collectFees", args: [BigInt(id)] });
          if (result[0] + result[1] === 0n) continue;
        } catch {
          continue;
        }
        await sendTx(session, { address: ADDR.launcher, abi: tideLauncherAbi, functionName: "collectFees", args: [BigInt(id)] });
        swept++;
      }
      toast(swept ? `Swept LP fees from ${swept} launch${swept === 1 ? "" : "es"}: ETH to the platform wallet, tokens burned.` : "No LP fees to sweep yet.");
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
          <dd>buy 1% creator + 1% platform · sell 2% platform</dd>
        </dl>
        <div className="row">
          <div className="field" style={{ flex: "1 1 320px" }}>
            <label>New platform wallet</label>
            <input className="input" placeholder="0x…" value={wallet} onChange={(e) => setWallet(e.target.value.trim())} />
          </div>
          <button className="btn primary" disabled={!!busy || !isAddress(wallet)} onClick={() => call("wallet", "setFeeRecipient", [wallet as Address], "Platform wallet updated.")}>
            {busy === "wallet" ? <Spinner /> : "Set wallet"}
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
        <button className="btn" disabled={!!busy || cfg.count === 0} onClick={sweepAll}>
          {busy === "sweep" ? <Spinner /> : `Sweep LP fees from all ${cfg.count} launches`}
        </button>
      </div>
      <div style={{ marginTop: 16, maxWidth: 480 }}>
        <EarningsPanel asset={{ address: ETH, symbol: "ETH", decimals: 18 }} mode="platform" />
      </div>
    </>
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
