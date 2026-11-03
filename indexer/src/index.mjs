// tidehook indexer: follows the launcher, the PoolManager's swaps on launch pools, TideRouter trades and every
// launch token's transfers on Robinhood Chain, stores them in Postgres and serves them over a small JSON API.
// Everything is derived from on-chain events; restarting resumes from the stored cursor, and inserts are
// idempotent (tx hash + log index), so re-processing a range never double-counts.
import http from "node:http";
import pg from "pg";
import { createPublicClient, erc20Abi, http as rpcHttp, parseAbiItem } from "viem";
import { startKeeper } from "./keeper.mjs";

const RPC = process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const LAUNCHER = (process.env.LAUNCHER || "0xa566B45e69973578E043cB26c34EC1399e49205D").toLowerCase();
const ROUTER = (process.env.ROUTER || "0x026b7469bE095D42D732A390E93c168992F8bd73").toLowerCase();
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const START_BLOCK = BigInt(process.env.START_BLOCK || "104967797"); // TideLauncher v2 deployment
const CHUNK = BigInt(process.env.CHUNK || "5000");
const PORT = Number(process.env.PORT || 8080);
const ORDERS = (process.env.ORDERS ?? "0xd1F5Ce7A2BEBF60820879128367C77C75eB92033").toLowerCase();
let keeper = null; // set once TideOrders is live
const ETH = "0x0000000000000000000000000000000000000000";

const rpc = createPublicClient({ transport: rpcHttp(RPC, { retryCount: 6, retryDelay: 1500, timeout: 30_000 }) });
const db = process.env.PGLITE ? await pglite() : new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

/** Local testing only: an in-process Postgres (PGlite) behind the same query/connect surface as pg.Pool. */
async function pglite() {
  const { PGlite } = await import("@electric-sql/pglite");
  const pgl = new PGlite();
  const query = async (sql, params) => (params ? pgl.query(sql, params) : (await pgl.exec(sql)).at(-1));
  return { query, connect: async () => ({ query, release() {} }) };
}

const EV = {
  launched: parseAbiItem(
    "event Launched(uint256 indexed id, address indexed token, address indexed creator, uint8 kind, bytes32 poolId, address quote, int24 startTick, uint256 creatorAmount)",
  ),
  meta: parseAbiItem("event MetadataUpdated(uint256 indexed id, string name, string symbol, string imageURI, string description)"),
  migrated: parseAbiItem(
    "event Migrated(uint256 indexed id, bytes32 oldPoolId, bytes32 newPoolId, uint8 kind, address quote, int24 tick, uint256 tokenAmount, uint256 quoteAmount)",
  ),
  creator: parseAbiItem("event CreatorTransferred(uint256 indexed id, address indexed from, address indexed to)"),
  swap: parseAbiItem(
    "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
  ),
  trade: parseAbiItem("event Trade(bytes32 indexed poolId, address indexed trader, bool zeroForOne, uint256 amountIn, uint256 amountOut)"),
  transfer: parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)"),
};
const LAUNCH_ABI = [
  {
    type: "function",
    name: "getLaunch",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          { name: "creator", type: "address" },
          { name: "kind", type: "uint8" },
          { name: "tokenIsCurrency0", type: "bool" },
          { name: "tickLower", type: "int24" },
          { name: "tickUpper", type: "int24" },
          { name: "bidLower", type: "int24" },
          { name: "bidUpper", type: "int24" },
          { name: "migrations", type: "uint32" },
          { name: "createdAt", type: "uint64" },
          { name: "createdBlock", type: "uint64" },
          { name: "renamedAt", type: "uint64" },
          {
            name: "key",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "imageURI", type: "string" },
          { name: "description", type: "string" },
        ],
      },
    ],
  },
];

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ------------------------------------------------------------------ schema

