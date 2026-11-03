// Keeper for TideOrders: closes limit orders the price has moved through (locking the fill in for the maker)
// and runs DCA slices that are due. Both calls are permissionless, so the keeper holds no special rights: its
// wallet only pays gas. The key is generated on first start and kept in the indexer's database; fund the
// address shown at /health with a little ETH to switch it on.
import { createWalletClient, formatEther, http as rpcHttp, parseAbi } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ABI = parseAbi([
  "function limitCount() view returns (uint256)",
  "function dcaCount() view returns (uint256)",
  "function isFillable(uint256 id) view returns (bool)",
  "function isDue(uint256 id) view returns (bool)",
  "function fill(uint256 id)",
  "function execute(uint256 id) returns (uint256)",
  "function getLimit(uint256 id) view returns ((address owner, bool zeroForOne, bool open, int24 tickLower, int24 tickUpper, uint128 liquidity, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key))",
  "function getDca(uint256 id) view returns ((address owner, bool zeroForOne, uint32 slicesLeft, uint32 interval, uint64 nextAt, uint128 perSlice, uint160 limitSqrtPriceX96, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key))",
]);
const MIN_BALANCE = 200_000_000_000_000n; // 0.0002 ETH: below this the keeper stays idle

export async function startKeeper({ rpc, rpcUrl, db, getMeta, log, orders }) {
  if (!orders) return null;
  let key = await getMeta("keeper_key");
  if (!key) {
    key = generatePrivateKey();
    await db.query("insert into meta (k, v) values ('keeper_key', $1) on conflict (k) do nothing", [key]);
    key = await getMeta("keeper_key");
  }
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, transport: rpcHttp(rpcUrl) });
  const chainId = await rpc.getChainId();
  const done = { limit: new Set(), dca: new Set() }; // closed orders / finished plans never reopen
  const state = { address: account.address, balance: "0", fills: 0, slices: 0, lastRun: 0, active: false };
  log(`keeper ${account.address} watching TideOrders ${orders}`);

  async function send(functionName, id) {
    const { request } = await rpc.simulateContract({ account, address: orders, abi: ABI, functionName, args: [id] });
    const gas = ((await rpc.estimateContractGas({ account, address: orders, abi: ABI, functionName, args: [id] })) * 13n) / 10n;
    const hash = await wallet.writeContract({ ...request, gas, chain: { id: chainId } });
    const r = await rpc.waitForTransactionReceipt({ hash });
    return r.status === "success";
  }

  async function tick() {
    const bal = await rpc.getBalance({ address: account.address });
    state.balance = formatEther(bal);
    state.active = bal >= MIN_BALANCE;
    state.lastRun = Math.floor(Date.now() / 1000);
    if (!state.active) return;
    const [nl, nd] = await Promise.all([
      rpc.readContract({ address: orders, abi: ABI, functionName: "limitCount" }),
      rpc.readContract({ address: orders, abi: ABI, functionName: "dcaCount" }),
    ]);
    for (let i = 0n; i < nl; i++) {
      if (done.limit.has(i)) continue;
      const o = await rpc.readContract({ address: orders, abi: ABI, functionName: "getLimit", args: [i] });
      if (!o.open) {
        done.limit.add(i);
        continue;
      }
      if (!(await rpc.readContract({ address: orders, abi: ABI, functionName: "isFillable", args: [i] }))) continue;
      try {
        if (await send("fill", i)) {
          state.fills++;
          done.limit.add(i);
          log(`keeper filled limit #${i}`);
        }
      } catch (e) {
        log(`keeper fill #${i} skipped: ${e.shortMessage || e.message}`);
      }
    }
    for (let i = 0n; i < nd; i++) {
      if (done.dca.has(i)) continue;
      const d = await rpc.readContract({ address: orders, abi: ABI, functionName: "getDca", args: [i] });
      if (d.slicesLeft === 0) {
        done.dca.add(i);
        continue;
      }
      if (!(await rpc.readContract({ address: orders, abi: ABI, functionName: "isDue", args: [i] }))) continue;
      try {
        if (await send("execute", i)) {
          state.slices++;
          log(`keeper ran DCA #${i} (${d.slicesLeft - 1} slices left)`);
        }
      } catch {
        // Price outside the owner's limit: the slice simply waits for a later run.
      }
    }
  }

  (async function loop() {
    for (;;) {
      try {
        await tick();
      } catch (e) {
        log("keeper error:", e.shortMessage || e.message);
      }
      await new Promise((r) => setTimeout(r, 20_000));
    }
  })();
  return state;
}
