import { useEffect, useState } from "react";
import { formatUnits, type Hex } from "viem";
import { creatorBondHookAbi, patienceHookAbi, sessionHookAbi, springHookAbi, tideRouterAbi, tideTokenAbi } from "../lib/abis";
import { useApp } from "../lib/appContext";
import { ADDR, ETH, client } from "../lib/chain";
import { usePoll, type Asset, type Launch } from "../lib/data";
import { fmtDuration } from "../lib/format";
import { loadCommits, onCommitsChange, saltHookData, saveCommits, type SavedCommit } from "../lib/pool";
import { fmtNum, priceAtTick, tokenPrice } from "../lib/price";
import { chainDeadline, errMsg, sendTx } from "../lib/tx";
import { useChainNow } from "../lib/wallet";
import { Price, Spinner } from "./bits";

type P = { launch: Launch; asset: Asset; poolId: Hex; onChanged: () => void };
const pct = (pips: number) => `${(pips / 10_000).toFixed(pips % 100 === 0 ? 2 : 3)}%`;

// ------------------------------------------------------------------ Patience

export function PatiencePanel({ launch: l, asset, poolId, onChanged }: P) {
  const { session, requireWallet, toast } = useApp();
  const now = useChainNow(1000);
  const [commits, setCommits] = useState<SavedCommit[]>(() => loadCommits(l.id));

  const mine = commits.filter((c) => !session || c.account.toLowerCase() === session.account.toLowerCase());

  // On-chain truth for each saved commitment: posted time (0 = never posted or already used).
  const [posted, , reloadPosted] = usePoll(
    () => Promise.all(mine.map((c) => client.readContract({ address: l.key.hooks, abi: patienceHookAbi, functionName: "commitments", args: [c.commitment] }))),
    10_000,
    [mine.map((c) => c.commitment).join()],
  );
  useEffect(
    () =>
      onCommitsChange(() => {
        setCommits(loadCommits(l.id));
        reloadPosted();
      }),
    [l.id, reloadPosted],
  );
  const [launchedAt] = usePoll(() => client.readContract({ address: l.key.hooks, abi: patienceHookAbi, functionName: "initializedAt", args: [poolId] }), 600_000, [poolId]);
  const [busy, setBusy] = useState<string | null>(null);

  const feeFor = (age: number) => {
    if (age < 30) return null;
    if (age > 86_400) return -1;
    const e = age - 30;
    return e >= 3600 ? 500 : 10_000 - Math.floor((9_500 * e) / 3600);
  };

  async function reveal(c: SavedCommit) {
    const s = requireWallet();
    if (!s) return;
    setBusy(c.commitment);
    const amountIn = BigInt(c.amountIn);
    const buy = c.zeroForOne === !l.tokenIsCurrency0;
    const inAsset = buy ? asset.address : l.token;
    try {
      if (inAsset !== ETH) {
        const allowance = await client.readContract({ address: inAsset, abi: tideTokenAbi, functionName: "allowance", args: [s.account, ADDR.router] });
        if (allowance < amountIn) await sendTx(s, { address: inAsset, abi: tideTokenAbi, functionName: "approve", args: [ADDR.router, amountIn] });
      }
      const swap = { key: l.key, zeroForOne: c.zeroForOne, amountIn, minOut: 0n, sqrtPriceLimitX96: BigInt(c.limit), hookData: saltHookData(c.salt) };
      const { result } = await client.simulateContract({ address: ADDR.router, abi: tideRouterAbi, functionName: "quoteExactIn", args: [swap] });
      const minOut = (result[1] * 98n) / 100n;
      await sendTx(s, {
        address: ADDR.router,
        abi: tideRouterAbi,
        functionName: "swapExactIn",
        args: [{ ...swap, minOut }, s.account, await chainDeadline()],
        value: inAsset === ETH ? amountIn : 0n,
      });
      saveCommits(l.id, loadCommits(l.id).filter((x) => x.commitment !== c.commitment));
      toast("Revealed and swapped at the patient fee.");
      onChanged();
    } catch (e) {
      toast(errMsg(e), "err");
    } finally {
      setBusy(null);
    }
  }

  const forget = (c: SavedCommit) => saveCommits(l.id, loadCommits(l.id).filter((x) => x.commitment !== c.commitment));

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="tag">Patience · your commitments</span>
        <span className="pill tide">instant lane 1.00%</span>
      </div>
      {mine.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          No commitments yet. Choose <b>Patient</b> in the swap box to commit to a buy or sell. Its size and direction stay hidden until you reveal it, and the fee falls from 1% to 0.05% over an hour.
        </p>
      ) : (
        <ul className="commits">
          {mine.map((c, i) => {
            const at = posted?.[i] !== undefined ? Number(posted[i]) : undefined;
            const start = at ? Math.max(at, Number(launchedAt ?? 0)) : 0;
            const age = at ? now - start : 0;
            const fee = at ? feeFor(age) : null;
            const buy = c.zeroForOne === !l.tokenIsCurrency0;
            const amt = Number(formatUnits(BigInt(c.amountIn), buy ? asset.decimals : 18));
            return (
              <li key={c.commitment}>
                <div>
                  <b>
                    {buy ? "Buy" : "Sell"} with {fmtNum(amt)} {buy ? asset.symbol : l.symbol}
                  </b>
                  <span className="dim mono">
                    {at === undefined ? "checking…" : at === 0 ? "not on-chain (pending, failed or already used)" : `age ${fmtDuration(age)}`}
                  </span>
                </div>
                <div className="commit-fee">
                  {at ? (fee === null ? <span className="pill moon">ready in {30 - age}s</span> : fee === -1 ? <span className="pill warn">expired</span> : <span className="pill tide">fee now {pct(fee)}</span>) : null}
                  {at && fee !== null && fee !== -1 ? (
                    <button className="btn small primary" disabled={!!busy} onClick={() => reveal(c)}>
                      {busy === c.commitment ? <Spinner /> : "Reveal & swap"}
                    </button>
                  ) : (
                    <button className="btn small" onClick={() => forget(c)}>
                      Forget
                    </button>
                  )}
                </div>
                <details>
                  <summary className="dim">backup salt</summary>
                  <code className="mono dim">{c.salt}</code>
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Spring

export function SpringPanel({ launch: l, poolId }: P) {
  const [d] = usePoll(
    async () => {
      const [rest, last] = (await client.readContract({ address: l.key.hooks, abi: springHookAbi, functionName: "springs", args: [poolId] })) as [number, number];
      const band = Number(await client.readContract({ address: l.key.hooks, abi: springHookAbi, functionName: "band" }));
      const [down, up] = await Promise.all(
        [true, false].map((z) =>
          client.readContract({ address: l.key.hooks, abi: springHookAbi, functionName: "quoteFee", args: [poolId, l.tick, z, z ? 4295128740n : 1461446703485210103287273052203988822378723970341n] }),
        ),
      );
      return { rest: Number(rest), last: Number(last), band, down: Number(down), up: Number(up) };
    },
    12_000,
    [poolId, l.tick],
  );
  const buyZ = !l.tokenIsCurrency0;
  const stretch = d ? l.tick - d.rest : 0;
  // A higher token price is a lower tick when the token is currency1.
  const tokenAbove = d ? (l.tokenIsCurrency0 ? stretch > 0 : stretch < 0) : false;
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="tag">Spring · live state</span>
        {d && <span className={`pill ${Math.abs(stretch) <= d.band ? "tide" : "moon"}`}>{Math.abs(stretch) <= d.band ? "relaxed" : `stretched ${Math.abs(stretch)} ticks ${tokenAbove ? "above" : "below"} rest`}</span>}
      </div>
      {!d ? (
        <p className="muted">Reading the spring…</p>
      ) : (
        <div className="stats">
          <div className="stat">
            <label>Buy fee now</label>
            <b>{pct(buyZ ? d.down : d.up)}</b>
          </div>
          <div className="stat">
            <label>Sell fee now</label>
            <b>{pct(buyZ ? d.up : d.down)}</b>
          </div>
          <div className="stat">
            <label>Rest updated</label>
            <b>{fmtDuration(Math.max(0, Math.floor(Date.now() / 1000) - d.last))} ago</b>
          </div>
        </div>
      )}
      <p className="note">The rest price is a time-weighted average that follows the market over about an hour. Swaps that push the price further from it pay more. Swaps that move it back pay 0.05% if they stop at the rest price.</p>
    </div>
  );
}

// ------------------------------------------------------------------ Bond


export function BondPanel({ launch: l, asset, poolId, onChanged }: P) {
  const { session, requireWallet, toast } = useApp();
  const H = l.key.hooks;
  const [d, , reload] = usePoll(
    async () => {
      const [b, claimable, slashable, heldFor, vested] = await Promise.all([
        client.readContract({ address: H, abi: creatorBondHookAbi, functionName: "getBond", args: [poolId] }),
        client.readContract({ address: H, abi: creatorBondHookAbi, functionName: "claimable", args: [poolId] }),
        client.readContract({ address: H, abi: creatorBondHookAbi, functionName: "slashable", args: [poolId] }),
        client.readContract({ address: H, abi: creatorBondHookAbi, functionName: "heldFor", args: [poolId] }),
        client.readContract({ address: H, abi: creatorBondHookAbi, functionName: "vested", args: [poolId] }),
      ]);
      return { b, claimable, slashable, heldFor: Number(heldFor), vested };
    },
    12_000,
    [poolId],
  );
  const [busy, setBusy] = useState<string | null>(null);
  const now = useChainNow(5000);

  if (!d) return <div className="panel"><p className="muted">Reading the bond…</p></div>;
  const { creator, slashed, floorTick, start, vestDuration, grace, isBelow, armed, belowSince, amount, claimed } = d.b;
  if (creator === "0x0000000000000000000000000000000000000000")
    return (
      <div className="panel">
        <p className="muted">No creator bond on this pool.</p>
      </div>
    );
  const floor = priceAtTick(Number(floorTick), l.tokenIsCurrency0, asset.decimals);
  const price = tokenPrice(l.sqrtPriceX96, l.tokenIsCurrency0, asset.decimals);
  const isCreator = session?.account.toLowerCase() === creator.toLowerCase();
  const g = Number(grace);
  const tok = (x: bigint) => fmtNum(Number(formatUnits(x, 18)));

  async function act(fn: "claim" | "slash") {
    const s = requireWallet();
    if (!s) return;
    setBusy(fn);
    try {
      await sendTx(s, { address: H, abi: creatorBondHookAbi, functionName: fn, args: [l.key] });
      toast(fn === "claim" ? "Claimed vested tokens." : "Bond slashed: unclaimed tokens burned.");
      reload();
      onChanged();
    } catch (e) {
      toast(errMsg(e), "err");
    } finally {
      setBusy(null);
    }
  }

  const status = slashed
    ? { cls: "warn", t: "Slashed: unclaimed tokens were burned" }
    : !armed
      ? { cls: "moon", t: "Floor not reached yet: creator tokens stay locked, and slashing arms once the price first reaches the floor" }
      : d.slashable
      ? { cls: "warn", t: "Slashable now: the floor has been broken for the full grace period" }
      : isBelow
        ? { cls: "moon", t: `Below the floor: anyone can slash in ${fmtDuration(Math.max(0, g - (now - Number(belowSince))))}` }
        : d.heldFor < g
          ? { cls: "moon", t: `Above the floor: it must hold another ${fmtDuration(g - d.heldFor)} before the creator can claim` }
          : { cls: "ok", t: "Floor holding: the creator can claim vested tokens" };

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="tag">Creator bond · live state</span>
        <span className={`pill ${status.cls}`}>{status.t}</span>
      </div>
      <div className="stats">
        <div className="stat">
          <label>Floor price</label>
          <b><Price value={floor} /></b>
        </div>
        <div className="stat">
          <label>Price now</label>
          <b className={price >= floor ? "ok" : "warn"}><Price value={price} /></b>
        </div>
        <div className="stat">
          <label>Bonded</label>
          <b>{tok(amount)}</b>
        </div>
        <div className="stat">
          <label>Vested</label>
          <b>{tok(d.vested)}</b>
        </div>
        <div className="stat">
          <label>Claimed</label>
          <b>{tok(claimed)}</b>
        </div>
        <div className="stat">
          <label>Vesting ends</label>
          <b>{fmtDuration(Math.max(0, Number(start) + Number(vestDuration) - now))}</b>
        </div>
      </div>
      <div className="row" style={{ marginTop: 14 }}>
        {isCreator && (
          <button className="btn primary" disabled={!!busy || d.claimable === 0n} onClick={() => act("claim")}>
            {busy === "claim" ? <Spinner /> : `Claim ${tok(d.claimable)}`}
          </button>
        )}
        <button className="btn" disabled={!!busy || !d.slashable} onClick={() => act("slash")} style={d.slashable ? { borderColor: "var(--warn)", color: "var(--warn)" } : undefined}>
          {busy === "slash" ? <Spinner /> : "Slash bond"}
        </button>
      </div>
      <p className="note">Anyone can call slash. The contract only allows it after the price has reached the floor at least once and then stayed below it for the full grace period.</p>
    </div>
  );
}

// ------------------------------------------------------------------ Session

const SESSIONS = ["Regular", "Extended", "Closed", "Weekend"];

export function SessionPanel({ launch: l }: P) {
  const [d] = usePoll(
    async () => {
      const H = l.key.hooks;
      const now = BigInt(Math.floor(Date.now() / 1000));
      const [fee, session, ...fees] = await Promise.all([
        client.readContract({ address: H, abi: sessionHookAbi, functionName: "currentFee" }),
        client.readContract({ address: H, abi: sessionHookAbi, functionName: "sessionAt", args: [now] }),
        ...[0n, 1n, 2n, 3n].map((i) => client.readContract({ address: H, abi: sessionHookAbi, functionName: "fees", args: [i] })),
      ]);
      return { fee: Number(fee), session: Number(session), fees: fees.map(Number) };
    },
    30_000,
    [l.key.hooks],
  );
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="tag">Session · from the hook</span>
        {d && <span className="pill tide">{SESSIONS[d.session]} · {pct(d.fee)}</span>}
      </div>
      {!d ? (
        <p className="muted">Reading the session…</p>
      ) : (
        <div className="stats">
          {SESSIONS.map((s, i) => (
            <div key={s} className={`stat ${d.session === i ? "hi" : ""}`}>
              <label>{s}</label>
              <b>{pct(d.fees[i])}</b>
            </div>
          ))}
        </div>
      )}
      <p className="note">The fee follows NYSE hours (UTC; DST and holidays kept up to date on-chain). It's lowest while the real market can arbitrage the pool, and highest over weekends, when prices can jump at the next open.</p>
    </div>
  );
}
