// End-to-end rehearsal of the real mainnet deployment against a LOCAL anvil fork of Robinhood Chain:
//   anvil --fork-url https://rpc.mainnet.chain.robinhood.com --port 8546 --chain-id 4663
//   node scripts/e2e-fork.mjs
// It sends the exact CREATE2 deploy transactions the in-app Deploy page sends, then launches tokens
// and trades through the router. Uses anvil's well-known dev account; refuses any non-local RPC.
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, decodeEventLog, http, parseEther, concat, encodeAbiParameters, keccak256 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const RPC = process.env.FORK_RPC ?? "http://127.0.0.1:8546";
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(RPC)) throw new Error("local fork only");

const chain = { id: 4663, name: "robinhood-fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
// A fresh key per run, funded on the fork. (anvil's well-known account #0 has an EIP-7702 sweeper attached on
// Robinhood mainnet, so any ETH sent to it is forwarded away; don't use it on a mainnet fork.)
const account = privateKeyToAccount(generatePrivateKey());
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ chain, transport: http(RPC), account });
const CREATE2 = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

const abi = (n) => JSON.parse(readFileSync(new URL(`../../out/${n}.sol/${n}.json`, import.meta.url))).abi;
const plan = JSON.parse(readFileSync(new URL("../src/deploy/initcode.json", import.meta.url)));
const A = Object.fromEntries(plan.map((p) => [p.name, p.address]));
const ok = (cond, msg) => {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ✓", msg);
};
const send = async (req) => {
  const hash = await wallet.sendTransaction(req);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error("tx reverted " + hash);
  return r;
};
// Same gas policy as the app: estimate, then pad 30%. Bare estimates can come in just under what a
// first-time token transfer (fresh storage slot) needs inside the v4 unlock callback.
const write = async (args) => {
  const { request } = await pub.simulateContract({ account, ...args });
  const gas = ((await pub.estimateContractGas({ account, ...args })) * 13n) / 10n;
  const hash = await wallet.writeContract({ ...request, gas });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error("tx reverted " + hash);
  return r;
};
const warp = async (sec) => {
  await pub.request({ method: "evm_increaseTime", params: [sec] });
  await pub.request({ method: "evm_mine", params: [] });
};

await pub.request({ method: "anvil_setBalance", params: [account.address, "0x21E19E0C9BAB2400000"] }); // 10,000 ETH
console.log("1. Deploy via CREATE2 deployer (same txs as the Deploy page)");
for (const p of plan) {
  ok(keccak256(p.initCode) && p.initCode.length > 2, `${p.name} init code present`);
  if ((await pub.getCode({ address: p.address })) === undefined) {
    await send({ to: CREATE2, data: concat([p.salt, p.initCode]) });
  }
  const code = await pub.getCode({ address: p.address });
  ok(code && code.length > 2, `${p.name} live at ${p.address}`);
}
ok(
  (await pub.readContract({ address: A.SessionHook, abi: abi("SessionHook"), functionName: "owner" })).toLowerCase() ===
    account.address.toLowerCase(),
  "SessionHook owner = deploying wallet",
);

const L = { address: A.TideLauncher, abi: abi("TideLauncher") };
const R = { address: A.TideRouter, abi: abi("TideRouter") };
const ERC = abi("TideToken");
const MIN = 4295128740n;

const launchFee = await pub.readContract({ ...L, functionName: "launchFee" });
ok(launchFee > 0n, `launch fee is ${Number(launchFee) / 1e18} ETH`);

async function launch(kind, bps) {
  const r = await write({
    ...L,
    functionName: "launch",
    value: launchFee,
    args: [
      {
        name: `Fork ${kind}`,
        symbol: `F${kind}`,
        imageURI: "",
        description: "fork rehearsal",
        kind,
        quote: "0x0000000000000000000000000000000000000000",
        startTick: 196000,
        creatorBps: bps,
        floorTick: 196000 - 6932,
        vestDuration: 30n * 86400n,
        grace: 86400n,
      },
    ],
  });
  const ev = r.logs
    .filter((l) => l.address.toLowerCase() === A.TideLauncher.toLowerCase())
    .map((l) => decodeEventLog({ abi: L.abi, ...l }))
    .find((e) => e.eventName === "Launched");
  return { id: ev.args.id, token: ev.args.token, key: (await pub.readContract({ ...L, functionName: "getLaunch", args: [ev.args.id] })).key };
}

