import { useCallback, useEffect, useRef, useState } from "react";
import { erc20Abi, parseAbiItem, type Address, type Hex } from "viem";
import { tideLauncherAbi } from "./abis";
import { ADDR, ETH, INDEXER_URL, POOL_MANAGER, client } from "./chain";

export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };

export type Launch = {
  id: number;
  token: Address;
  creator: Address;
  kind: number;
  tokenIsCurrency0: boolean;
  tickLower: number;
  tickUpper: number;
  bidLower: number;
  bidUpper: number;
  migrations: number;
  renamedAt: number;
  createdAt: number;
  createdBlock: bigint;
  key: PoolKey;
  name: string;
  symbol: string;
  imageURI: string;
  description: string;
  sqrtPriceX96: bigint;
  tick: number;
  quote: Address;
};

export const KINDS = ["Patience", "Spring", "Bond", "Session"] as const;
export const KIND_BLURB = [
  "Swap instantly, or commit first and reveal later so bots can't see your size coming.",
  "Tracks a time-weighted rest price on-chain, a live read of where the market settles.",
  "Creator tokens stay locked until the price has held above a floor. If it falls below, anyone can burn them.",
  "Built for coins paired with tokenized stocks, trading 24/7 around the market clock.",
];

/** Re-runs `fn` every `ms` while the tab is visible. Returns [data, error, reload]. */
export function usePoll<T>(fn: () => Promise<T>, ms: number, deps: unknown[]): [T | undefined, unknown, () => void] {
  const [data, setData] = useState<T>();
  const [err, setErr] = useState<unknown>();
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const run = useCallback(() => {
    fnRef
      .current()
      .then((d) => {
        setData(d);
        setErr(undefined);
      })
      .catch(setErr);
  }, []);
  useEffect(() => {
    setData(undefined);
    run();
    const id = setInterval(() => document.visibilityState === "visible" && run(), ms);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return [data, err, run];
}

// ------------------------------------------------------------------ deployment status

export type DeployState = { ready: boolean; missing: string[] };

export async function readDeployment(): Promise<DeployState> {
  const names = Object.keys(ADDR) as (keyof typeof ADDR)[];
  const codes = await Promise.all(names.map((n) => client.getCode({ address: ADDR[n] })));
  const missing = names.filter((_, i) => !codes[i] || codes[i] === "0x");
  // Add-ons (TideOrders) never gate the launchpad: their panels hide until they are deployed.
  const OPTIONAL: string[] = ["orders"];
  return { ready: missing.every((n) => OPTIONAL.includes(n)), missing };
}

// ------------------------------------------------------------------ launches

type RawLaunch = {
  token: Address;
  creator: Address;
  kind: number;
  tokenIsCurrency0: boolean;
  tickLower: number;
  tickUpper: number;
  bidLower: number;
  bidUpper: number;
  migrations: number;
  renamedAt: bigint;
  createdAt: bigint;
  createdBlock: bigint;
  key: PoolKey;
  name: string;
  symbol: string;
  imageURI: string;
  description: string;
};

function toLaunch(id: number, l: RawLaunch, sqrtPriceX96: bigint, tick: number): Launch {
  return {
    ...l,
    id,
    kind: Number(l.kind),
    createdAt: Number(l.createdAt),
    tickLower: Number(l.tickLower),
    tickUpper: Number(l.tickUpper),
    bidLower: Number(l.bidLower),
    bidUpper: Number(l.bidUpper),
    migrations: Number(l.migrations),
    renamedAt: Number(l.renamedAt),
    key: { ...l.key, fee: Number(l.key.fee), tickSpacing: Number(l.key.tickSpacing) },
    sqrtPriceX96,
    tick: Number(tick),
    quote: l.tokenIsCurrency0 ? l.key.currency1 : l.key.currency0,
  };
}

export async function readLaunches(limit = 120): Promise<Launch[]> {
  const count = Number(await client.readContract({ address: ADDR.launcher, abi: tideLauncherAbi, functionName: "launchCount" }));
  if (count === 0) return [];
  const [page, prices, ticks] = (await client.readContract({
    address: ADDR.launcher,
    abi: tideLauncherAbi,
    functionName: "getLaunches",
    args: [0n, BigInt(limit)],
  })) as unknown as [RawLaunch[], bigint[], number[]];
  return page.map((l, i) => toLaunch(count - 1 - i, l, prices[i], ticks[i]));
}

export async function readLaunch(id: number): Promise<Launch> {
  const count = Number(await client.readContract({ address: ADDR.launcher, abi: tideLauncherAbi, functionName: "launchCount" }));
  if (id < 0 || id >= count) throw new Error("No such launch");
  const [page, prices, ticks] = (await client.readContract({
    address: ADDR.launcher,
    abi: tideLauncherAbi,
    functionName: "getLaunches",
    args: [BigInt(count - 1 - id), 1n],
  })) as unknown as [RawLaunch[], bigint[], number[]];
  return toLaunch(id, page[0], prices[0], ticks[0]);
}

// ------------------------------------------------------------------ assets

export type Asset = { address: Address; symbol: string; decimals: number };
const assetCache = new Map<string, Promise<Asset>>();

export function readAsset(address: Address): Promise<Asset> {
  if (address.toLowerCase() === ETH) return Promise.resolve({ address: ETH, symbol: "ETH", decimals: 18 });
  const k = address.toLowerCase();
  if (!assetCache.has(k)) {
    assetCache.set(
      k,
      Promise.all([
        client.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
        client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
      ]).then(([symbol, decimals]) => ({ address, symbol, decimals: Number(decimals) })),
    );
  }
  return assetCache.get(k)!;
}

export function balanceOf(asset: Address, owner: Address): Promise<bigint> {
  if (asset.toLowerCase() === ETH) return client.getBalance({ address: owner });
  return client.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
}

// ------------------------------------------------------------------ trades

const SWAP_EVENT = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);

export type Trade = {
  tx: Hex;
  block: bigint;
  time: number; // unix seconds (block timestamp)
  trader: Address; // the wallet that traded through TideRouter, else the contract that called the PoolManager
  buy: boolean;
  tokenAmount: bigint;
  quoteAmount: bigint;
  sqrtPriceX96: bigint;
  fee: number;
};

const ROUTER_TRADE = parseAbiItem(
  "event Trade(bytes32 indexed poolId, address indexed trader, bool zeroForOne, uint256 amountIn, uint256 amountOut)",
);
const blockTimes = new Map<bigint, number>();

/** Block timestamps, cached forever (blocks never change). */
async function timesOf(blocks: bigint[]): Promise<void> {
  const missing = [...new Set(blocks)].filter((b) => !blockTimes.has(b));
  for (let i = 0; i < missing.length; i += 25) {
    const chunk = missing.slice(i, i + 25);
    const got = await Promise.all(chunk.map((b) => client.getBlock({ blockNumber: b })));
    got.forEach((b, j) => blockTimes.set(chunk[j], Number(b.timestamp)));
  }
}

async function fromIndexer<T>(path: string): Promise<T | null> {
  if (!INDEXER_URL) return null;
  try {
    const r = await fetch(INDEXER_URL + path, { signal: AbortSignal.timeout(6000) });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null; // indexer down: fall back to reading the chain
  }
}

type IndexedTrade = { tx: Hex; block: string; time: number; trader: Address; buy: boolean; token_amount: string; quote_amount: string; sqrt_price: string };

/** Every swap in a pool since launch: from the indexer when configured, else straight from PoolManager events. */
export async function readTrades(poolId: Hex, fromBlock: bigint, tokenIsCurrency0: boolean, launchId?: number): Promise<Trade[]> {
  if (launchId !== undefined) {
    const rows = await fromIndexer<IndexedTrade[]>(`/launch/${launchId}/trades?pool=${poolId}`);
    if (rows)
      return rows.map((r) => ({
        tx: r.tx,
        block: BigInt(r.block),
        time: r.time,
        trader: r.trader,
        buy: r.buy,
        tokenAmount: BigInt(r.token_amount),
        quoteAmount: BigInt(r.quote_amount),
        sqrtPriceX96: BigInt(r.sqrt_price),
        fee: 0,
      }));
  }
  const [logs, routed] = await Promise.all([
    client.getLogs({ address: POOL_MANAGER, event: SWAP_EVENT, args: { id: poolId }, fromBlock, toBlock: "latest" }),
    client.getLogs({ address: ADDR.router, event: ROUTER_TRADE, args: { poolId }, fromBlock, toBlock: "latest" }).catch(() => []),
  ]);
  const traderOf = new Map(routed.map((r) => [r.transactionHash!, r.args.trader!]));
  await timesOf(logs.map((l) => l.blockNumber!));
  return logs.map((l) => {
    const a0 = l.args.amount0!;
    const a1 = l.args.amount1!;
    // Swapper-side deltas (as emitted by PoolManager): negative = paid in, positive = received.
    const tokenDelta = tokenIsCurrency0 ? a0 : a1;
    const quoteDelta = tokenIsCurrency0 ? a1 : a0;
    const abs = (x: bigint) => (x < 0n ? -x : x);
    return {
      tx: l.transactionHash!,
      block: l.blockNumber!,
      time: blockTimes.get(l.blockNumber!) ?? 0,
      trader: traderOf.get(l.transactionHash!) ?? l.args.sender!,
      buy: tokenDelta > 0n, // the swapper received the token
      tokenAmount: abs(tokenDelta),
      quoteAmount: abs(quoteDelta),
      sqrtPriceX96: l.args.sqrtPriceX96!,
      fee: Number(l.args.fee),
    };
  });
}

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 amount)");
export type Holder = { address: Address; amount: bigint };

