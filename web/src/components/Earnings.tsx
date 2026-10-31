import { useState } from "react";
import { formatUnits, type Address } from "viem";
import { patienceHookAbi } from "../lib/abis";
import { useApp } from "../lib/appContext";
import { ADDR, client } from "../lib/chain";
import { usePoll, type Asset } from "../lib/data";
import { usd, useEthUsd } from "../lib/ethPrice";
import { fmtNum } from "../lib/price";
import { errMsg, sendTx } from "../lib/tx";
import { Spinner } from "./bits";

// Every hook shares the TideFeeHook fee functions, so one ABI reads and claims from all four.
const HOOKS: [string, Address][] = [
  ["Patience", ADDR.patience],
  ["Spring", ADDR.spring],
  ["Bond", ADDR.bond],
  ["Session", ADDR.session],
];

/** Unclaimed fees of `account` in `asset`, per hook. */
function useOwed(account: Address | undefined, asset: Asset | undefined) {
  return usePoll(
    async () => {
      if (!account || !asset) return [];
      const amounts = await Promise.all(
        HOOKS.map(([, h]) => client.readContract({ address: h, abi: patienceHookAbi, functionName: "owed", args: [account, asset.address] })),
      );
      return HOOKS.map(([name, hook], i) => ({ name, hook, amount: amounts[i] as bigint }));
    },
    20_000,
    [account, asset?.address],
  );
}

export function EarningsPanel({ asset, mode }: { asset: Asset; mode: "creator" | "platform" }) {
  const { session, toast } = useApp();
  const ethUsd = useEthUsd();
  const account = mode === "creator" ? session?.account : ADDR.launcher;
  const [owed, , reload] = useOwed(account, asset);
  const [busy, setBusy] = useState(false);
  const total = (owed ?? []).reduce((s, o) => s + o.amount, 0n);
  const totalNum = Number(formatUnits(total, asset.decimals));

  async function claimAll() {
    if (!session) return;
    setBusy(true);
    try {
      for (const o of owed ?? []) {
        if (o.amount === 0n) continue;
        await sendTx(session, {
          address: o.hook,
          abi: patienceHookAbi,
          functionName: mode === "creator" ? "claim" : "claimPlatform",
          args: mode === "creator" ? [asset.address] : [ADDR.launcher, asset.address],
        });
      }
      toast(mode === "creator" ? `Claimed ${fmtNum(totalNum)} ${asset.symbol} to your wallet.` : `Sent ${fmtNum(totalNum)} ${asset.symbol} to the platform wallet.`);
      reload();
    } catch (e) {
      toast(errMsg(e), "err");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="tag">{mode === "creator" ? "Your earnings" : "Platform fees"}</span>
        <span className="pill tide">paid in {asset.symbol}</span>
      </div>
      <div className="stat hi" style={{ marginBottom: 12 }}>
        <label>Unclaimed</label>
        <b>
          {owed ? fmtNum(totalNum) : "…"} {asset.symbol} {asset.symbol === "ETH" && ethUsd && owed ? <span className="dim">≈ {usd(totalNum, ethUsd)}</span> : null}
        </b>
      </div>
      <p className="note" style={{ marginTop: 0 }}>
        {mode === "creator"
          ? "1% of every buy of your coins, across all your launches, paid in ETH. Never in your token."
          : "1% of every buy, 2% of every sell, plus LP fees, sent to the platform wallet in ETH."}
      </p>
      <button className="btn primary block" disabled={busy || total === 0n} onClick={claimAll}>
        {busy ? <Spinner /> : mode === "creator" ? "Claim to my wallet" : "Send to platform wallet"}
      </button>
    </div>
  );
}