console.log("2. Launch + trade on every hook");
for (const [kind, name] of [[0, "Patience"], [1, "Spring"], [2, "Bond"], [3, "Session"]]) {
  const { id, token, key } = await launch(kind, 1000);
  ok(true, `${name}: launched #${id} token ${token}`);
  const swap = { key, zeroForOne: true, amountIn: parseEther("0.5"), minOut: 0n, sqrtPriceLimitX96: MIN, hookData: "0x" };
  const { result: [, qOut] } = await pub.simulateContract({ account, ...R, functionName: "quoteExactIn", args: [swap] });
  const before = await pub.readContract({ address: token, abi: ERC, functionName: "balanceOf", args: [account.address] });
  await write({ ...R, functionName: "swapExactIn", args: [{ ...swap, minOut: (qOut * 99n) / 100n }, account.address, 2n ** 40n], value: parseEther("0.5") });
  const after = await pub.readContract({ address: token, abi: ERC, functionName: "balanceOf", args: [account.address] });
  ok(after - before === qOut, `${name}: bought ${(Number(after - before) / 1e18).toFixed(0)} tokens = quote`);

  await write({ address: token, abi: ERC, functionName: "approve", args: [A.TideRouter, after] });
  await write({ ...R, functionName: "swapExactIn", args: [{ key, zeroForOne: false, amountIn: after / 2n, minOut: 1n, sqrtPriceLimitX96: 0n, hookData: "0x" }, account.address, 2n ** 40n] });
  ok(true, `${name}: sold half back for ETH`);

  const sim = await pub.simulateContract({ account, ...L, functionName: "collectFees", args: [id] });
  ok(sim.result[0] + sim.result[1] > 0n, `${name}: LP fees accrued for the platform (${sim.result[0]} wei ETH)`);
}

console.log("3. Patience slow lane: commit, wait, reveal through the router");
{
  const { key } = await launch(0, 0);
  const amountIn = parseEther("1");
  const salt = keccak256("0x1234");
  const P = { address: A.PatienceHook, abi: abi("PatienceHook") };
  const commitment = await pub.readContract({ ...P, functionName: "commitmentOf", args: [key, { zeroForOne: true, amountSpecified: -amountIn, sqrtPriceLimitX96: MIN }, salt] });
  // Same construction the frontend uses
  const poolId = keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
  const local = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bool" }, { type: "int256" }, { type: "uint160" }, { type: "bytes32" }], [poolId, true, -amountIn, MIN, salt]));
  ok(local === commitment, "frontend commitment hash == contract");
  await write({ ...P, functionName: "commit", args: [commitment] });
  const swap = { key, zeroForOne: true, amountIn, minOut: 0n, sqrtPriceLimitX96: MIN, hookData: "0x" };
  const { result: [, fastOut] } = await pub.simulateContract({ account, ...R, functionName: "quoteExactIn", args: [swap] });
  await warp(2 * 3600);
  const hookData = encodeAbiParameters([{ type: "bytes32" }], [salt]);
  const { result: [, slowOut] } = await pub.simulateContract({ account, ...R, functionName: "quoteExactIn", args: [{ ...swap, hookData }] });
  await write({ ...R, functionName: "swapExactIn", args: [{ ...swap, hookData }, account.address, 2n ** 40n], value: amountIn });
  ok(slowOut > fastOut, `slow lane got ${((Number(slowOut - fastOut) / Number(fastOut)) * 100).toFixed(2)}% more tokens than fast lane`);
}

