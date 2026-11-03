import { fmtNum } from "../lib/price";
import { fmtUsd } from "../lib/usd";

/** A quote-asset amount shown in dollars when an on-chain USD price exists, else in the asset itself. */
export function Money({ amount, quote, symbol, prices }: { amount: number; quote?: string; symbol?: string; prices: Map<string, number> }) {
  const p = quote ? prices.get(quote.toLowerCase()) : undefined;
  if (!isFinite(amount)) return <span className="dim">—</span>;
  if (p) return <span title={`${fmtNum(amount)} ${symbol ?? ""}`}>{fmtUsd(amount * p)}</span>;
  return (
    <>
      {fmtNum(amount)} <span className="dim">{symbol}</span>
    </>
  );
}
