import { useState } from "react";
import { formatUnits, maxUint256, parseAbiItem, parseUnits, type Address, type Hex } from "viem";
import { tideOrdersAbi, tideTokenAbi } from "../lib/abis";
import { useApp } from "../lib/appContext";
import { ADDR, client } from "../lib/chain";
import { balanceOf, usePoll, type Asset, type Launch } from "../lib/data";
import { fmtDuration } from "../lib/format";
import { fmtNum, priceAtTick } from "../lib/price";
import { errMsg, sendTx } from "../lib/tx";
import { fmtUsd, useUsdPrices } from "../lib/usd";
import { useChainNow } from "../lib/wallet";
import { Price, Spinner } from "./bits";

const LN = Math.log(1.0001);
const ORDERS = ADDR.orders as Address;
const PLACED = parseAbiItem("event LimitPlaced(uint256 indexed id, address indexed owner, bytes32 indexed poolId, bool zeroForOne, int24 tickLower, int24 tickUpper, uint256 amountIn)");
const DCA_CREATED = parseAbiItem("event DcaCreated(uint256 indexed id, address indexed owner, bytes32 indexed poolId, bool zeroForOne, uint256 perSlice, uint32 slices, uint32 interval, uint160 limitSqrtPriceX96)");
const INTERVALS: [string, number][] = [["1h", 3600], ["4h", 14400], ["12h", 43200], ["1d", 86400]];

const floorTo = (t: number, s: number) => Math.floor(t / s) * s;
const ceilTo = (t: number, s: number) => Math.ceil(t / s) * s;
/** sqrtPriceX96 at a tick, as a bigint (float precision is plenty for a price limit). */
const sqrtAt = (tick: number) => BigInt(Math.floor(Math.sqrt(1.0001 ** tick) * 2 ** 96));

/** Limit orders and DCA for one launch pool, through TideOrders (no extra fee, anyone can trigger fills). */
export function OrdersPanel({ launch: l, asset, poolId, onChanged }: { launch: Launch; asset: Asset; poolId: Hex; onChanged: () => void }) {
  const [live] = usePoll(async () => ((await client.getCode({ address: ORDERS })) ?? "0x").length > 2, 120_000, []);
  const [tab, setTab] = useState<"limit" | "dca">("limit");
  if (!live) return null;
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="tag">Orders</span>
        <div className="seg" style={{ marginLeft: "auto" }}>
          <button className={tab === "limit" ? "on" : ""} onClick={() => setTab("limit")}>
            Limit
          </button>
          <button className={tab === "dca" ? "on" : ""} onClick={() => setTab("dca")}>
            DCA
          </button>
        </div>
      </div>
      {tab === "limit" ? <LimitForm l={l} asset={asset} poolId={poolId} onChanged={onChanged} /> : <DcaForm l={l} asset={asset} poolId={poolId} onChanged={onChanged} />}
    </div>
  );
}

function useAmount(raw: string, decimals: number): bigint {
  try {
    return raw ? parseUnits(raw, decimals) : 0n;
  } catch {
    return 0n;
  }
}

/** Approve TideOrders for an ERC20 if needed, then send `call`. */
async function withApproval(session: NonNullable<ReturnType<typeof useApp>["session"]>, token: Address, amount: bigint) {
  const allowance = (await client.readContract({ address: token, abi: tideTokenAbi, functionName: "allowance", args: [session.account, ORDERS] })) as bigint;
  if (allowance < amount) await sendTx(session, { address: token, abi: tideTokenAbi, functionName: "approve", args: [ORDERS, maxUint256] });
}

