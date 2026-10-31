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
        {done && <AdminPanel />}
      </div>
    </section>
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
