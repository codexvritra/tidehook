// Line-for-line ports of the on-chain fee logic, so every simulator on the site shows exactly
// what the contracts charge. Fees are in pips: 1_000_000 = 100%.

export const pct = (pips: number) => `${(pips / 10_000).toFixed(pips % 100 === 0 ? 2 : 3)}%`;

// ------------------------------------------------------------------ PatienceHook

export const PATIENCE = { baseFee: 10_000, minFee: 500, minAge: 30, rampDuration: 3600, maxAge: 86_400 };

/** PatienceHook.feeForAge. Returns null where the contract would revert. */
export function patienceFee(age: number, c = PATIENCE): number | null {
  if (age < c.minAge || age > c.maxAge) return null;
  const elapsed = age - c.minAge;
  if (elapsed >= c.rampDuration) return c.minFee;
  return c.baseFee - Math.floor(((c.baseFee - c.minFee) * elapsed) / c.rampDuration);
}

// ------------------------------------------------------------------ SpringHook

export const SPRING = { baseFee: 3000, minFee: 500, maxFee: 50_000, band: 50, stiffness: 20, window: 3600 };

/** SpringHook.quoteFee. `bounded` = the swap's price limit stops at the rest price. */
export function springFee(tick: number, rest: number, zeroForOne: boolean, bounded: boolean, c = SPRING): number {
  const stretch = tick - rest;
  const dist = Math.abs(stretch);
  if (dist <= c.band) return c.baseFee;
  const stretching = stretch < 0 === zeroForOne;
  if (!stretching) return bounded ? c.minFee : c.baseFee;
  return Math.min(c.baseFee + (dist - c.band) * c.stiffness, c.maxFee);
}

/** SpringHook._relax: time-weighted pull of the rest point toward the price that stood. */
export function relax(rest: number, tick: number, dt: number, c = SPRING): number {
  if (dt <= 0) return rest;
  const w = Math.min(dt, c.window);
  return rest + Math.trunc(((tick - rest) * w) / c.window);
}

// ------------------------------------------------------------------ SessionHook

export type Session = "Regular" | "Extended" | "Closed" | "Weekend";
export const SESSIONS: Session[] = ["Regular", "Extended", "Closed", "Weekend"];
export const SESSION_FEES: Record<Session, number> = { Regular: 500, Extended: 3000, Closed: 10_000, Weekend: 20_000 };
export const SCHEDULE = { preOpen: 8 * 3600, open: 13.5 * 3600, close: 20 * 3600, postClose: 24 * 3600 };

/** SessionHook.sessionAt, with the deployed default (EDT) schedule. */
export function sessionAt(ts: number, holidays: Set<number> = new Set(), s = SCHEDULE): Session {
  const day = Math.floor(ts / 86_400);
  const weekday = (day + 4) % 7;
  if (weekday === 0 || weekday === 6 || holidays.has(day)) return "Weekend";
  const t = ts % 86_400;
  if (t >= s.open && t < s.close) return "Regular";
  if (t >= s.preOpen && t < s.postClose) return "Extended";
  return "Closed";
}

// ------------------------------------------------------------------ CreatorBondHook

export type BondState = {
  isBelow: boolean;
  belowSince: number; // 0 = never breached
  aboveSince: number; // 0 while below
  slashed: boolean;
};

/** CreatorBondHook.afterSwap state transition. */
export function bondStep(b: BondState, below: boolean, now: number, grace: number): BondState {
  if (b.slashed) return b;
  if (below && !b.isBelow) {
    const belowSince = b.belowSince === 0 || now - b.aboveSince >= grace ? now : b.belowSince;
    return { ...b, isBelow: true, belowSince, aboveSince: 0 };
  }
  if (!below && b.isBelow) return { ...b, isBelow: false, aboveSince: now };
  return b;
}

export const canClaim = (b: BondState, now: number, grace: number) =>
  !b.slashed && !b.isBelow && now - b.aboveSince >= grace;
export const canSlash = (b: BondState, now: number, grace: number) =>
  !b.slashed && b.isBelow && now - b.belowSince >= grace;

// ------------------------------------------------------------------ v4 hook address bits

export const HOOK_FLAGS = [
  ["beforeInitialize", 13],
  ["afterInitialize", 12],
  ["beforeAddLiquidity", 11],
  ["afterAddLiquidity", 10],
  ["beforeRemoveLiquidity", 9],
  ["afterRemoveLiquidity", 8],
  ["beforeSwap", 7],
  ["afterSwap", 6],
  ["beforeDonate", 5],
  ["afterDonate", 4],
  ["beforeSwapReturnsDelta", 3],
  ["afterSwapReturnsDelta", 2],
  ["afterAddLiquidityReturnsDelta", 1],
  ["afterRemoveLiquidityReturnsDelta", 0],
] as const;

export function decodeHookFlags(address: string): { name: string; on: boolean }[] {
  const low = parseInt(address.slice(-4), 16) & 0x3fff;
  return HOOK_FLAGS.map(([name, bit]) => ({ name, on: ((low >> bit) & 1) === 1 }));
}
