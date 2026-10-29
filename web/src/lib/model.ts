// Uniswap v4 hook permission bits, read from the last 14 bits of a hook address.


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
