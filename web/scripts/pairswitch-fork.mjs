// Real pair switch ETH -> NVDA plus rename, against a LOCAL anvil fork of Robinhood Chain (after e2e-fork.mjs
// has deployed the stack). Converts the pool's ETH through the real ETH/NVDA Uniswap v4 pool on mainnet.
//   anvil --fork-url https://rpc.mainnet.chain.robinhood.com --port 8546 --chain-id 4663
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseEther, formatEther, decodeEventLog } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const RPC = process.env.FORK_RPC ?? "http://127.0.0.1:8546";
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(RPC)) throw new Error("local fork only");
const chain = { id: 4663, name: "fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const abi = (n) => JSON.parse(readFileSync(new URL(`../../out/${n}.sol/${n}.json`, import.meta.url))).abi;
const A = Object.fromEntries(JSON.parse(readFileSync(new URL("../src/deploy/initcode.json", import.meta.url))).map((p) => [p.name, p.address]));
const L = { address: A.TideLauncher, abi: abi("TideLauncher") };
const R = { address: A.TideRouter, abi: abi("TideRouter") };
const HOOK = abi("PatienceHook");
const ERC = abi("TideToken");
const Z = "0x0000000000000000000000000000000000000000";
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
const ROUTE = { currency0: Z, currency1: NVDA, fee: 500, tickSpacing: 10, hooks: Z }; // deepest ETH/NVDA v4 pool
const MIN = 4295128740n;
const MAX = 1461446703485210103287273052203988822378723970341n;
const ok = (c, m) => {
  if (!c) throw new Error("FAIL: " + m);
  console.log("  ✓", m);
};
const me = privateKeyToAccount(generatePrivateKey());
await pub.request({ method: "anvil_setBalance", params: [me.address, "0x56BC75E2D63100000"] });
async function send(account, args) {
  const w = createWalletClient({ chain, transport: http(RPC), account });
  const gas = ((await pub.estimateContractGas({ account, ...args })) * 13n) / 10n;
  const h = await w.writeContract({ ...args, account, gas, chain });
  const r = await pub.waitForTransactionReceipt({ hash: h });
  if (r.status !== "success") throw new Error("reverted " + h);
  return r;
}
async function warp(s) {
  await pub.request({ method: "evm_increaseTime", params: [s] });
  await pub.request({ method: "evm_mine", params: [] });
}
const bal = (t, a) => pub.readContract({ address: t, abi: ERC, functionName: "balanceOf", args: [a] });

console.log("1. Admin lists NVDA and its real v4 route pool");
const admin = await pub.readContract({ ...L, functionName: "admin" });
await pub.request({ method: "anvil_impersonateAccount", params: [admin] });
await pub.request({ method: "anvil_setBalance", params: [admin, "0x8AC7230489E80000"] });
const adminAcct = { address: admin, type: "json-rpc" };
await send(adminAcct, { ...L, functionName: "setQuoteAllowed", args: [NVDA, true] });
await send(adminAcct, { ...L, functionName: "setRoute", args: [ROUTE] });
ok(await pub.readContract({ ...L, functionName: "quoteAllowed", args: [NVDA] }), "NVDA allowed as a pair");

console.log("2. Launch on ETH and buy");
const fee = await pub.readContract({ ...L, functionName: "launchFee" });
const r = await send(me, {
  ...L,
  functionName: "launch",
  value: fee,
  args: [{ name: "Pair Test", symbol: "PAIR", imageURI: "", description: "", kind: 1, quote: Z, startTick: 196000, creatorBps: 0, floorTick: 0, vestDuration: 0n, grace: 0n }],
});
const ev = r.logs
  .filter((x) => x.address.toLowerCase() === A.TideLauncher.toLowerCase())
  .map((x) => {
    try {
      return decodeEventLog({ abi: L.abi, ...x });
    } catch {
      return null;
    }
  })
  .find((e) => e?.eventName === "Launched");
const id = ev.args.id;
const token = ev.args.token;
let l = await pub.readContract({ ...L, functionName: "getLaunch", args: [id] });
await send(me, { ...R, functionName: "swapExactIn", value: parseEther("2"), args: [{ key: l.key, zeroForOne: true, amountIn: parseEther("2"), minOut: 0n, sqrtPriceLimitX96: MIN, hookData: "0x" }, me.address, 2n ** 40n] });
ok((await bal(token, me.address)) > 0n, "bought PAIR for 2 ETH");

console.log("3. Rename after launch");
await send(me, { ...L, functionName: "updateMetadata", args: [id, "Pair Test Renamed", "PAIR2", "", "now with a new name"] });
ok((await pub.readContract({ address: token, abi: ERC, functionName: "name" })) === "Pair Test Renamed", "ERC20 name() changed on-chain");
ok((await pub.readContract({ address: token, abi: ERC, functionName: "symbol" })) === "PAIR2", "ERC20 symbol() changed on-chain");
let blocked = false;
try {
  await pub.simulateContract({ account: me, ...L, functionName: "updateMetadata", args: [id, "Again", "AGN", "", ""] });
} catch {
  blocked = true;
}
ok(blocked, "a second rename inside 24h is refused");

console.log("4. Switch pair ETH -> NVDA (announce, wait 24h, execute)");
const poolEthBefore = await pub.getBalance({ address: "0x8366a39CC670B4001A1121B8F6A443A643e40951" });
await send(me, { ...L, functionName: "proposeMigration", args: [id, 1, NVDA] });
let early = false;
try {
  await pub.simulateContract({ account: me, ...L, functionName: "executeMigration", args: [id, 0n] });
} catch {
  early = true;
}
ok(early, "cannot execute before the 24h notice is over");
await warp(86_400 + 10);
await send(me, { ...L, functionName: "executeMigration", args: [id, 0n] });
l = await pub.readContract({ ...L, functionName: "getLaunch", args: [id] });
const quoteNow = l.tokenIsCurrency0 ? l.key.currency1 : l.key.currency0;
ok(quoteNow.toLowerCase() === NVDA, "the coin is now paired with NVDA");
ok(l.migrations === 1, "migration recorded on-chain");
ok((await bal(token, A.TideLauncher)) === 0n, "launcher kept no tokens");
void poolEthBefore;

console.log("5. Trade the coin in NVDA");
await send(me, { ...R, functionName: "swapExactIn", value: parseEther("0.5"), args: [{ key: ROUTE, zeroForOne: true, amountIn: parseEther("0.5"), minOut: 0n, sqrtPriceLimitX96: MIN, hookData: "0x" }, me.address, 2n ** 40n] });
const nv = await bal(NVDA, me.address);
ok(nv > 0n, `got ${formatEther(nv)} NVDA from the real ETH/NVDA pool`);
await send(me, { address: NVDA, abi: ERC, functionName: "approve", args: [A.TideRouter, nv] });
const nvdaIs0 = !l.tokenIsCurrency0;
const t0 = await bal(token, me.address);
await send(me, { ...R, functionName: "swapExactIn", args: [{ key: l.key, zeroForOne: nvdaIs0, amountIn: nv / 2n, minOut: 0n, sqrtPriceLimitX96: nvdaIs0 ? MIN : MAX, hookData: "0x" }, me.address, 2n ** 40n] });
const t1 = await bal(token, me.address);
ok(t1 > t0, "bought PAIR2 with NVDA");
await send(me, { address: token, abi: ERC, functionName: "approve", args: [A.TideRouter, t1] });
const n0 = await bal(NVDA, me.address);
await send(me, { ...R, functionName: "swapExactIn", args: [{ key: l.key, zeroForOne: !nvdaIs0, amountIn: t1 / 4n, minOut: 1n, sqrtPriceLimitX96: nvdaIs0 ? MAX : MIN, hookData: "0x" }, me.address, 2n ** 40n] });
const n1 = await bal(NVDA, me.address);
ok(n1 > n0, `sold PAIR2 back for ${formatEther(n1 - n0)} NVDA`);
const owed = await pub.readContract({ address: l.key.hooks, abi: HOOK, functionName: "owed", args: [me.address, NVDA] });
ok(owed > 0n, `creator earned ${formatEther(owed)} NVDA (1% of the NVDA buy)`);
console.log("\nPAIR SWITCH + RENAME PASSED");
