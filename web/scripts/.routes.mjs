import { createPublicClient, http, parseAbiItem, keccak256, encodeAbiParameters, numberToHex } from "viem";
const pub = createPublicClient({ transport: http("https://rpc.mainnet.chain.robinhood.com", { retryCount: 8, retryDelay: 2000 }) });
const PM = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const Z = "0x0000000000000000000000000000000000000000";
const INIT = parseAbiItem("event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)");
const EXT = parseAbiItem("function extsload(bytes32) view returns (bytes32)");
const S = { NVDA: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", SPY: "0x117cc2133c37b721f49de2a7a74833232b3b4c0c", GME: "0x1b0e319c6a659f002271b69db8a7df2f911c153e", TSLA: "0x322f0929c4625ed5bad873c95208d54e1c003b2d", PLTR: "0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a", GLD: "0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e", SPCX: "0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea", MU: "0xff080c8ce2e5feadaca0da81314ae59d232d4afd" };
const head = await pub.getBlockNumber();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const [sym, tok] of Object.entries(S)) {
  const pools = [];
  for (let to = head; to > 0n; to -= 10_000_000n) {
    const from = to >= 9_999_999n ? to - 9_999_999n : 0n;
    const l = await pub.getLogs({ address: PM, event: INIT, args: { currency0: Z, currency1: tok }, fromBlock: from, toBlock: to });
    pools.push(...l);
    await sleep(150);
    if (from === 0n) break;
  }
  const rows = [];
  for (const p of pools) {
    const base = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [p.args.id, 6n])));
    const v = await pub.readContract({ address: PM, abi: [EXT], functionName: "extsload", args: [numberToHex(base + 3n, { size: 32 })] });
    rows.push({ fee: p.args.fee, ts: p.args.tickSpacing, hooks: p.args.hooks, liq: BigInt(v) & ((1n << 128n) - 1n) });
    await sleep(100);
  }
  rows.sort((a, b) => (b.liq > a.liq ? 1 : -1));
  const best = rows.find((r) => r.hooks === Z);
  console.log(sym, "pools:", rows.length, "| best no-hook:", best ? `fee=${best.fee} ts=${best.ts} liq=${best.liq}` : "none", "| best any:", rows[0] ? `fee=${rows[0].fee} ts=${rows[0].ts} hooks=${rows[0].hooks.slice(0, 10)} liq=${rows[0].liq}` : "none");
}
