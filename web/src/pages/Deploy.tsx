import { useEffect, useState } from "react";
import { concat, formatEther, type Address, type Hex } from "viem";
import { useApp } from "../lib/appContext";
import { CREATE2_DEPLOYER, client, explorer } from "../lib/chain";
import { usePoll } from "../lib/data";
import { short } from "../lib/format";
import { errMsg, sendRaw } from "../lib/tx";
import { Spinner } from "../components/bits";

type Item = { name: string; address: Address; salt: Hex; initCode: Hex };

const ROLE: Record<string, string> = {
  PatienceHook: "Commit-reveal fee lane",
  SpringHook: "Restoring-force fees",
  CreatorBondHook: "Creator escrow and floor",
  SessionHook: "Market-session fees",
  TideLauncher: "Token + pool + locked liquidity in one tx",
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
            Deploying all six costs gas only (each is one transaction of about 1–4M gas). The SessionHook schedule admin becomes
            the wallet that deploys it. That admin can only update DST and holiday times and fees, capped at 5%. The exact init code is
            committed in the repo at <span className="mono">deployments/robinhood.json</span>, and the forge script deploys the same bytes.
          </p>
        </div>
      </div>
    </section>
  );
}
