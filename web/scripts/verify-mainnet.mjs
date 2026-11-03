// Read-only post-deploy check of the live stack on Robinhood Chain mainnet. Sends no transactions.
//   node scripts/verify-mainnet.mjs [expectedAdmin]
import { readFileSync } from "node:fs";
import { createPublicClient, http, getContractAddress, keccak256 } from "viem";

const pub = createPublicClient({ transport: http("https://rpc.mainnet.chain.robinhood.com", { retryCount: 5, retryDelay: 1500 }) });
const PM = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const CREATE2 = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const expectedAdmin = process.argv[2]?.toLowerCase();
const plan = JSON.parse(readFileSync(new URL("../src/deploy/initcode.json", import.meta.url)));
const A = Object.fromEntries(plan.map((p) => [p.name, p.address]));
const FILE = { TideTokenFactory: "TideToken" };
const abi = (n) => JSON.parse(readFileSync(new URL(`../../out/${FILE[n] ?? n}.sol/${n}.json`, import.meta.url))).abi;
let fails = 0;
const ok = (c, m) => {
  console.log(c ? "  ✓" : "  ✗", m);
  if (!c) fails++;
};
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const read = (name, address, functionName, args = []) => pub.readContract({ address, abi: abi(name), functionName, args });

console.log("1. Code at every address came from exactly the tested init code");
for (const p of plan) {
  // A CREATE2 address commits to (deployer, salt, keccak256(initCode)): code there proves these exact bytes.
  const predicted = getContractAddress({ opcode: "CREATE2", from: CREATE2, salt: p.salt, bytecode: p.initCode });
  const code = await pub.getCode({ address: p.address });
  ok(eq(predicted, p.address) && code && code.length > 2, `${p.name.padEnd(16)} ${p.address} (${(code.length - 2) / 2} bytes, initcode ${keccak256(p.initCode).slice(0, 10)}…)`);
}

console.log("2. Wiring");
ok(eq(await read("PatienceHook", A.PatienceHook, "poolManager"), PM), "PatienceHook → PoolManager");
ok(eq(await read("SpringHook", A.SpringHook, "poolManager"), PM), "SpringHook → PoolManager");
ok(eq(await read("CreatorBondHook", A.CreatorBondHook, "poolManager"), PM), "CreatorBondHook → PoolManager");
ok(eq(await read("SessionHook", A.SessionHook, "poolManager"), PM), "SessionHook → PoolManager");
ok(eq(await read("TideLauncher", A.TideLauncher, "poolManager"), PM), "TideLauncher → PoolManager");
ok(eq(await read("TideLauncher", A.TideLauncher, "patienceHook"), A.PatienceHook), "launcher knows PatienceHook");
ok(eq(await read("TideLauncher", A.TideLauncher, "springHook"), A.SpringHook), "launcher knows SpringHook");
ok(eq(await read("TideLauncher", A.TideLauncher, "bondHook"), A.CreatorBondHook), "launcher knows CreatorBondHook");
ok(eq(await read("TideLauncher", A.TideLauncher, "sessionHook"), A.SessionHook), "launcher knows SessionHook");
ok(eq(await read("TideLauncher", A.TideLauncher, "tokenFactory"), A.TideTokenFactory), "launcher → TokenFactory");
ok(eq(await read("TideLauncher", A.TideLauncher, "migrator"), A.TideMigrator), "launcher → Migrator");
{
  // The factory is permissionless, but whoever calls it becomes that token's only renamer, so tokens made by
  // anyone else can never be renamed by (or listed as) a launch. Simulate a call as a stranger to confirm.
  const stranger = "0x000000000000000000000000000000000000bEEF";
  const { result: tok } = await pub.simulateContract({ account: stranger, address: A.TideTokenFactory, abi: abi("TideTokenFactory"), functionName: "create", args: ["x", "x", 1n, stranger] });
  const code = await pub.getCode({ address: A.TideTokenFactory });
  ok(!!tok && code.length > 2, "TokenFactory live (tokens it makes for others are not launcher tokens)");
  ok((await read("TideLauncher", A.TideLauncher, "launchIdPlusOne", [tok])) === 0n, "a stranger's factory token is not listed as a launch");
}
ok(eq(await read("TideRouter", A.TideRouter, "poolManager"), PM), "TideRouter → PoolManager");
{
  const veto = await read("TideLauncher", A.TideLauncher, "veto");
  ok(eq(await read("TideVeto", veto, "launcher"), A.TideLauncher) && eq(await read("TideVeto", veto, "poolManager"), PM), `holder veto ${veto} → launcher + PoolManager`);
  ok(Number(await read("TideVeto", veto, "VETO_BPS")) === 1000, "veto threshold 10% of circulating supply");
}

console.log("3. Roles and settings");
const admin = await read("TideLauncher", A.TideLauncher, "admin");
const feeRecipient = await read("TideLauncher", A.TideLauncher, "feeRecipient");
const launchFee = await read("TideLauncher", A.TideLauncher, "launchFee");
const sessionOwner = await read("SessionHook", A.SessionHook, "owner");
console.log(`     admin ${admin} · platform wallet ${feeRecipient} · launch fee ${Number(launchFee) / 1e18} ETH · session owner ${sessionOwner}`);
if (expectedAdmin) {
  ok(eq(admin, expectedAdmin), "admin is the deploying wallet");
  ok(eq(feeRecipient, expectedAdmin), "platform wallet is the deploying wallet");
  ok(eq(sessionOwner, expectedAdmin), "SessionHook owner is the deploying wallet");
}
ok(eq(await read("TideLauncher", A.TideLauncher, "pendingAdmin"), "0x0000000000000000000000000000000000000000"), "no admin handover pending");
ok(eq(await read("TideLauncher", A.TideLauncher, "pendingFeeRecipient"), "0x0000000000000000000000000000000000000000"), "no platform-wallet change pending");
ok(await read("TideLauncher", A.TideLauncher, "quoteAllowed", ["0x0000000000000000000000000000000000000000"]), "ETH is an allowed pair");
ok((await read("TideLauncher", A.TideLauncher, "launchCount")) >= 0n, `launches so far: ${await read("TideLauncher", A.TideLauncher, "launchCount")}`);
ok(Number(await read("PatienceHook", A.PatienceHook, "BUY_CREATOR_BPS")) === 100, "buy tax 1% to creator");
ok(Number(await read("PatienceHook", A.PatienceHook, "BUY_PLATFORM_BPS")) === 100, "buy tax 1% to platform");
ok(Number(await read("PatienceHook", A.PatienceHook, "SELL_PLATFORM_BPS")) === 200, "sell tax 2% to platform");

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nMAINNET DEPLOYMENT VERIFIED");
process.exit(fails ? 1 : 0);
