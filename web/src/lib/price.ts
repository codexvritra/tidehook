// Price math for tidehook launches. Every launch has 1B tokens with 18 decimals.
// Launcher price params are ticks "as if the quote were currency0 and the token currency1",
// i.e. tick = log1.0001(raw tokens per raw quote unit). The contract flips them when the token sorts first.

export const SUPPLY = 1_000_000_000;
export const TICK_SPACING = 200;
export const MIN_SQRT = 4295128740n; // TickMath.MIN_SQRT_PRICE + 1
export const MAX_SQRT = 1461446703485210103287273052203988822378723970341n; // TickMath.MAX_SQRT_PRICE - 1
const LN_BASE = Math.log(1.0001);

/** Quote units per 1 token, from a pool's sqrtPriceX96. */
export function tokenPrice(sqrtPriceX96: bigint, tokenIsCurrency0: boolean, quoteDecimals: number): number {
  const s = Number(sqrtPriceX96) / 2 ** 96;
  const raw1per0 = s * s;
  const human = tokenIsCurrency0 ? raw1per0 : 1 / raw1per0;
  return human * 10 ** (18 - quoteDecimals);
}

export const marketCap = (price: number) => price * SUPPLY;

/** Launch tick (normalized orientation) for a starting market cap in quote units. */
export function startTickForMcap(mcap: number, quoteDecimals: number): number {
  const price = mcap / SUPPLY; // quote per token
  const rawTokensPerRawQuote = (1 / price) * 10 ** (18 - quoteDecimals);
  const t = Math.log(rawTokensPerRawQuote) / LN_BASE;
  return Math.round(t / TICK_SPACING) * TICK_SPACING;
}

/** Market cap implied by a normalized launch tick. */
export function mcapForStartTick(tick: number, quoteDecimals: number): number {
  const rawTokensPerRawQuote = 1.0001 ** tick;
  const price = 10 ** (18 - quoteDecimals) / rawTokensPerRawQuote;
  return price * SUPPLY;
}

/** Floor tick (normalized) at `multiple` × the launch price. */
export const floorTickFor = (startTick: number, multiple: number) => Math.round(startTick - Math.log(multiple) / LN_BASE);

/** Quote-per-token price at an actual pool tick. */
export function priceAtTick(tick: number, tokenIsCurrency0: boolean, quoteDecimals: number): number {
  const raw1per0 = 1.0001 ** tick;
  const human = tokenIsCurrency0 ? raw1per0 : 1 / raw1per0;
  return human * 10 ** (18 - quoteDecimals);
}

/** Buying the token spends the quote. */
export const buyIsZeroForOne = (tokenIsCurrency0: boolean) => !tokenIsCurrency0;
export const limitFor = (zeroForOne: boolean) => (zeroForOne ? MIN_SQRT : MAX_SQRT);

export function fmtNum(n: number, digits = 4): string {
  if (!isFinite(n)) return "—";
  if (n === 0) return "0";
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  if (a >= 1) return n.toFixed(Math.min(digits, 4));
  // small numbers: keep `digits` significant figures, compact zeros
  const s = n.toPrecision(digits);
  if (!s.includes("e")) return s;
  return Number(s).toFixed(Math.min(18, Math.ceil(-Math.log10(a)) + digits - 1));
}

/** Tiny prices for subscript-zero notation, DexScreener style: 0.00000000415 -> 0.0₈4150 (8 zeros after the point). */
export function priceParts(n: number): { plain: string } | { zeros: number; digits: string } {
  if (!isFinite(n) || n <= 0) return { plain: "—" };
  if (n >= 0.0001) return { plain: fmtNum(n, 4) };
  const zeros = Math.floor(-Math.log10(n));
  const digits = Math.round(n * 10 ** (zeros + 4)).toString().slice(0, 4);
  return { zeros, digits };
}

/** Plain-text price for tables and titles (e-notation for tiny values). */
export function fmtPrice(n: number): string {
  if (!isFinite(n) || n <= 0) return "—";
  return n >= 0.0001 ? fmtNum(n, 4) : n.toExponential(3);
}
