// Holder veto on a LOCAL mainnet fork (run e2e-fork.mjs first so v2 is deployed there):
// launch, two holders buy, the creator proposes a hook switch, a holder with > 10% vetoes, execution is refused;
// then the holder unlocks and the creator's next proposal goes through.
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseEther, decodeEventLog, maxUint256 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const RPC = process.env.FORK_RPC ?? "http://127.0.0.1:8546";
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(RPC)) throw new Error("local fork only");
const chain = { id: 4663, name: "fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const abi = (n) => JSON.parse(readFileSync(new URL(`../../out/${n}.sol/${n}.json`, import.meta.url))).abi;
const A = Object.fromEntries(JSON.parse(readFileSync(new URL("../src/deploy/initcode.json", import.meta.url))).map((p) => [p.name, p.address]));
const L = { address: A.TideLauncher, abi: abi("TideLauncher") };
const R = { address: A.TideRouter, abi: abi("TideRouter") };
const V = { address: await pub.readContract({ ...L, functionName: "veto" }), abi: abi("TideVeto") };
const ERC = abi("TideToken");
const MIN = 4295128740n;
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
const reverts = async (account, args) => {
  try {
    await pub.simulateContract({ account, ...args });
    return null;
  } catch (e) {
    return e.cause?.data?.errorName ?? e.shortMessage ?? "reverted";
  }
};
const warp = async (s) => {
  await pub.request({ method: "evm_increaseTime", params: [s] });
  await pub.request({ method: "evm_mine", params: [] });
};

console.log("1. Launch and two holders buy");
ok((await pub.readContract({ ...V, functionName: "launcher" })).toLowerCase() === A.TideLauncher.toLowerCase(), `veto ${V.address} belongs to the launcher`);
const fee = await pub.readContract({ ...L, functionName: "launchFee" });
const r = await send(creator, { ...L, functionName: "launch", value: fee, args: [{ name: "Veto Test", symbol: "VETO", imageURI: "", description: "", kind: 0, quote: Z, startTick: 196000, creatorBps: 0, floorTick: 0, vestDuration: 0n, grace: 0n }] });
const ev = r.logs.map((x) => { try { return decodeEventLog({ abi: L.abi, ...x }); } catch { return null; } }).find((e) => e?.eventName === "Launched");
const id = ev.args.id;
const token = ev.args.token;
const key = (await pub.readContract({ ...L, functionName: "getLaunch", args: [id] })).key;
const buy = (a, eth) => send(a, { ...R, functionName: "swapExactIn", value: parseEther(eth), args: [{ key, zeroForOne: true, amountIn: parseEther(eth), minOut: 0n, sqrtPriceLimitX96: MIN, hookData: "0x" }, a.address, 2n ** 40n] });
await buy(alice, "2");
await buy(bob, "0.1");
const bal = (a) => pub.readContract({ address: token, abi: ERC, functionName: "balanceOf", args: [a.address] });
const aliceBal = await bal(alice);
const bobBal = await bal(bob);
ok(aliceBal > 0n && bobBal > 0n, "Alice and Bob hold the coin");

console.log("2. Creator announces a hook switch; Bob alone can't stop it, Alice can");
await send(creator, { ...L, functionName: "proposeMigration", args: [id, 1, Z] });
for (const a of [alice, bob]) await send(a, { address: token, abi: ERC, functionName: "approve", args: [V.address, maxUint256] });
await send(bob, { ...V, functionName: "lock", args: [id, bobBal] });
let [locked, needed, blocked] = await pub.readContract({ ...V, functionName: "status", args: [id] });
ok(!blocked && locked === bobBal, `Bob's ${(Number(bobBal) / 1e24).toFixed(1)}M is under the ${(Number(needed) / 1e24).toFixed(1)}M needed`);
await send(alice, { ...V, functionName: "lock", args: [id, aliceBal] });
[locked, needed, blocked] = await pub.readContract({ ...V, functionName: "status", args: [id] });
ok(blocked, "with Alice's tokens the veto passes 10% of circulating supply");

console.log("3. After the 24h notice the creator can't execute");
await warp(86_400 + 10);
ok((await reverts(creator, { ...L, functionName: "executeMigration", args: [id, 0n] })) === "Vetoed", "executeMigration reverts with Vetoed");
ok((await reverts(alice, { ...V, functionName: "lock", args: [id, 1n] })) === "VotingClosed", "voting is closed after the notice");

console.log("4. Holders unlock; a new proposal starts a clean round and goes through");
await send(alice, { ...V, functionName: "unlock", args: [id] });
await send(bob, { ...V, functionName: "unlock", args: [id] });
ok((await bal(alice)) === aliceBal && (await bal(bob)) === bobBal, "every locked token came back");
await send(creator, { ...L, functionName: "cancelMigration", args: [id] });
await send(creator, { ...L, functionName: "proposeMigration", args: [id, 1, Z] });
ok((await pub.readContract({ ...L, functionName: "migrationRound", args: [id] })) === 2, "round 2");
await warp(86_400 + 10);
await send(creator, { ...L, functionName: "executeMigration", args: [id, 0n] });
const after = await pub.readContract({ ...L, functionName: "getLaunch", args: [id] });
ok(after.key.hooks.toLowerCase() === A.SpringHook.toLowerCase(), "un-vetoed proposal migrates to Spring");
console.log("\nHOLDER VETO PASSED");
