import { useEffect, useState } from "react";

// ETH/USD for display only (launch fee in dollars, fee previews). Contracts never read this.
let cached: { usd: number; at: number } | null = null;
let inflight: Promise<number | null> | null = null;

export async function fetchEthUsd(): Promise<number | null> {
  if (cached && Date.now() - cached.at < 60_000) return cached.usd;
  inflight ??= fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd")
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      const usd = Number(j?.ethereum?.usd);
      if (!isFinite(usd) || usd <= 0) return null;
      cached = { usd, at: Date.now() };
      return usd;
    })
    .catch(() => null)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function useEthUsd(): number | null {
  const [usd, setUsd] = useState<number | null>(cached?.usd ?? null);
  useEffect(() => {
    let live = true;
    const run = () => fetchEthUsd().then((v) => live && v && setUsd(v));
    run();
    const id = setInterval(run, 60_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);
  return usd;
}

export const usd = (eth: number, price: number | null) =>
  price ? `$${(eth * price).toLocaleString(undefined, { maximumFractionDigits: eth * price < 10 ? 2 : 0 })}` : "";
