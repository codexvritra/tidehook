// Limit orders + DCA on a LOCAL mainnet fork (run e2e-fork.mjs first so TideOrders is deployed there).
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseEther, formatEther, decodeEventLog, maxUint256 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const RPC = process.env.FORK_RPC ?? "http://127.0.0.1:8546";
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(RPC)) throw new Error("local fork only");
const chain = { id: 4663, name: "fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const abi = (n) => JSON.parse(readFileSync(new URL(`../../out/${n}.sol/${n}.json`, import.meta.url))).abi;
const A = Object.fromEntries(JSON.parse(readFileSync(new URL("../src/deploy/initcode.json", import.meta.url))).map((p) => [p.name, p.address]));
const L = { address: A.TideLauncher, abi: abi("TideLauncher") };
const R = { address: A.TideRouter, abi: abi("TideRouter") };
const O = { address: A.TideOrders, abi: abi("TideOrders") };
const ERC = abi("TideToken");
const MIN = 4295128740n;
const MAX = 1461446703485210103287273052203988822378723970341n;
const Z = "0x0000000000000000000000000000000000000000";
const ok = (c, m) => {
  if (!c) throw new Error("FAIL: " + m);
  console.log("  ✓", m);
};
const [creator, maker, taker, keeper] = [0, 1, 2, 3].map(() => privateKeyToAccount(generatePrivateKey()));
for (const a of [creator, maker, taker, keeper]) await pub.request({ method: "anvil_setBalance", params: [a.address, "0x56BC75E2D63100000"] });
async function send(account, args) {
  const w = createWalletClient({ chain, transport: http(RPC), account });
  const gas = ((await pub.estimateContractGas({ account, ...args })) * 13n) / 10n;
  const h = await w.writeContract({ ...args, account, gas, chain });
  const r = await pub.waitForTransactionReceipt({ hash: h });
  if (r.status !== "success") throw new Error("reverted " + h);
  return r;
}
const warp = async (s) => {
  await pub.request({ method: "evm_increaseTime", params: [s] });
  await pub.request({ method: "evm_mine", params: [] });
};
const ev = (r, a, name) => r.logs.map((x) => { try { return decodeEventLog({ abi: a, ...x }); } catch { return null; } }).find((e) => e?.eventName === name);
const tickOf = async (key) => {
  const PM = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
  const { keccak256, encodeAbiParameters } = await import("viem");
  const id = keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
  const slot = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [id, 6n]));
  const w = BigInt(await pub.getStorageAt({ address: PM, slot }));
  let t = Number((w >> 160n) & 0xffffffn);
  if (t >= 0x800000) t -= 0x1000000;
  return t;
};

ok(((await pub.getCode({ address: O.address })) ?? "0x").length > 2, `TideOrders live at ${O.address}`);
const fee = await pub.readContract({ ...L, functionName: "launchFee" });
const lr = await send(creator, { ...L, functionName: "launch", value: fee, args: [{ name: "Orders Test", symbol: "ORD", imageURI: "", description: "", kind: 1, quote: Z, startTick: 196000, creatorBps: 0, floorTick: 0, vestDuration: 0n, grace: 0n }] });
const token = ev(lr, L.abi, "Launched").args.token;
const key = (await pub.readContract({ ...L, functionName: "getLaunch", args: [ev(lr, L.abi, "Launched").args.id] })).key;
const buy = (a, eth) => send(a, { ...R, functionName: "swapExactIn", value: parseEther(eth), args: [{ key, zeroForOne: true, amountIn: parseEther(eth), minOut: 0n, sqrtPriceLimitX96: MIN, hookData: "0x" }, a.address, 2n ** 40n] });
const sell = async (a, amt) => {
  await send(a, { address: token, abi: ERC, functionName: "approve", args: [A.TideRouter, amt] });
  return send(a, { ...R, functionName: "swapExactIn", args: [{ key, zeroForOne: false, amountIn: amt, minOut: 1n, sqrtPriceLimitX96: MAX, hookData: "0x" }, a.address, 2n ** 40n] });
};
const bal = (t, a) => (t === Z ? pub.getBalance({ address: a.address }) : pub.readContract({ address: t, abi: ERC, functionName: "balanceOf", args: [a.address] }));

console.log("1. Take-profit limit sell (token is currency1: range below the tick)");
await buy(maker, "1");
const bag = await bal(token, maker);
let t = await tickOf(key);
const s = key.tickSpacing;
const lower = Math.floor(t / s) * s - 3 * s;
await send(maker, { address: token, abi: ERC, functionName: "approve", args: [O.address, maxUint256] });
const pr = await send(maker, { ...O, functionName: "placeLimit", args: [key, false, lower, bag / 2n] });
const sellId = ev(pr, O.abi, "LimitPlaced").args.id;
ok(!(await pub.readContract({ ...O, functionName: "isFillable", args: [sellId] })), "order resting above the price");
await buy(taker, "15");
ok(await pub.readContract({ ...O, functionName: "isFillable", args: [sellId] }), "buyers pushed the price through the order");
const eth0 = await bal(Z, maker);
await send(keeper, { ...O, functionName: "fill", args: [sellId] }); // a third party locks the fill in
const ethGot = (await bal(Z, maker)) - eth0;
ok(ethGot > 0n, `maker received ${formatEther(ethGot)} ETH for half the bag`);

console.log("2. Buy-the-dip limit buy (ETH order above the tick)");
t = await tickOf(key);
const lowerB = Math.ceil((t + 1) / s) * s + 3 * s;
const br = await send(maker, { ...O, functionName: "placeLimit", value: parseEther("0.5"), args: [key, true, lowerB, parseEther("0.5")] });
const buyId = ev(br, O.abi, "LimitPlaced").args.id;
const tok0 = await bal(token, maker);
await sell(taker, await bal(token, taker));
ok(await pub.readContract({ ...O, functionName: "isFillable", args: [buyId] }), "sellers pushed the price down through it");
await send(keeper, { ...O, functionName: "fill", args: [buyId] });
ok((await bal(token, maker)) > tok0, "maker bought the dip");

console.log("3. DCA buy: 3 slices, hourly, worst price 50% past spot");
const dr = await send(maker, { ...O, functionName: "createDca", value: parseEther("0.3"), args: [key, true, parseEther("0.1"), 3, 3600, 0n] });
const did = ev(dr, O.abi, "DcaCreated").args.id;
const t1 = await bal(token, maker);
await send(keeper, { ...O, functionName: "execute", args: [did] });
ok((await bal(token, maker)) > t1, "slice 1 executed by a keeper, tokens to the maker");
let early = false;
try {
  await pub.simulateContract({ account: keeper, ...O, functionName: "execute", args: [did] });
} catch {
  early = true;
}
ok(early, "slice 2 not due yet");
await warp(3600 + 5);
await send(keeper, { ...O, functionName: "execute", args: [did] });
const e1 = await bal(Z, maker);
await send(maker, { ...O, functionName: "cancelDca", args: [did] });
const refund = (await bal(Z, maker)) - e1;
ok(refund > parseEther("0.0999") && refund <= parseEther("0.1"), `cancel refunded the last slice (${formatEther(refund)} ETH minus gas)`);
ok((await pub.getBalance({ address: O.address })) === 0n, "TideOrders holds nothing afterwards");
console.log("\nLIMIT ORDERS + DCA PASSED");
