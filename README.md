# tidehook

[![ci](../../actions/workflows/ci.yml/badge.svg)](../../actions/workflows/ci.yml)

**Hooks that price time.** A suite of Uniswap v4 hooks for Robinhood Chain built around one idea the
other hook projects leave alone: *time is a market input*. How long you waited, how long a price has
held, how long a creator keeps their promise, and whether the stock market is open all change what
a swap costs. No hook here ever blocks a trade. Each one changes the price of a trade.

---

## The landscape (researched 2026-10-24)

| | **Hookshade** (hookshade.com, @hookshadeRH) | **Ignition** (ignition.family, @ignition_rh) | **Hooked** (hookedpad.com, @hookedpad) |
|---|---|---|---|
| Chain | Robinhood Chain (4663), Uniswap v4 | Robinhood Chain, Uniswap v4 | Solana, Token-2022 transfer hooks |
| Core idea | Privacy: batch-settled "Shade" hook, ZK shielded pool, browser-only watch rules | Token launchpad: live v4 pool from block 1, stock pairs, "Stock Mode" circuit breakers, upgradeable hook modules | 54 transfer rules that **revert** trades that break them (sell caps, allowlists, market hours, "physics") |
| Tone | Precise, self-critical, nacre and shells | Meme-friendly, flame mascot | Playful, punchy |
| Token | $HOOKSHADE (no disclosed economics) | not disclosed | $HOOKED: 1% curve fee, 85% buy-and-burn |
| Gaps | 1 market, unaudited, dev proving key | low volume, unaudited, no fee disclosure | rules are binary (pass or revert), Solana only |

**What none of them do:**
1. **Rules are binary.** Hooked and Ignition's circuit breakers *block* behaviour. A blocked trade
   leaves the pool with nothing. Pricing the behaviour lets the trade happen and pays LPs for the risk it adds.
2. **Nobody prices patience.** Hookshade batches for privacy, but no one rewards a trader for waiting.
3. **Nobody bonds the creator.** Launchpads trust the creator's allocation or lock it for a fixed time.
   Nothing ties the creator's payout to the price they launched at.
4. **Stock pairs ignore the exchange clock.** Ignition pairs tokens with NVDA and GLD, but a tokenized
   stock pool keeps quoting at a flat fee while the real market is closed and cannot arbitrage it.

tidehook fills those four gaps.

---

## The hooks

### 1. `PatienceHook`: pay less for waiting
A two-lane fee market.
- **Fast lane:** swap now and pay `baseFee` (default 1%).
- **Slow lane:** `commit(hash(pool, direction, amount, limit, salt))`, wait, then swap with the salt
  in `hookData`. The fee decays linearly to `minFee` (default 0.05%) over `rampDuration`.

Why it's new: snipers and bots that must act in the launch block pay the most, and that money goes
to LPs. The commitment hides direction and size until reveal, so the intent can't be front-run. This
is anti-snipe with no blocklist and no revert-on-buy. Age counts from `max(commit time, pool launch)`,
so pre-hashing a launch swap before the pool exists buys nothing.

