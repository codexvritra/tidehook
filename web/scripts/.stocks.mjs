import { createPublicClient, http, erc20Abi } from "viem";
const pub = createPublicClient({ transport: http("https://rpc.mainnet.chain.robinhood.com", { retryCount: 6, retryDelay: 1500 }) });
const F = "0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046";
console.log("factory code bytes:", ((await pub.getCode({ address: F })) ?? "0x").length / 2 - 1);
const head = await pub.getBlockNumber();
const logs = [];
for (let to = head; to > 0n; to -= 10_000_000n) {
  const from = to >= 9_999_999n ? to - 9_999_999n : 0n;
  const l = await pub.getLogs({ address: F, fromBlock: from, toBlock: to });
  logs.push(...l);
  if (from === 0n) break;
}
console.log("factory logs:", logs.length, "topics0:", [...new Set(logs.map((l) => l.topics[0]))].join(","));
const cands = new Set();
for (const l of logs) for (const t of l.topics.slice(1)) if (/^0x0{24}[0-9a-f]{40}$/i.test(t)) cands.add("0x" + t.slice(26));
for (const l of logs) for (const m of (l.data.slice(2).match(/.{64}/g) || [])) if (/^0{24}[0-9a-f]{40}$/i.test(m) && !/^0{64}$/.test(m)) cands.add("0x" + m.slice(24));
const rows = [];
for (const a of cands) {
  try {
    const [s, n, d] = await Promise.all([pub.readContract({ address: a, abi: erc20Abi, functionName: "symbol" }), pub.readContract({ address: a, abi: erc20Abi, functionName: "name" }), pub.readContract({ address: a, abi: erc20Abi, functionName: "decimals" })]);
    rows.push({ s, n, d, a });
  } catch {}
}
rows.sort((x, y) => x.s.localeCompare(y.s));
console.log(rows.length, "tokens");
console.log(rows.map((r) => `${r.s}\t${r.d}\t${r.a}\t${r.n}`).join("\n"));