function LimitForm({ l, asset, poolId, onChanged }: { l: Launch; asset: Asset; poolId: Hex; onChanged: () => void }) {
  const { session, toast, requireWallet } = useApp();
  const usd = useUsdPrices();
  const [side, setSide] = useState<"buy" | "sell">("sell");
  const [pct, setPct] = useState(50);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const buy = side === "buy";
  const inDec = buy ? asset.decimals : 18;
  const inAddr = (buy ? l.quote : l.token) as Address;
  const amt = useAmount(amount, inDec);
  const [bal] = usePoll(() => (session ? balanceOf(inAddr, session.account) : Promise.resolve(0n)), 12_000, [session?.account, inAddr]);

  // Pool tick moves opposite to the token price when the token is currency1.
  const t = l.tick;
  const s = l.key.tickSpacing;
  const move = Math.log(1 + (buy ? -pct : pct) / 100) / LN;
  const targetTick = Math.round(l.tokenIsCurrency0 ? t + move : t - move);
  const zeroForOne = buy ? !l.tokenIsCurrency0 : l.tokenIsCurrency0; // the currency being sold is currency0
  const tickLower = zeroForOne ? Math.max(ceilTo(targetTick, s), ceilTo(t + 1, s)) : Math.min(floorTo(targetTick, s), floorTo(t, s)) - s;
  const mid = tickLower + s / 2;
  const fillPrice = priceAtTick(mid, l.tokenIsCurrency0, asset.decimals);
  const qUsd = usd.get(l.quote.toLowerCase());

  async function place() {
    const ss = requireWallet();
    if (!ss || amt === 0n) return;
    setBusy(true);
    try {
      const isEth = inAddr.toLowerCase() === "0x0000000000000000000000000000000000000000";
      if (!isEth) await withApproval(ss, inAddr, amt);
      await sendTx(ss, { address: ORDERS, abi: tideOrdersAbi, functionName: "placeLimit", args: [l.key, zeroForOne, tickLower, amt], value: isEth ? amt : undefined });
      toast(`Limit ${side} placed at ${pct}% ${buy ? "below" : "above"} the current price.`);
      setAmount("");
      onChanged();
    } catch (e) {
      toast(errMsg(e), "err");
    } finally {
      setBusy(false);
    }
  }

  const chips = buy ? [10, 25, 50, 75] : [25, 50, 100, 200];
  return (
    <>
      <div className="seg buysell" style={{ marginBottom: 10 }}>
        <button className={buy ? "on buy" : ""} onClick={() => (setSide("buy"), setPct(25))}>
          Buy the dip
        </button>
        <button className={!buy ? "on sell" : ""} onClick={() => (setSide("sell"), setPct(50))}>
          Take profit
        </button>
      </div>
      <div className="field">
        <label>
          <span>{buy ? "When price drops" : "When price rises"}</span>
          <span className="mono">{buy ? "-" : "+"}{pct}%</span>
        </label>
        <div className="seg" style={{ flexWrap: "wrap" }}>
          {chips.map((c) => (
            <button key={c} className={pct === c ? "on" : ""} onClick={() => setPct(c)}>
              {buy ? "-" : "+"}
              {c}%
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label>
          <span>{buy ? `Spend (${asset.symbol})` : `Sell ($${l.symbol})`}</span>
          <button type="button" className="linkish" onClick={() => setAmount(formatUnits(bal ?? 0n, inDec))}>
            balance {fmtNum(Number(formatUnits(bal ?? 0n, inDec)))}
          </button>
        </label>
        <input className="input mono" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0" />
      </div>
      <dl className="kv" style={{ margin: "8px 0 12px" }}>
        <dt>Fills around</dt>
        <dd>
          <Price value={fillPrice} /> {asset.symbol}
        </dd>
        <dt>At market cap</dt>
        <dd>{qUsd ? fmtUsd(fillPrice * 1e9 * qUsd) : `${fmtNum(fillPrice * 1e9)} ${asset.symbol}`}</dd>
        <dt>Extra fee</dt>
        <dd>none (buyers crossing it pay the usual 2%)</dd>
      </dl>
      <button className="btn primary block" disabled={busy || amt === 0n || amt > (bal ?? 0n)} onClick={place}>
        {busy ? <Spinner /> : session ? `Place limit ${side}` : "Connect wallet"}
      </button>
      <MyLimits l={l} asset={asset} poolId={poolId} onChanged={onChanged} />
    </>
  );
}

function MyLimits({ l, asset, poolId, onChanged }: { l: Launch; asset: Asset; poolId: Hex; onChanged: () => void }) {
  const { session, toast } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [rows, , reload] = usePoll(
    async () => {
      if (!session) return [];
      const logs = await client.getLogs({ address: ORDERS, event: PLACED, args: { owner: session.account, poolId }, fromBlock: l.createdBlock, toBlock: "latest" });
      return Promise.all(
        logs.map(async (g) => {
          const id = g.args.id!;
          const [o, fillable] = await Promise.all([
            client.readContract({ address: ORDERS, abi: tideOrdersAbi, functionName: "getLimit", args: [id] }),
            client.readContract({ address: ORDERS, abi: tideOrdersAbi, functionName: "isFillable", args: [id] }),
          ]);
          return { id, o: o as { open: boolean; zeroForOne: boolean; tickLower: number; tickUpper: number }, fillable: fillable as boolean, amountIn: g.args.amountIn! };
        }),
      );
    },
    15_000,
    [session?.account, poolId],
  );
  const open = (rows ?? []).filter((r) => r.o.open).reverse();
  if (!open.length) return null;

  async function act(id: bigint, fn: "fill" | "cancelLimit") {
    if (!session) return;
    setBusy(id + fn);
    try {
      await sendTx(session, { address: ORDERS, abi: tideOrdersAbi, functionName: fn, args: [id] });
      toast(fn === "fill" ? "Order filled: proceeds sent to your wallet." : "Order cancelled: funds returned.");
      reload();
      onChanged();
    } catch (e) {
      toast(errMsg(e), "err");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="order-list">
      <div className="dim" style={{ fontSize: 11, margin: "14px 0 6px" }}>YOUR OPEN LIMIT ORDERS</div>
      {open.map((r) => {
        const sellsToken = r.o.zeroForOne === l.tokenIsCurrency0;
        const price = priceAtTick((r.o.tickLower + r.o.tickUpper) / 2, l.tokenIsCurrency0, asset.decimals);
        const amt = Number(formatUnits(r.amountIn, sellsToken ? 18 : asset.decimals));
        return (
          <div key={String(r.id)} className="order-row">
            <span className={sellsToken ? "down" : "up"}>{sellsToken ? "SELL" : "BUY"}</span>
            <span className="mono">
              {fmtNum(amt)} {sellsToken ? `$${l.symbol}` : asset.symbol} @ <Price value={price} />
            </span>
            {r.fillable ? (
              <button className="btn small primary" disabled={!!busy} onClick={() => act(r.id, "fill")}>
                {busy === r.id + "fill" ? <Spinner /> : "Claim fill"}
              </button>
            ) : (
              <button className="btn small" disabled={!!busy} onClick={() => act(r.id, "cancelLimit")}>
                {busy === r.id + "cancelLimit" ? <Spinner /> : "Cancel"}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function DcaForm({ l, asset, poolId, onChanged }: { l: Launch; asset: Asset; poolId: Hex; onChanged: () => void }) {
  const { session, toast, requireWallet } = useApp();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [total, setTotal] = useState("");
  const [slices, setSlices] = useState(10);
  const [interval, setIntervalSec] = useState(3600);
  const [maxMove, setMaxMove] = useState(25);
  const [busy, setBusy] = useState(false);
  const buy = side === "buy";
  const inDec = buy ? asset.decimals : 18;
  const inAddr = (buy ? l.quote : l.token) as Address;
  const amt = useAmount(total, inDec);
  const per = slices > 0 ? amt / BigInt(slices) : 0n;
  const [bal] = usePoll(() => (session ? balanceOf(inAddr, session.account) : Promise.resolve(0n)), 12_000, [session?.account, inAddr]);
  const zeroForOne = buy ? !l.tokenIsCurrency0 : l.tokenIsCurrency0;

  async function create() {
    const ss = requireWallet();
    if (!ss || per === 0n) return;
    setBusy(true);
    try {
      const totalExact = per * BigInt(slices);
      const isEth = inAddr.toLowerCase() === "0x0000000000000000000000000000000000000000";
      if (!isEth) await withApproval(ss, inAddr, totalExact);
      // Worst price: maxMove% past today's price in the direction this swap pushes it.
      const d = Math.log(1 + maxMove / 100) / LN;
      const limit = maxMove === 0 ? 0n : sqrtAt(Math.round(zeroForOne ? l.tick - d : l.tick + d));
      await sendTx(ss, { address: ORDERS, abi: tideOrdersAbi, functionName: "createDca", args: [l.key, zeroForOne, per, slices, interval, limit], value: isEth ? totalExact : undefined });
      toast(`DCA started: ${slices} ${side}s, one every ${INTERVALS.find((i) => i[1] === interval)?.[0]}.`);
      setTotal("");
      onChanged();
    } catch (e) {
      toast(errMsg(e), "err");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="seg buysell" style={{ marginBottom: 10 }}>
        <button className={buy ? "on buy" : ""} onClick={() => setSide("buy")}>
          DCA buy
        </button>
        <button className={!buy ? "on sell" : ""} onClick={() => setSide("sell")}>
          DCA sell
        </button>
      </div>
      <div className="field">
        <label>
          <span>Total {buy ? `(${asset.symbol})` : `($${l.symbol})`}</span>
          <button type="button" className="linkish" onClick={() => setTotal(formatUnits(bal ?? 0n, inDec))}>
            balance {fmtNum(Number(formatUnits(bal ?? 0n, inDec)))}
          </button>
        </label>
        <input className="input mono" inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} placeholder="0.0" />
      </div>
      <div className="row">
        <div className="field">
          <label>Slices</label>
          <input className="input mono" type="number" min={2} max={1000} value={slices} onChange={(e) => setSlices(Math.max(1, Math.min(1000, Number(e.target.value) || 1)))} />
        </div>
        <div className="field">
          <label>Every</label>
          <div className="seg">
            {INTERVALS.map(([lab, sec]) => (
              <button key={lab} className={interval === sec ? "on" : ""} onClick={() => setIntervalSec(sec)}>
                {lab}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="field">
        <label>
          <span>Skip a slice if price moved more than</span>
          <span className="mono">{maxMove ? `${maxMove}%` : "no limit"}</span>
        </label>
        <div className="seg">
          {[10, 25, 50, 0].map((m) => (
            <button key={m} className={maxMove === m ? "on" : ""} onClick={() => setMaxMove(m)}>
              {m ? `${m}%` : "none"}
            </button>
          ))}
        </div>
      </div>
      <p className="note" style={{ margin: "6px 0 12px" }}>
        {per > 0n ? `${fmtNum(Number(formatUnits(per, inDec)))} ${buy ? asset.symbol : "$" + l.symbol} every ${INTERVALS.find((i) => i[1] === interval)?.[0]}, ${slices} times. ` : ""}
        Funds stay in the TideOrders contract; cancel any time for the rest. Slices pay the usual 2%, nothing more.
      </p>
      <button className="btn primary block" disabled={busy || per === 0n || amt > (bal ?? 0n)} onClick={create}>
        {busy ? <Spinner /> : session ? `Start DCA ${side}` : "Connect wallet"}
      </button>
      <MyDcas l={l} asset={asset} poolId={poolId} onChanged={onChanged} />
    </>
  );
}

function MyDcas({ l, asset, poolId, onChanged }: { l: Launch; asset: Asset; poolId: Hex; onChanged: () => void }) {
  const { session, toast } = useApp();
  const now = useChainNow(1000);
  const [busy, setBusy] = useState<string | null>(null);
  const [rows, , reload] = usePoll(
    async () => {
      if (!session) return [];
      const logs = await client.getLogs({ address: ORDERS, event: DCA_CREATED, args: { owner: session.account, poolId }, fromBlock: l.createdBlock, toBlock: "latest" });
      return Promise.all(
        logs.map(async (g) => {
          const d = (await client.readContract({ address: ORDERS, abi: tideOrdersAbi, functionName: "getDca", args: [g.args.id!] })) as { slicesLeft: number; nextAt: bigint; perSlice: bigint; zeroForOne: boolean };
          return { id: g.args.id!, d, slices: g.args.slices! };
        }),
      );
    },
    15_000,
    [session?.account, poolId],
  );
  const live = (rows ?? []).filter((r) => r.d.slicesLeft > 0).reverse();
  if (!live.length) return null;

  async function act(id: bigint, fn: "execute" | "cancelDca") {
    if (!session) return;
    setBusy(id + fn);
    try {
      await sendTx(session, { address: ORDERS, abi: tideOrdersAbi, functionName: fn, args: [id] });
      toast(fn === "execute" ? "Slice executed." : "DCA cancelled: the rest is back in your wallet.");
      reload();
      onChanged();
    } catch (e) {
      toast(errMsg(e), "err");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="order-list">
      <div className="dim" style={{ fontSize: 11, margin: "14px 0 6px" }}>YOUR DCA PLANS</div>
      {live.map((r) => {
        const buys = r.d.zeroForOne !== l.tokenIsCurrency0;
        const due = now >= Number(r.d.nextAt);
        return (
          <div key={String(r.id)} className="order-row">
            <span className={buys ? "up" : "down"}>{buys ? "BUY" : "SELL"}</span>
            <span className="mono">
              {fmtNum(Number(formatUnits(r.d.perSlice, buys ? asset.decimals : 18)))} × {r.d.slicesLeft}/{r.slices} · {due ? "due now" : `next in ${fmtDuration(Number(r.d.nextAt) - now)}`}
            </span>
            {due && (
              <button className="btn small primary" disabled={!!busy} onClick={() => act(r.id, "execute")}>
                {busy === r.id + "execute" ? <Spinner /> : "Run"}
              </button>
            )}
            <button className="btn small" disabled={!!busy} onClick={() => act(r.id, "cancelDca")}>
              {busy === r.id + "cancelDca" ? <Spinner /> : "Cancel"}
            </button>
          </div>
        );
      })}
    </div>
  );
}