/** Token balances rebuilt from Transfer events, largest first (zero balances dropped). */
export async function readHolders(token: Address, fromBlock: bigint, launchId?: number): Promise<Holder[]> {
  if (launchId !== undefined) {
    const rows = await fromIndexer<{ holder: Address; amount: string }[]>(`/launch/${launchId}/holders`);
    if (rows) return rows.map((r) => ({ address: r.holder, amount: BigInt(r.amount) }));
  }
  const logs = await client.getLogs({ address: token, event: TRANSFER, fromBlock, toBlock: "latest" });
  const bal = new Map<string, bigint>();
  for (const l of logs) {
    const { from, to, amount } = l.args;
    if (from && from !== ETH) bal.set(from.toLowerCase(), (bal.get(from.toLowerCase()) ?? 0n) - amount!);
    if (to) bal.set(to.toLowerCase(), (bal.get(to.toLowerCase()) ?? 0n) + amount!);
  }
  return [...bal.entries()]
    .filter(([a, v]) => v > 0n && a !== ETH)
    .map(([a, v]) => ({ address: a as Address, amount: v }))
    .sort((x, y) => (y.amount > x.amount ? 1 : y.amount < x.amount ? -1 : 0));
}

// ------------------------------------------------------------------ creator controls

export type Pending = { kind: number; quote: Address; readyAt: number } | null;