async function migrate() {
  await db.query(`
    create table if not exists meta (k text primary key, v text not null);
    create table if not exists launches (
      id int primary key, token text unique not null, creator text not null, kind int not null,
      quote text not null, quote_decimals int not null, pool_id text not null, token_is0 bool not null,
      created_block bigint not null, created_at bigint not null, start_tick int not null,
      name text not null, symbol text not null, image_uri text not null, description text not null,
      migrations int not null default 0
    );
    create table if not exists pools (
      pool_id text primary key, launch_id int not null, token_is0 bool not null, quote text not null, quote_decimals int not null
    );
    create table if not exists trades (
      tx text not null, log_index int not null, pool_id text not null, launch_id int not null, block bigint not null,
      time bigint not null, trader text not null, buy bool not null, token_amount numeric not null,
      quote_amount numeric not null, sqrt_price numeric not null, primary key (tx, log_index)
    );
    create index if not exists trades_launch_time on trades (launch_id, time);
    create table if not exists transfers (
      token text not null, tx text not null, log_index int not null, block bigint not null,
      src text not null, dst text not null, amount numeric not null, primary key (tx, log_index)
    );
    create index if not exists transfers_token on transfers (token);
  `);
}

const getMeta = async (k) => (await db.query("select v from meta where k=$1", [k])).rows[0]?.v;
const setMeta = (c, k, v) => c.query("insert into meta (k, v) values ($1, $2) on conflict (k) do update set v = excluded.v", [k, String(v)]);

// ------------------------------------------------------------------ follower

const decimalsCache = new Map([[ETH, 18]]);
async function decimalsOf(token) {
  const t = token.toLowerCase();
  if (!decimalsCache.has(t)) decimalsCache.set(t, Number(await rpc.readContract({ address: t, abi: erc20Abi, functionName: "decimals" })));
  return decimalsCache.get(t);
}

const blockTimes = new Map();
async function timeOf(block) {
  if (!blockTimes.has(block)) blockTimes.set(block, Number((await rpc.getBlock({ blockNumber: block })).timestamp));
  if (blockTimes.size > 20_000) blockTimes.clear();
  return blockTimes.get(block);
}

/** viem accepts topic OR-lists; keep each request's list a sane size. */
async function logsFor(event, address, argName, values, fromBlock, toBlock) {
  const out = [];
  for (let i = 0; i < values.length; i += 200) {
    const args = argName ? { [argName]: values.slice(i, i + 200) } : undefined;
    out.push(...(await rpc.getLogs({ address, event, args, fromBlock, toBlock })));
  }
  return out;
}