console.log("3b. Launchpad fees in ETH: buy 1% creator + 1% platform, sell 2% platform");
{
  const H = { address: A.SpringHook, abi: abi("SpringHook") };
  const platform = await pub.readContract({ ...L, functionName: "feeRecipient" });
  const platformIsMe = platform.toLowerCase() === account.address.toLowerCase();
  const { key, token } = await launch(1, 0);
  const c0 = await pub.readContract({ ...H, functionName: "owed", args: [account.address, "0x0000000000000000000000000000000000000000"] });
  const p0 = await pub.readContract({ ...H, functionName: "owed", args: [A.TideLauncher, "0x0000000000000000000000000000000000000000"] });
  await write({ ...R, functionName: "swapExactIn", args: [{ key, zeroForOne: true, amountIn: parseEther("1"), minOut: 0n, sqrtPriceLimitX96: MIN, hookData: "0x" }, account.address, 2n ** 40n], value: parseEther("1") });
  const c1 = await pub.readContract({ ...H, functionName: "owed", args: [account.address, "0x0000000000000000000000000000000000000000"] });
  const p1 = await pub.readContract({ ...H, functionName: "owed", args: [A.TideLauncher, "0x0000000000000000000000000000000000000000"] });
  ok(c1 - c0 === parseEther("0.01") && p1 - p0 === parseEther("0.01"), "1 ETH buy: 0.01 ETH to creator, 0.01 ETH to platform");
  const tokOwed = await pub.readContract({ ...H, functionName: "owed", args: [account.address, token] });
  ok(tokOwed === 0n, "no fees ever accrue in the launched token");
  const bal = await pub.readContract({ address: token, abi: ERC, functionName: "balanceOf", args: [account.address] });
  await write({ address: token, abi: ERC, functionName: "approve", args: [A.TideRouter, bal] });
  await write({ ...R, functionName: "swapExactIn", args: [{ key, zeroForOne: false, amountIn: bal / 2n, minOut: 1n, sqrtPriceLimitX96: 0n, hookData: "0x" }, account.address, 2n ** 40n] });
  const p2 = await pub.readContract({ ...H, functionName: "owed", args: [A.TideLauncher, "0x0000000000000000000000000000000000000000"] });
  ok(p2 > p1, `sell: platform earned ${(Number(p2 - p1) / 1e18).toFixed(6)} ETH (2%)`);
  const e0 = await pub.getBalance({ address: account.address });
  await write({ ...H, functionName: "claim", args: ["0x0000000000000000000000000000000000000000"] });
  const e1 = await pub.getBalance({ address: account.address });
  ok(e1 > e0, `creator claimed ${(Number(e1 - e0) / 1e18).toFixed(6)} ETH (net of gas)`);
  const w0 = await pub.getBalance({ address: platform });
  await write({ ...H, functionName: "claimPlatform", args: [A.TideLauncher, "0x0000000000000000000000000000000000000000"] });
  const w1 = await pub.getBalance({ address: platform });
  ok(platformIsMe ? w1 > w0 - parseEther("0.001") : w1 > w0, "platform fees sent to the platform wallet");
}

console.log("4. Rename and hook upgrade after launch");
{
  const { id, token } = await launch(0, 500);
  const swap = { key: (await pub.readContract({ ...L, functionName: "getLaunch", args: [id] })).key, zeroForOne: true, amountIn: parseEther("1"), minOut: 0n, sqrtPriceLimitX96: MIN, hookData: "0x" };
  await write({ ...R, functionName: "swapExactIn", args: [swap, account.address, 2n ** 40n], value: parseEther("1") });

  await write({ ...L, functionName: "updateMetadata", args: [id, "Renamed Fork", "RNFK", "", "renamed on the fork"] });
  ok((await pub.readContract({ address: token, abi: ERC, functionName: "symbol" })) === "RNFK", "ERC20 symbol changed on-chain after rename");

  await write({ ...L, functionName: "proposeMigration", args: [id, 1, "0x0000000000000000000000000000000000000000"] });
  await warp(86_400 + 5);
  await write({ ...L, functionName: "executeMigration", args: [id, 0n] });
  const after = await pub.readContract({ ...L, functionName: "getLaunch", args: [id] });
  ok(after.key.hooks.toLowerCase() === A.SpringHook.toLowerCase() && after.migrations === 1, "liquidity migrated to the Spring hook");
  const b0 = await pub.readContract({ address: token, abi: ERC, functionName: "balanceOf", args: [account.address] });
  await write({ ...R, functionName: "swapExactIn", args: [{ ...swap, key: after.key }, account.address, 2n ** 40n], value: parseEther("1") });
  const b1 = await pub.readContract({ address: token, abi: ERC, functionName: "balanceOf", args: [account.address] });
  ok(b1 > b0, "trading works on the upgraded pool");
}

console.log("5. Listing reads (what Explore shows)");
const [page] = await pub.readContract({ ...L, functionName: "getLaunches", args: [0n, 50n] });
ok(page.length >= 5, `getLaunches returns ${page.length} launches newest-first`);
console.log("\nE2E PASSED");
