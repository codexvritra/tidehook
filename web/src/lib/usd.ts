// Dollar values for display, priced on-chain: ETH from the deepest ETH/USDG Uniswap v4 pool (USDG is a
// 1:1 USD stablecoin), stocks through their ETH/<stock> route pool. Contracts never read this.
import { useEffect, useState } from "react";
import { ETH } from "./chain";
import { poolIdOf, sqrtPriceOf } from "./pool";
import { PAIR_ASSETS } from "./stocks";

const USDG = PAIR_ASSETS.find((a) => a.symbol === "USDG")!;
const TTL = 60_000;
let cache: { at: number; prices: Map<string, number> } | null = null;
let inflight: Promise<Map<string, number>> | null = null;

/** Units of `decimals`-token per 1 ETH, from an ETH/<token> pool's spot price (ETH is always currency0). */
async function perEth(route: NonNullable<(typeof PAIR_ASSETS)[number]["route"]>, decimals: number): Promise<number> {
  const sqrt = await sqrtPriceOf(poolIdOf(route));
  return (Number(sqrt) / 2 ** 96) ** 2 * 10 ** (18 - decimals);
}

async function load(): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  const ethUsd = await perEth(USDG.route!, USDG.decimals);
  if (!(ethUsd > 0)) return prices;
  prices.set(ETH, ethUsd);
  await Promise.all(
    PAIR_ASSETS.map(async (a) => {
      if (a.symbol === "USDG") return prices.set(a.address.toLowerCase(), 1);
      if (!a.route) return;
      const n = await perEth(a.route, a.decimals).catch(() => 0);
      if (n > 0) prices.set(a.address.toLowerCase(), ethUsd / n);
    }),
  );
  return prices;
}

export function fetchUsdPrices(): Promise<Map<string, number>> {
  if (cache && Date.now() - cache.at < TTL) return Promise.resolve(cache.prices);
  inflight ??= load()
    .then((prices) => {
      if (prices.size) cache = { at: Date.now(), prices };
      return prices;
    })
    .catch(() => cache?.prices ?? new Map<string, number>())
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** USD per 1 unit of each known quote asset (lowercase address); refreshed every minute. */
export function useUsdPrices(): Map<string, number> {
  const [prices, setPrices] = useState<Map<string, number>>(() => cache?.prices ?? new Map());
  useEffect(() => {
    let live = true;
    const run = () => fetchUsdPrices().then((p) => live && p.size && setPrices(p));
    run();
    const id = setInterval(run, TTL);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);
  return prices;
}

/** "$1.24M", "$12.3K", "$950", "$0.42". */
export function fmtUsd(v: number): string {
  if (!isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `$${(v / 1e3).toFixed(1)}K`;
  if (a >= 100) return `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  return `$${v.toFixed(2)}`;
}