async function step() {
  const head = await rpc.getBlockNumber();
  const cursor = BigInt((await getMeta("block")) ?? START_BLOCK - 1n);
  if (cursor >= head) return 0n;
  const from = cursor + 1n;
  const to = head - cursor > CHUNK ? cursor + CHUNK : head;

  const launcherLogs = await rpc.getLogs({ address: LAUNCHER, events: [EV.launched, EV.meta, EV.migrated, EV.creator], fromBlock: from, toBlock: to });
  launcherLogs.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));

  const c = await db.connect();
  try {
    await c.query("begin");
    for (const l of launcherLogs) {
      const id = Number(l.args.id);
      if (l.eventName === "Launched") {
        const L = await rpc.readContract({ address: LAUNCHER, abi: LAUNCH_ABI, functionName: "getLaunch", args: [l.args.id] });
        const quote = l.args.quote.toLowerCase();
        const qd = await decimalsOf(quote);
        const tokenIs0 = l.args.token.toLowerCase() < quote;
        await c.query(
          `insert into launches (id, token, creator, kind, quote, quote_decimals, pool_id, token_is0, created_block, created_at, start_tick,
             name, symbol, image_uri, description) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) on conflict (id) do nothing`,
          [id, l.args.token.toLowerCase(), l.args.creator.toLowerCase(), l.args.kind, quote, qd, l.args.poolId, tokenIs0, l.blockNumber, Number(L.createdAt), l.args.startTick, L.name, L.symbol, L.imageURI, L.description],
        );
        await c.query("insert into pools values ($1,$2,$3,$4,$5) on conflict do nothing", [l.args.poolId, id, tokenIs0, quote, qd]);
      } else if (l.eventName === "MetadataUpdated") {
        await c.query("update launches set name=$2, symbol=$3, image_uri=$4, description=$5 where id=$1", [id, l.args.name, l.args.symbol, l.args.imageURI, l.args.description]);
      } else if (l.eventName === "Migrated") {
        const quote = l.args.quote.toLowerCase();
        const qd = await decimalsOf(quote);
        const token = (await c.query("select token from launches where id=$1", [id])).rows[0]?.token;
        const tokenIs0 = token < quote;
        await c.query("insert into pools values ($1,$2,$3,$4,$5) on conflict do nothing", [l.args.newPoolId, id, tokenIs0, quote, qd]);
        await c.query("update launches set pool_id=$2, quote=$3, quote_decimals=$4, token_is0=$5, migrations=migrations+1, kind=$6 where id=$1", [id, l.args.newPoolId, quote, qd, tokenIs0, l.args.kind]);
      } else if (l.eventName === "CreatorTransferred") {
        await c.query("update launches set creator=$2 where id=$1", [id, l.args.to.toLowerCase()]);
      }
    }

    const pools = (await c.query("select pool_id, launch_id, token_is0 from pools")).rows;
    const tokens = (await c.query("select token from launches")).rows.map((r) => r.token);
    if (pools.length) {
      const byPool = new Map(pools.map((p) => [p.pool_id.toLowerCase(), p]));
      const [swaps, routed] = await Promise.all([
        logsFor(EV.swap, POOL_MANAGER, "id", pools.map((p) => p.pool_id), from, to),
        logsFor(EV.trade, ROUTER, "poolId", pools.map((p) => p.pool_id), from, to),
      ]);
      const traderOf = new Map(routed.map((r) => [r.transactionHash, r.args.trader.toLowerCase()]));
      for (const s of swaps) {
        const p = byPool.get(s.args.id.toLowerCase());
        if (!p) continue;
        const tokenDelta = p.token_is0 ? s.args.amount0 : s.args.amount1;
        const quoteDelta = p.token_is0 ? s.args.amount1 : s.args.amount0;
        const abs = (x) => (x < 0n ? -x : x);
        await c.query(
          `insert into trades values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict do nothing`,
          [s.transactionHash, s.logIndex, s.args.id, p.launch_id, s.blockNumber, await timeOf(s.blockNumber), traderOf.get(s.transactionHash) ?? s.args.sender.toLowerCase(), tokenDelta > 0n, abs(tokenDelta).toString(), abs(quoteDelta).toString(), s.args.sqrtPriceX96.toString()],
        );
      }
    }
    if (tokens.length) {
      for (let i = 0; i < tokens.length; i += 200) {
        const transfers = await rpc.getLogs({ address: tokens.slice(i, i + 200), event: EV.transfer, fromBlock: from, toBlock: to });
        for (const t of transfers) {
          await c.query("insert into transfers values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing", [t.address.toLowerCase(), t.transactionHash, t.logIndex, t.blockNumber, t.args.from.toLowerCase(), t.args.to.toLowerCase(), t.args.value.toString()]);
        }
      }
    }
    await setMeta(c, "block", to);
    await setMeta(c, "head", head);
    await c.query("commit");
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
  return head - to;
}

