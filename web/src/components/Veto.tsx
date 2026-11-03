import { useState } from "react";
import { formatUnits, maxUint256, parseUnits, type Address } from "viem";
import { tideLauncherAbi, tideTokenAbi, tideVetoAbi } from "../lib/abis";
import { useApp } from "../lib/appContext";
import { ADDR, client } from "../lib/chain";
import { balanceOf, usePoll, type Launch, type Pending } from "../lib/data";
import { fmtDuration } from "../lib/format";
import { fmtNum } from "../lib/price";
import { errMsg, sendTx } from "../lib/tx";
import { useChainNow } from "../lib/wallet";
import { Spinner } from "./bits";

let vetoAddr: Promise<Address> | null = null;
const vetoAddress = () => (vetoAddr ??= client.readContract({ address: ADDR.launcher, abi: tideLauncherAbi, functionName: "veto" }) as Promise<Address>);

/** Holders lock tokens to block a pending hook/pair switch; 10% of the circulating supply blocks it. */
export function VetoPanel({ launch: l, pending, onChanged }: { launch: Launch; pending: Pending; onChanged: () => void }) {
  const { session, toast, requireWallet } = useApp();
  const now = useChainNow(1000);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [st, , reload] = usePoll(
    async () => {
      const veto = await vetoAddress();
      const [status, round] = await Promise.all([
        client.readContract({ address: veto, abi: tideVetoAbi, functionName: "status", args: [BigInt(l.id)] }),
        client.readContract({ address: ADDR.launcher, abi: tideLauncherAbi, functionName: "migrationRound", args: [BigInt(l.id)] }),
      ]);
      const [mine, bal] = session
        ? await Promise.all([
            client.readContract({ address: veto, abi: tideVetoAbi, functionName: "lockOf", args: [BigInt(l.id), session.account] }),
            balanceOf(l.token, session.account),
          ])
        : [[0, 0n] as const, 0n];
      const [locked, needed, blocked] = status as readonly [bigint, bigint, boolean];
      const [myRound, myAmount] = mine as readonly [number, bigint];
      return { veto, locked, needed, blocked, round: Number(round), myRound: Number(myRound), myAmount, bal: bal as bigint };
    },
    10_000,
    [l.id, session?.account, pending?.readyAt],
  );
  if (!st) return null;
  const open = !!pending && now < pending.readyAt;
  const hasStale = st.myAmount > 0n && (!pending || st.myRound !== st.round);
  if (!pending && !hasStale) return null;

  const pct = st.needed > 0n ? Math.min(100, Number((st.locked * 10_000n) / st.needed) / 100) : 0;
  const amt = (() => {
    try {
      return amount ? parseUnits(amount, 18) : 0n;
    } catch {
      return 0n;
    }
  })();

  async function lock() {
    const s = requireWallet();
    if (!s || !st || amt === 0n) return;
    setBusy(true);
    try {
      const allowance = (await client.readContract({ address: l.token, abi: tideTokenAbi, functionName: "allowance", args: [s.account, st.veto] })) as bigint;
      if (allowance < amt) await sendTx(s, { address: l.token, abi: tideTokenAbi, functionName: "approve", args: [st.veto, maxUint256] });
      await sendTx(s, { address: st.veto, abi: tideVetoAbi, functionName: "lock", args: [BigInt(l.id), amt] });
      toast("Tokens locked against the migration. Unlock any time.");
      setAmount("");
      reload();
      onChanged();
    } catch (e) {
      toast(errMsg(e), "err");
    } finally {
      setBusy(false);
    }
  }

  async function unlock() {
    if (!session || !st) return;
    setBusy(true);
    try {
      await sendTx(session, { address: st.veto, abi: tideVetoAbi, functionName: "unlock", args: [BigInt(l.id)] });
      toast("Tokens unlocked and back in your wallet.");
      reload();
      onChanged();
    } catch (e) {
      toast(errMsg(e), "err");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="tag">Holder veto</span>
        {pending && <span className={`pill ${st.blocked ? "down" : "tide"}`}>{st.blocked ? "BLOCKED" : open ? `closes in ${fmtDuration(pending.readyAt - now)}` : "voting closed"}</span>}
      </div>
      {pending && (
        <>
          <p className="note" style={{ marginTop: 0 }}>
            Don't want this switch? Lock your ${l.symbol}. If holders lock 10% of the circulating supply before the notice ends, the creator can't execute it.
          </p>
          <div className="veto-bar" aria-label="Veto progress">
            <i style={{ width: `${pct}%` }} />
          </div>
          <div className="row" style={{ justifyContent: "space-between", fontSize: 12, margin: "6px 0 12px" }}>
            <span>
              {fmtNum(Number(formatUnits(st.locked, 18)))} locked
            </span>
            <span className="dim">needs {fmtNum(Number(formatUnits(st.needed, 18)))}</span>
          </div>
          {open && (
            <div className="row">
              <div className="field" style={{ flex: "1 1 160px" }}>
                <label>
                  <span>Amount</span>
                  <button type="button" className="linkish" onClick={() => setAmount(formatUnits(st.bal, 18))}>
                    max {fmtNum(Number(formatUnits(st.bal, 18)))}
                  </button>
                </label>
                <input className="input mono" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
              </div>
              <button className="btn primary" disabled={busy || amt === 0n || amt > st.bal || hasStale} onClick={lock}>
                {busy ? <Spinner /> : "Lock to veto"}
              </button>
            </div>
          )}
        </>
      )}
      {st.myAmount > 0n && (
        <div className="row" style={{ marginTop: 10, justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 12 }}>
            You locked {fmtNum(Number(formatUnits(st.myAmount, 18)))}
            {hasStale ? " on an earlier proposal: unlock to vote again" : ""}
          </span>
          <button className="btn" disabled={busy} onClick={unlock}>
            {busy ? <Spinner /> : "Unlock"}
          </button>
        </div>
      )}
    </div>
  );
}
