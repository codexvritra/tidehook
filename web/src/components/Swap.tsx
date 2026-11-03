import { useEffect, useMemo, useState } from "react";
import { encodeAbiParameters, formatUnits, parseUnits, type Address, type Hex } from "viem";
import { patienceHookAbi, sessionHookAbi, springHookAbi, tideRouterAbi, tideTokenAbi } from "../lib/abis";
import { useApp } from "../lib/appContext";
import { ADDR, ETH, client } from "../lib/chain";
import { balanceOf, usePoll, type Asset, type Launch } from "../lib/data";
import { commitmentOf, loadCommits, newSalt, saveCommits } from "../lib/pool";
import { buyIsZeroForOne, fmtNum, limitFor, tokenPrice } from "../lib/price";
import { chainDeadline, errMsg, sendTx } from "../lib/tx";
import { Spinner } from "./bits";

type Props = { launch: Launch; asset: Asset; poolId: Hex; onTraded: () => void };


/** Fee the hook will charge for this swap, read from the hook itself. */
async function readFee(l: Launch, poolId: Hex, zeroForOne: boolean, limit: bigint): Promise<number> {
  const hook = l.key.hooks;
  if (l.kind === 0) return Number(await client.readContract({ address: hook, abi: patienceHookAbi, functionName: "baseFee" }));
  if (l.kind === 1)
    return Number(
      await client.readContract({ address: hook, abi: springHookAbi, functionName: "quoteFee", args: [poolId, l.tick, zeroForOne, limit] }),
    );
  if (l.kind === 3) return Number(await client.readContract({ address: hook, abi: sessionHookAbi, functionName: "currentFee" }));
  return l.key.fee; // Bond: static pool fee
}

