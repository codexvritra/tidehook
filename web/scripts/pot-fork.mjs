// Tide Pot on a LOCAL mainnet fork (run e2e-fork.mjs first so launcher v3 + TidePotHook are deployed there).
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseEther, formatEther, decodeEventLog, encodeAbiParameters, keccak256 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const RPC = process.env.FORK_RPC ?? "http://127.0.0.1:8546";
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(RPC)) throw new Error("local fork only");
const chain = { id: 4663, name: "fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const abi = (n) => JSON.parse(readFileSync(new URL(`../../out/${n}.sol/${n}.json`, import.meta.url))).abi;
const A = Object.fromEntries(JSON.parse(readFileSync(new URL("../src/deploy/initcode.json", import.meta.url))).map((p) => [p.name, p.address]));
const L = { address: A.TideLauncher, abi: abi("TideLauncher") };
const R = { address: A.TideRouter, abi: abi("TideRouter") };
const P = { address: A.TidePotHook, abi: abi("TidePotHook") };
const Z = "0x0000000000000000000000000000000000000000";
const ok = (c, m) => {
  if (!c) throw new Error("FAIL: " + m);
  console.log("  ✓", m);
};
const [creator, alice, bob] = [0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey()));
for (const a of [creator, alice, bob]) await pub.request({ method: "anvil_setBalance", params: [a.address, "0x56BC75E2D63100000"] });
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

ok((await pub.readContract({ ...L, functionName: "potHook" })).toLowerCase() === A.TidePotHook.toLowerCase(), `launcher v3 knows TidePotHook ${A.TidePotHook}`);
const fee = await pub.readContract({ ...L, functionName: "launchFee" });
const r = await send(creator, { ...L, functionName: "launch", value: fee, args: [{ name: "Pot Test", symbol: "POT", imageURI: "", description: "", kind: 4, quote: Z, startTick: 196000, creatorBps: 0, floorTick: 0, vestDuration: 0n, grace: 0n }] });
const ev = r.logs.map((x) => { try { return decodeEventLog({ abi: L.abi, ...x }); } catch { return null; } }).find((e) => e?.eventName === "Launched");
const key = (await pub.readContract({ ...L, functionName: "getLaunch", args: [ev.args.id] })).key;
const poolId = keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
ok(key.hooks.toLowerCase() === A.TidePotHook.toLowerCase() && key.fee === 0, "Pot launch uses TidePotHook with no LP fee");
const buy = (a, eth) =>
  send(a, { ...R, functionName: "swapExactIn", value: parseEther(eth), args: [{ key, zeroForOne: true, amountIn: parseEther(eth), minOut: 0n, sqrtPriceLimitX96: 4295128740n, hookData: encodeAbiParameters([{ type: "address" }], [a.address]) }, a.address, 2n ** 40n] });
const potOf = () => pub.readContract({ ...P, functionName: "potOf", args: [poolId] });

await buy(alice, "1");
let [amount, leader] = await potOf();
ok(amount === parseEther("0.01") && leader === alice.address, "Alice's 1 ETH buy: 0.01 ETH in the pot, Alice leads");
ok((await pub.readContract({ ...P, functionName: "owed", args: [creator.address, Z] })) === 0n, "creator gets nothing on a Pot coin");
await warp(1800);
await buy(bob, "2");
[amount, leader] = await potOf();
ok(amount === parseEther("0.03") && leader === bob.address, "Bob buys 2 ETH 30 min later: pot 0.03 ETH, Bob leads");
await warp(3601);
await send(alice, { ...P, functionName: "settle", args: [key] });
const prize = await pub.readContract({ ...P, functionName: "owed", args: [bob.address, Z] });
ok(prize === parseEther("0.024"), `Bob wins 80%: ${formatEther(prize)} ETH`);
const b0 = await pub.getBalance({ address: bob.address });
await send(bob, { ...P, functionName: "claim", args: [Z] });
const got = (await pub.getBalance({ address: bob.address })) - b0;
ok(got > parseEther("0.0239"), `Bob claimed ${formatEther(got)} ETH (net of gas)`);
[amount] = await potOf();
ok(amount === parseEther("0.006"), "20% (0.006 ETH) rolls into round 2");
console.log("\nTIDE POT PASSED");