export async function readPending(id: number): Promise<Pending> {
  const [kind, quote, readyAt] = (await client.readContract({
    address: ADDR.launcher,
    abi: tideLauncherAbi,
    functionName: "pendingMigration",
    args: [BigInt(id)],
  })) as unknown as [number, Address, bigint, number, Hex];
  return readyAt === 0n ? null : { kind: Number(kind), quote, readyAt: Number(readyAt) };
}

const RENAMED = parseAbiItem("event MetadataUpdated(uint256 indexed id, string name, string symbol, string imageURI, string description)");
const QUOTE_ALLOWED = parseAbiItem("event QuoteAllowed(address indexed quote, bool allowed)");

/** Every rename of a launch, oldest first (from MetadataUpdated events). */
export async function readRenames(id: number, fromBlock: bigint): Promise<{ name: string; symbol: string; block: bigint }[]> {
  const logs = await client.getLogs({ address: ADDR.launcher, event: RENAMED, args: { id: BigInt(id) }, fromBlock, toBlock: "latest" });
  return logs.map((l) => ({ name: l.args.name!, symbol: l.args.symbol!, block: l.blockNumber! }));
}

/** Quote assets the admin currently allows migrations to (ETH is always allowed). */
export async function readAllowedQuotes(): Promise<Address[]> {
  const logs = await client.getLogs({ address: ADDR.launcher, event: QUOTE_ALLOWED, fromBlock: 0n, toBlock: "latest" });
  const state = new Map<string, boolean>();
  for (const l of logs) state.set(l.args.quote!.toLowerCase(), l.args.allowed!);
  return [ETH, ...[...state].filter(([, ok]) => ok).map(([a]) => a as Address)];
}

export type LaunchStats = { vol24: bigint; holders: number; trades24: number };

/** Board stats per launch id (24h volume in quote units, holders), or null without an indexer. */
export async function readStats(): Promise<Map<number, LaunchStats> | null> {
  const rows = await fromIndexer<{ id: number; vol24: string; holders: number; trades24: number }[]>("/stats");
  return rows ? new Map(rows.map((r) => [r.id, { vol24: BigInt(r.vol24), holders: r.holders, trades24: r.trades24 }])) : null;
}