export function Swap({ launch: l, asset, poolId, onTraded }: Props) {
  const { session, requireWallet, toast } = useApp();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState(1);
  const [lane, setLane] = useState<"fast" | "slow">("fast");
  const [busy, setBusy] = useState<string | null>(null);

  const buy = side === "buy";
  const zeroForOne = buy ? buyIsZeroForOne(l.tokenIsCurrency0) : !buyIsZeroForOne(l.tokenIsCurrency0);
  const inAsset: Address = buy ? asset.address : l.token;
  const inDecimals = buy ? asset.decimals : 18;
  const outDecimals = buy ? 18 : asset.decimals;
  const inSymbol = buy ? asset.symbol : l.symbol;
  const outSymbol = buy ? l.symbol : asset.symbol;

  const amountIn = useMemo(() => {
    try {
      const v = parseUnits(amount || "0", inDecimals);
      return v > 0n ? v : 0n;
    } catch {
      return 0n;
    }
  }, [amount, inDecimals]);

  const limit = limitFor(zeroForOne); // flat 2%: no reason to cap a swap at the Spring rest price

  const [balIn] = usePoll(() => (session ? balanceOf(inAsset, session.account) : Promise.resolve(0n)), 12_000, [session?.account, inAsset]);
  const [allowance, , reloadAllowance] = usePoll(
    () =>
      session && inAsset !== ETH
        ? client.readContract({ address: inAsset, abi: tideTokenAbi, functionName: "allowance", args: [session.account, ADDR.router] })
        : Promise.resolve(2n ** 255n),
    12_000,
    [session?.account, inAsset],
  );

  // Live quote via the router's on-chain quoter (eth_call: runs the real swap, then reverts).
  const [quote, setQuote] = useState<{ amountIn: bigint; out: bigint; fee: number } | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  useEffect(() => {
    setQuote(null);
    setQuoteErr(null);
    if (amountIn === 0n) return;
    let live = true;
    const t = setTimeout(async () => {
      try {
        const swap = { key: l.key, zeroForOne, amountIn, minOut: 0n, sqrtPriceLimitX96: limit, hookData: "0x" as Hex };
        const [{ result }, fee] = await Promise.all([
          client.simulateContract({ address: ADDR.router, abi: tideRouterAbi, functionName: "quoteExactIn", args: [swap] }),
          readFee(l, poolId, zeroForOne, limit),
        ]);
        if (live) setQuote({ amountIn: result[0], out: result[1], fee });
      } catch (e) {
        if (live) setQuoteErr(errMsg(e));
      }
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountIn, zeroForOne, limit, l.sqrtPriceX96, l.id]);

  const spot = tokenPrice(l.sqrtPriceX96, l.tokenIsCurrency0, asset.decimals);
  const execPrice = quote && quote.out > 0n ? (buy ? Number(formatUnits(quote.amountIn, inDecimals)) / Number(formatUnits(quote.out, 18)) : Number(formatUnits(quote.out, outDecimals)) / Number(formatUnits(quote.amountIn, 18))) : NaN;
  const impact = isFinite(execPrice) && spot > 0 ? Math.abs(execPrice / spot - 1) * 100 : NaN;
  const minOut = quote ? (quote.out * BigInt(Math.round((100 - slippage) * 100))) / 10_000n : 0n;
  const partial = quote && quote.amountIn < amountIn;
  const needsApproval = inAsset !== ETH && allowance !== undefined && allowance < amountIn;
  const insufficient = balIn !== undefined && session && amountIn > balIn;

  async function approve() {
    const s = requireWallet();
    if (!s) return;
    setBusy("approve");
    try {
      await sendTx(s, { address: inAsset, abi: tideTokenAbi, functionName: "approve", args: [ADDR.router, amountIn] });
      reloadAllowance();
      toast(`Approved ${inSymbol}.`);
    } catch (e) {
      toast(errMsg(e), "err");
    } finally {
      setBusy(null);
    }
  }

  async function swap() {
    const s = requireWallet();
    if (!s || !quote) return;
    setBusy("swap");
    try {
      await sendTx(s, {
        address: ADDR.router,
        abi: tideRouterAbi,
        functionName: "swapExactIn",
        // Pot coins: name the buyer as pot leader (works for smart wallets too).
        args: [{ key: l.key, zeroForOne, amountIn, minOut, sqrtPriceLimitX96: limit, hookData: l.kind === 4 && buy ? encodeAbiParameters([{ type: "address" }], [s.account]) : "0x" }, s.account, await chainDeadline()],
        value: inAsset === ETH ? amountIn : 0n,
      });
      toast(`Swapped ${fmtNum(Number(formatUnits(quote.amountIn, inDecimals)))} ${inSymbol} for ${fmtNum(Number(formatUnits(quote.out, outDecimals)))} ${outSymbol}.`);
      setAmount("");
      onTraded();
      reloadAllowance();
    } catch (e) {
      toast(errMsg(e), "err");
    } finally {
      setBusy(null);
    }
  }

  async function commit() {
    const s = requireWallet();
    if (!s || amountIn === 0n) return;
    setBusy("commit");
    const salt = newSalt();
    const lim = limitFor(zeroForOne);
    const commitment = commitmentOf(poolId, zeroForOne, amountIn, lim, salt);
    // Save before sending so the salt is never lost, even if the tab closes mid-transaction.
    const saved = { commitment, salt, zeroForOne, amountIn: amountIn.toString(), limit: lim.toString(), createdAt: Math.floor(Date.now() / 1000), account: s.account };
    saveCommits(l.id, [saved, ...loadCommits(l.id)]);
    try {
      await sendTx(s, { address: l.key.hooks, abi: patienceHookAbi, functionName: "commit", args: [commitment] });
      saveCommits(l.id, loadCommits(l.id)); // notify the Patience panel to re-read the chain now
      toast("Committed. The fee drops every minute: reveal it from the Patience panel when you're ready.");
      setAmount("");
    } catch (e) {
      saveCommits(l.id, loadCommits(l.id).filter((c) => c.commitment !== commitment));
      toast(errMsg(e), "err");
    } finally {
      setBusy(null);
    }
  }

  const fraction = (pct: number) => {
    if (balIn === undefined) return;
    // Keep a little native ETH back for gas when spending ETH.
    const reserve = inAsset === ETH ? parseUnits("0.0005", 18) : 0n;
    const spendable = balIn > reserve ? balIn - reserve : 0n;
    setAmount(formatUnits((spendable * BigInt(pct)) / 100n, inDecimals));
  };
  const max = () => fraction(100);

  const slowLane = l.kind === 0 && lane === "slow";

  return (
    <div className="panel swap">
      <div className="seg full">
        <button className={buy ? "on buy" : ""} onClick={() => setSide("buy")}>
          Buy
        </button>
        <button className={!buy ? "on sell" : ""} onClick={() => setSide("sell")}>
          Sell
        </button>
      </div>

      {l.kind === 0 && (
        <div className="lanes">
          <button className={lane === "fast" ? "on" : ""} onClick={() => setLane("fast")}>
            <b>Instant</b>
            <span>flat 2%, swaps now</span>
          </button>
          <button className={lane === "slow" ? "on" : ""} onClick={() => setLane("slow")}>
            <b>Patient</b>
            <span>flat 2%, size hidden until reveal</span>
          </button>
        </div>
      )}

      <div className="field" style={{ marginTop: 14 }}>
        <label>
          <span>You pay</span>
          <span className="dim">
            Balance {balIn !== undefined ? fmtNum(Number(formatUnits(balIn, inDecimals))) : "—"}{" "}
            {session && (
              <button className="link" onClick={max}>
                max
              </button>
            )}
          </span>
        </label>
        <div className="amount">
          <input className="input mono" inputMode="decimal" placeholder="0.0" value={amount} onChange={(e) => setAmount(e.target.value.replace(",", "."))} aria-label={`Amount of ${inSymbol}`} />
          <span className="unit">{inSymbol}</span>
        </div>
      </div>
      {session && (
        <div className="pcts">
          {[25, 50, 75, 100].map((p) => (
            <button key={p} onClick={() => fraction(p)}>
              {p}%
            </button>
          ))}
        </div>
      )}

      {!slowLane && (
        <div className="quote">
          <div>
            <span className="dim">You receive</span>
            <b className="mono">{quote ? `${fmtNum(Number(formatUnits(quote.out, outDecimals)))} ${outSymbol}` : amountIn > 0n && !quoteErr ? "…" : "—"}</b>
          </div>
          <div>
            <span className="dim">Launchpad tax</span>
            <span className="mono">{buy ? "2% (1% creator · 1% platform)" : "2% (platform)"}</span>
          </div>
          <div>
            <span className="dim">LP fee</span>
            <span className="mono">none</span>
          </div>
          <div>
            <span className="dim">Price impact</span>
            <span className={`mono ${impact > 5 ? "warn" : ""}`}>{isFinite(impact) ? `${impact.toFixed(2)}%` : "—"}</span>
          </div>
          <div>
            <span className="dim">Minimum received</span>
            <span className="mono">{quote ? fmtNum(Number(formatUnits(minOut, outDecimals))) : "—"}</span>
          </div>
          {partial && <p className="note warn">Only part of your amount fills before the price limit. You pay {fmtNum(Number(formatUnits(quote!.amountIn, inDecimals)))} {inSymbol}.</p>}
          {quoteErr && <p className="note warn">{quoteErr}</p>}
        </div>
      )}


      <div className="row" style={{ alignItems: "center", margin: "6px 0 12px" }}>
        <span className="dim" style={{ fontSize: 13 }}>
          Slippage
        </span>
        <div className="seg">
          {[0.5, 1, 3, 10].map((s) => (
            <button key={s} className={slippage === s ? "on" : ""} onClick={() => setSlippage(s)}>
              {s}%
            </button>
          ))}
        </div>
      </div>

      {!session ? (
        <button className="btn primary block" onClick={() => requireWallet()}>
          Connect wallet
        </button>
      ) : insufficient ? (
        <button className="btn block" disabled>
          Not enough {inSymbol}
        </button>
      ) : slowLane ? (
        <button className="btn primary block" disabled={amountIn === 0n || !!busy} onClick={commit}>
          {busy === "commit" ? (
            <>
              <Spinner /> Committing…
            </>
          ) : (
            `Commit to ${buy ? "buy" : "sell"} (private until reveal)`
          )}
        </button>
      ) : needsApproval ? (
        <button className="btn primary block" disabled={!!busy || amountIn === 0n} onClick={approve}>
          {busy === "approve" ? (
            <>
              <Spinner /> Approving…
            </>
          ) : (
            `Approve ${inSymbol}`
          )}
        </button>
      ) : (
        <button className={`btn block ${buy ? "buy" : "sell"}`} disabled={!quote || !!busy || quote.out === 0n} onClick={swap}>
          {busy === "swap" ? (
            <>
              <Spinner /> Swapping…
            </>
          ) : (
            `${buy ? "Buy" : "Sell"} ${l.symbol}`
          )}
        </button>
      )}
      {slowLane && <p className="note">You'll post a hash of this exact swap. Nobody can see its size or direction until you reveal it. After 30s it can be revealed. It pays the same flat 2% and expires after 24h.</p>}
    </div>
  );
}