async function follow() {
  for (;;) {
    try {
      const behind = await step();
      if (behind > 0n) log(`synced to ${await getMeta("block")}, ${behind} blocks behind`);
      await new Promise((r) => setTimeout(r, behind > 0n ? 50 : 2000));
    } catch (e) {
      log("follow error:", e.shortMessage || e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// ------------------------------------------------------------------ API

const HOLDERS_SQL = `
  select holder, sum(delta)::text as amount from (
    select dst as holder, amount as delta from transfers where token = $1
    union all
    select src as holder, -amount as delta from transfers where token = $1 and src <> '${ETH}'
  ) x group by holder having sum(delta) > 0 order by sum(delta) desc limit $2`;

async function stats() {
  const now = Math.floor(Date.now() / 1000);
  const { rows } = await db.query(
    `select l.id, l.token, l.quote, l.quote_decimals,
       coalesce(sum(t.quote_amount) filter (where t.time > $1), 0)::text as vol24,
       coalesce(sum(t.quote_amount), 0)::text as vol_all,
       count(t.*) filter (where t.time > $1) as trades24,
       count(t.*) as trades,
       (select count(*) from (select h.holder from (
          select dst as holder, amount as delta from transfers where token = l.token
          union all select src, -amount from transfers where token = l.token and src <> '${ETH}') h
          group by h.holder having sum(h.delta) > 0) hh) as holders
     from launches l left join trades t on t.launch_id = l.id and t.pool_id = l.pool_id
     group by l.id order by l.id desc`,
    [now - 86400],
  );
  return rows.map((r) => ({ id: r.id, vol24: r.vol24, volAll: r.vol_all, trades24: Number(r.trades24), trades: Number(r.trades), holders: Number(r.holders), quoteDecimals: r.quote_decimals }));
}

const routes = [
  [/^\/health$/, async () => ({ ok: true, block: await getMeta("block"), head: await getMeta("head"), keeper: keeper && { address: keeper.address, balance: keeper.balance, active: keeper.active, fills: keeper.fills, slices: keeper.slices } })],
  [/^\/stats$/, stats],
  [
    /^\/launch\/(\d+)\/trades$/,
    async ([, id], q) => {
      const { rows } = await db.query(
        `select t.tx, t.block::text, t.time::int, t.trader, t.buy, t.token_amount::text, t.quote_amount::text, t.sqrt_price::text, t.pool_id
         from trades t where t.launch_id = $1 and t.pool_id = coalesce($2, (select pool_id from launches where id = $1))
         order by t.block, t.log_index limit 5000`,
        [Number(id), q.get("pool") || null],
      );
      return rows;
    },
  ],
  [
    /^\/launch\/(\d+)\/holders$/,
    async ([, id]) => {
      const token = (await db.query("select token from launches where id=$1", [Number(id)])).rows[0]?.token;
      if (!token) return [];
      return (await db.query(HOLDERS_SQL, [token, 500])).rows;
    },
  ],
];

http
  .createServer(async (req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("content-type", "application/json");
    const url = new URL(req.url, "http://x");
    for (const [re, fn] of routes) {
      const m = re.exec(url.pathname);
      if (!m) continue;
      try {
        res.setHeader("cache-control", "public, max-age=3");
        return res.end(JSON.stringify(await fn(m, url.searchParams)));
      } catch (e) {
        log("api error", url.pathname, e.message);
        res.statusCode = 500;
        return res.end(JSON.stringify({ error: "internal" }));
      }
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  })
  .listen(PORT, () => log(`api on :${PORT}`));

await migrate();
// A new launcher deployment has its own launch ids: start the index over instead of mixing them.
if ((await getMeta("launcher")) !== LAUNCHER) {
  await db.query("truncate launches, pools, trades, transfers");
  await db.query("delete from meta where k <> 'keeper_key'"); // never drop the keeper's wallet
  await db.query("insert into meta (k, v) values ('launcher', $1)", [LAUNCHER]);
  log(`fresh index for launcher ${LAUNCHER}`);
}
log(`indexing ${LAUNCHER} from block ${START_BLOCK} via ${RPC}`);
follow();
// The keeper starts as soon as TideOrders exists on-chain (checked every minute until then).
(async function waitForOrders() {
  for (let warned = false; ; ) {
    const code = await rpc.getCode({ address: ORDERS }).catch(() => undefined);
    if (code && code.length > 2) return void (keeper = await startKeeper({ rpc, rpcUrl: RPC, db, getMeta, log, orders: ORDERS }));
    if (!warned) (warned = true), log(`TideOrders ${ORDERS} not deployed yet: keeper waiting`);
    await new Promise((r) => setTimeout(r, 60_000));
  }
})();