### 2. `SpringHook`: fees as a restoring force
The pool tracks a time-weighted "rest" price (an EMA of the tick).
- Inside a neutral band, every swap pays `baseFee`.
- Outside the band, swaps that **stretch** the price further pay `base + stiffness × distance`
  (Hooke's law), capped at `maxFee`.
- Swaps that **restore** the price pay `minFee`, but only when their `sqrtPriceLimitX96` stops at
  the rest price (`restLimit(poolId)`). An open-ended restoring swap could overshoot into a cheap
  pump, so it pays `baseFee`.

Dumps get more expensive the further they go, and dip-buyers and arbitrageurs get the cheapest
fills. The anchor moves only with elapsed time, so a burst of swaps inside one block can't drag it.

### 3. `CreatorBondHook`: the creator's bag backs the floor
The creator escrows their own allocation and picks a floor price.
- The allocation vests linearly, but **it can be claimed only after price has *held* ≥ floor for `grace`**.
- If the price stays below the floor for `grace`, **anyone** can call `slash()`, and every unclaimed
  token is burned.
- An above-floor stint shorter than `grace` does not reset the slash timer.
- Only the address that initialized the pool can bond, so a dust bond can't front-run the real creator.

This turns "trust me, I won't dump" into collateral. The creator gets paid only while holders are doing well.

### 4. `SessionHook`: fees follow the stock market's clock
Built for Robinhood Chain's tokenized-equity pairs. The fee depends on the session:

| Session | Default fee | Why |
|---|---|---|
| Regular (13:30–20:00 UTC) | 0.05% | The real market can arbitrage the pool |
| Extended (pre and post) | 0.30% | Thin real-world liquidity |
| Closed overnight | 1.00% | LPs carry gap risk |
| Weekend or holiday | 2.00% | The longest gap |

The owner keeps the schedule (DST) and holiday calendar up to date without redeploying.

---

## Security review: exploits found and fixed

Each one has a regression test in `test/Tidehook.t.sol`.

| # | Hook | Attack | Fix |
|---|---|---|---|
| 1 | CreatorBond | **Flash-pump claim:** buy above floor → `claim()` → dump, all in one tx | Claim needs the floor to have *held* for `grace` (`FloorNotHeld`) |
| 2 | CreatorBond | **Timer reset:** a buy-then-sell round trip restarts the slash clock forever | Recoveries shorter than `grace` resume the original breach timer |
| 3 | Patience | **Pre-launch commit:** pool ids are deterministic, so snipers hash the launch swap days early | Age counts from `max(commit, pool initialize)` |
| 4 | Spring | **Overshoot discount:** a "restoring" buy with an open limit pumps far past rest at `minFee` | `minFee` only when the price limit stops at rest |
| 5 | CreatorBond | **Dust-bond squatting:** someone front-runs `bond()` to block the real creator | Only the pool's initializer may bond |

## Verification

- **15 unit, regression and fuzz tests** (3 invariants × 256 runs).
- **Live fork test:** all four hooks initialize, take liquidity, and swap both ways against the real
  Uniswap v4 PoolManager on Robinhood Chain (`0x8366a39CC670B4001A1121B8F6A443A643e40951`, chain 4663).
- **Deploy script dry run:** broadcast end to end on a local chain with a real PoolManager. Every
  hook lands on a mined address carrying exactly its permission bits.
- **Frontend parity:** the site's TypeScript fee models and commitment hash were compared with the
  deployed contracts on 400 random inputs, with 0 mismatches.

## Layout

```
src/base/TideBaseHook.sol   minimal hook base (v4-core only)
src/PatienceHook.sol
src/SpringHook.sol
src/CreatorBondHook.sol
src/SessionHook.sol
test/Tidehook.t.sol         unit, exploit-regression and fuzz tests
test/Fork.t.sol             live Robinhood Chain fork test
script/Deploy.s.sol         mines CREATE2 salts so addresses carry the right permission bits
lib/v4-periphery            Uniswap v4 (git submodule; core, solmate, forge-std nested)
web/                        Vite + React + viem site with interactive simulators (deployed on Vercel)
```

## Run it

```bash
git clone --recursive <this repo> && cd tidehook
forge test -vv
ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com forge test --match-contract Fork -vv
```

Web:

```bash
cd web && npm install && npm run dev
```

After deploying, set `VITE_PATIENCE_HOOK`, `VITE_SPRING_HOOK`, `VITE_BOND_HOOK` and
`VITE_SESSION_HOOK` in Vercel. The site then reads the live contracts and lets wallets post
Patience commitments. Run `npm run abis` after changing a contract.

Deploy to Robinhood Chain:

```bash
ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com POOL_MANAGER=0x8366a39CC670B4001A1121B8F6A443A643e40951 OWNER=<admin multisig> forge script script/Deploy.s.sol --rpc-url robinhood --broadcast --account <keystore>
```

Pools that use Patience, Spring or Session must be created with `fee = LPFeeLibrary.DYNAMIC_FEE_FLAG`
(`0x800000`). Creator Bond works with any fee tier.

## Design notes and known limits
- **Time, not blocks.** Robinhood Chain is an Arbitrum Orbit chain. There `block.number` follows L1,
  so every clock here uses `block.timestamp`.
- **Patience:** a commitment is a bearer secret. Anyone who learns the salt can redeem it. If a
  revealed swap is copied in the mempool, the copier pays their own tokens for the same trade.
  Redeeming a commitment that doesn't exist or is too young **reverts**. It never falls back to the
  fast-lane fee silently.
- **Creator Bond:** the floor state updates on swaps. That's sound because only swaps move a v4
  price. Slashing burns to `0xdEaD`. Donating to LPs instead is on the roadmap. Initialize the pool
  directly from the creator's address, or from a launcher contract that bonds in the same tx.
- **Session:** the schedule is owner-maintained. Put the owner behind a multisig or timelock.
- **Not audited.** Treat this as a prototype.

---

## Roadmap: more ideas none of the three are doing

| Idea | One line |
|---|---|
| **Conviction LP** | LP fee share scales with how long a position has stayed unchanged. Mercenary liquidity earns less. |
| **Rebound bounty** | Part of Spring's surcharge goes into a pot. The swap that brings price back to rest claims it. |
| **Creator Bond → LP donate** | Slashed tokens go to in-range LPs through `donate` instead of being burned. |
| **Earnings-week mode** | SessionHook raises fees around listed earnings dates for the paired stock. |
| **Tide composer** | One hook address that chains Patience × Spring × Session multipliers per pool. |
| **Echo hook** | A token's pool fee follows the realised volatility of its paired stock token's pool. |
| **Browser keeper** | A Hookshade-style, server-less page that commits and reveals Patience swaps for you. |
