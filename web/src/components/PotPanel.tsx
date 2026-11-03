import { useState } from "react";
import { formatUnits, type Hex } from "viem";
import { tidePotHookAbi } from "../lib/abis";
import { useApp } from "../lib/appContext";
import { client } from "../lib/chain";
import { usePoll, type Asset, type Launch } from "../lib/data";
import { fmtDuration, short } from "../lib/format";
import { fmtNum } from "../lib/price";
import { errMsg, sendTx } from "../lib/tx";
import { fmtUsd, useUsdPrices } from "../lib/usd";
import { useChainNow } from "../lib/wallet";
import { Spinner } from "./bits";

type P = { launch: Launch; asset: Asset; poolId: Hex; onChanged: () => void };

/** Tide Pot: the creator's 1% of every buy fills a pot; the last qualifying buyer before the clock runs out wins 80%. */
export function PotPanel({ launch: l, asset, poolId, onChanged }: P) {
  const { session, toast } = useApp();
  const usd = useUsdPrices();
  const now = useChainNow(1000);
  const [busy, setBusy] = useState<string | null>(null);
  const [d, , reload] = usePoll(
    async () => {
      const [amount, leader, deadline, round, minBuy] = (await client.readContract({ address: l.key.hooks, abi: tidePotHookAbi, functionName: "potOf", args: [poolId] })) as readonly [bigint, `0x${string}`, bigint, number, bigint];
      const won = session ? ((await client.readContract({ address: l.key.hooks, abi: tidePotHookAbi, functionName: "owed", args: [session.account, l.quote] })) as bigint) : 0n;
      return { amount, leader, deadline: Number(deadline), round, minBuy, won };
    },
    5_000,
    [poolId, session?.account],
  );
  if (!d) return null;
  const px = usd.get(l.quote.toLowerCase());
  const amt = Number(formatUnits(d.amount, asset.decimals));
  const money = (n: number) => (px ? fmtUsd(n * px) : `${fmtNum(n)} ${asset.symbol}`);
  const running = d.deadline > 0;
  const left = d.deadline - now;
  const over = running && left <= 0;
  const me = session && d.leader.toLowerCase() === session.account.toLowerCase();

  async function call(fn: "settle" | "claim") {
    if (!session) return;
    setBusy(fn);
    try {
      await sendTx(session, { address: l.key.hooks, abi: tidePotHookAbi, functionName: fn, args: fn === "settle" ? [l.key] : [l.quote] });
      toast(fn === "settle" ? "Round settled: the winner can claim." : "Prize sent to your wallet.");
      reload();
      onChanged();
    } catch (e) {
      toast(errMsg(e), "err");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="pot">
      <div className="pot-head">
        <span className="dim">ROUND {d.round + 1} · POT</span>
        <b className="pixel lime pot-amount">{money(amt)}</b>
        <span className="dim">winner takes {money(amt * 0.8)} · 20% rolls into the next round</span>
      </div>
      <div className="pot-grid">
        <div>
          <label>Time left</label>
          <b className={running && left < 300 ? "down" : ""}>{!running ? "waiting for a buy" : over ? "round over" : fmtDuration(left)}</b>
        </div>
        <div>
          <label>Leader</label>
          <b>{running ? (me ? "YOU" : short(d.leader)) : "—"}</b>
        </div>
        <div>
          <label>Buy to lead</label>
          <b>≥ {d.minBuy > 0n ? money(Number(formatUnits(d.minBuy, asset.decimals))) : "any buy"}</b>
        </div>
      </div>
      <p className="note" style={{ margin: "10px 0" }}>
        Every trade still costs 2%. On a Pot coin the creator's 1% of each buy fills this pot. A buy of at least 2% of the pot makes
        you the leader and resets the clock to 1 hour. When it hits zero, the leader wins.
      </p>
      <div className="row">
        {over && (
          <button className="btn primary" disabled={!!busy} onClick={() => call("settle")}>
            {busy === "settle" ? <Spinner /> : "Settle round"}
          </button>
        )}
        {d.won > 0n && (
          <button className="btn primary" disabled={!!busy} onClick={() => call("claim")}>
            {busy === "claim" ? <Spinner /> : `Claim ${money(Number(formatUnits(d.won, asset.decimals)))} prize`}
          </button>
        )}
      </div>
    </div>
  );
}
