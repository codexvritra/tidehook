# tidehook

[![ci](https://github.com/codexvritra/tidehook/actions/workflows/ci.yml/badge.svg)](https://github.com/codexvritra/tidehook/actions/workflows/ci.yml)

**A token launchpad on Robinhood Chain where Uniswap v4 hooks price time instead of blocking trades.**

**Live app: https://tidehook-launchpad.vercel.app**

Launch a token in one transaction. Its liquidity is locked forever, and its pool runs one of four hooks:

| Hook | What it does | Fee |
|---|---|---|
| **Patience** | Commit a salted hash of your swap, wait, then reveal it. Snipers who must buy *now* pay the most. | 1% instant → 0.05% after an hour |
| **Spring** | Fee is a restoring force around a time-weighted rest price. Dumps pay more the further they push; swaps back toward rest pay the least. | 0.05% – 5% |
| **Bond** | The creator's allocation is escrowed against a price floor. It vests only while the floor holds; anyone can burn it if the floor is lost. | 1% |
| **Session** | For pools paired with tokenized stocks. Fee follows NYSE hours. | 0.05% open → 2% weekend |

No hook ever reverts a trade for being "against the rules". It charges for the risk the trade adds, and that
fee goes to the locked liquidity. The creator can collect it.

---

## Contracts (Robinhood Chain, chain id 4663)

All eight deploy through the canonical CREATE2 deployer (`0x4e59…956C`) to fixed addresses. Hook salts were mined so
the low 14 address bits equal the hook's Uniswap v4 permission flags.

| Contract | Address | Role |
|---|---|---|
| PatienceHook | `0xc061bAc04CA08d8EFCFB14Ad868B94d5C7EB2080` | commit-reveal fee lane |
| SpringHook | `0xdf0E706bD5EFaF7DC630A9f0f499320064507080` | restoring-force fees |
| CreatorBondHook | `0x71B0A0445D5443FcB94333d5C93fD5967B5CE040` | creator escrow and floor |
| SessionHook | `0x217D7357D41A99aef9F206fA042281578Cb8A080` | market-session fees |
| TideTokenFactory | `0xb265288f662E0bEFeCeE549690FacEc2e2886CEA` | deploys each launch's ERC20 |
| TideMigrator | `0x691f10453e761c74D210a93472FF95347f781b80` | liquidity migration logic (delegatecall from the launcher only) |
| TideLauncher | `0xcD5C782670c688C5C4D504f36e4D40422D7B3f8E` | launch, fees, rename, migrate |
| TideRouter | `0x026b7469bE095D42D732A390E93c168992F8bd73` | swaps with quotes, slippage, deadline, ETH refunds |

Uniswap v4 PoolManager: `0x8366a39CC670B4001A1121B8F6A443A643e40951` (verified on-chain).
Frozen init code and salts live in [`deployments/robinhood.json`](deployments/robinhood.json) and
[`web/src/deploy/initcode.json`](web/src/deploy/initcode.json).

### Deploy

Either path sends the exact same bytes, so the addresses are the same:

- **From the website:** open `/#/deploy`, connect a wallet holding a little ETH on Robinhood Chain, and click
  *Deploy everything that's missing*.
- **From the CLI:**
  ```bash
  forge script script/Deploy.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast --account <keystore>
  ```

The SessionHook schedule admin becomes the deploying EOA. It can update DST and holiday times and fees, and fees
are hard-capped at 5%.

## What a launch does

`TideLauncher.launch()` in one transaction:

1. Deploys a plain 1B-supply ERC20 (`TideToken`): no owner, no mint function, no tax, no blacklist.
2. Initializes a v4 pool against ETH or any ERC20, at the creator's start price.
3. Adds every public token as **single-sided liquidity starting at the launch price**, owned by the launcher
   forever. It cannot be removed.
4. Bond pools: escrows the creator's share in CreatorBondHook. Other pools: sends it to the creator (max 20%).
5. Rounding dust is burned. The creator calls `collectFees(id)` to collect the position's swap fees.

Launch prices are given in one fixed orientation (quote as currency0). The launcher flips them when the new token
sorts first, so the frontend never has to predict the token's address.

## After launch: no cap, rename, upgrade

- **No cap, never stuck.** There's no bonding curve and no graduation. Liquidity reaches the v4 maximum price from the first
  block, so a coin can always be bought and sold and never waits on a migration threshold.
- **Rename.** `updateMetadata(id, name, symbol, image, description)` changes the ERC20's `name()` and `symbol()`
  on-chain. Creator only, at most once per 24h, and every change is emitted as `MetadataUpdated`; the app shows the
  history.
- **Upgrade the hook or change the pair.** A v4 pool's hook and currencies are part of its PoolKey and can never change.
  So, Claus-style hook upgrades that actually move liquidity: the launcher pulls all locked liquidity out of the old pool
  in one `unlock`, converts the quote side if the pair changes, opens a new pool with the new hook at the same price, and
  re-adds the tokens plus the quote as bid support. Fees accrued in the old pool go to the creator.
  - `proposeMigration` → public 24h timelock → `executeMigration` within 3 days, or `cancelMigration`.
  - New quote assets must be allowlisted by the route admin and converted through an admin-registered route pool. That
    route is pinned at proposal; its spot may drift at most 5% before execution, and the fill must land within 3% of
    spot. Otherwise the migration reverts. A partial fill reverts rather than strand holders' funds.
  - Bond launches can't migrate: their escrow is tied to the original pool's price.
  - If someone initializes the exact target pool first, the migration reverts (nothing is lost); propose a different
    hook or pair.

## The app (`web/`)

Vite + React + viem. It reads the chain straight from the browser, with no indexer and no backend:

- **Explore:** every launch with its live price and market cap, from `getLaunches()`.
- **Launch:** name, image, hook, quote asset, starting market cap, creator share, bond terms.
- **Token:**
  - live quotes from the router's on-chain quoter, slippage limits and approvals
  - the Patience commit/reveal lanes (salt saved locally, with a visible backup)
  - the Spring at-rest discount
  - Bond claim and slash
  - live Session fees
  - creator fee collection
  - a price chart and trade feed built from PoolManager `Swap` events
- **Deploy:** one-click deployment from your wallet.

```bash
cd web && npm install && npm run dev
```

## Verification

| Check | Result |
|---|---|
| Unit, regression and fuzz tests (`forge test`) | 35 pass |
| Live fork tests: every hook, then launch → buy → sell → collect, plus rename and hook upgrade, on the real Robinhood PoolManager | pass |
| E2E rehearsal (`web/scripts/e2e-fork.mjs`): the exact deploy txs, then every hook traded through the router, on a mainnet fork | pass |
| Real UI driven end to end on a mainnet fork: deploy, launch, buy, commit/reveal, approve + sell, collect fees, every hook panel, rename, announce → execute migration, trade on the upgraded pool | pass |
| `forge script` dry-run against live mainnet state lands every contract at its committed address | pass |
| Frontend math (commitment hash, fees, sessions) vs contracts | 400/400 match |

Rehearse locally:

```bash
anvil --fork-url https://rpc.mainnet.chain.robinhood.com --port 8546 --chain-id 4663 --block-time 1
cd web && node scripts/e2e-fork.mjs
# UI against the fork, with a dev-only test wallet (never in production builds):
printf 'VITE_RPC_URL=http://127.0.0.1:8546\nVITE_DEV_WALLET=anvil\n' > .env.development.local && npm run dev
```

## Security review: issues found and fixed

| # | Where | Issue | Fix |
|---|---|---|---|
| 1 | Bond | Flash-pump claim: buy above floor → claim → dump in one tx | Claim needs the floor to have *held* for `grace` |
| 2 | Bond | Round trips reset the slash timer forever | Recoveries shorter than `grace` resume the original timer |
| 3 | Patience | Pool ids are deterministic, so snipers pre-commit before launch | Age counts from `max(commit, pool initialize)` |
| 4 | Spring | Open-limit "restoring" buy overshoots into a cheap pump | `minFee` only when the price limit stops at rest |
| 5 | Bond | Dust-bond squatting blocks the real creator | Only the pool initializer (the launcher) may bond |
| 6 | Bond | A floor above the launch price was slashable before the token ever reached it | Bond *arms* only once the price first reaches the floor |
| 7 | Launcher | ERC20-quoted launch price would invert if the new token sorted first | Orientation-independent price params |
| 8 | App | First-ever token transfer inside the unlock callback ran just past the gas estimate | 30% gas headroom on every tx |
| 9 | Migrator | Partial route fill would sweep holders' leftover quote to the creator | Conversion must fill in full or revert |
| 10 | Migrator | Admin could swap the route pool between proposal and execution | Route pool id pinned at proposal |
| 11 | App | Countdowns and swap deadlines used the viewer's clock, not `block.timestamp` | Chain-synced clock and chain-time deadlines |

**Trust model.** Creators can rename their coin and, after a public 24h notice, move its liquidity to another hook or
an approved pair; holders should watch the token page for scheduled migrations. The route admin (the launcher's
deployer) curates which quote assets and route pools are allowed; it can't touch any funds, but a malicious route would
be its responsibility, so put it behind a multisig.

**Not audited.** This is experimental software. Tokens are created by anyone and can lose all value.

## Layout

```
src/            hooks, TideLauncher (+ TideLauncherBase, TideMigrator), TideRouter, TideToken (+ factory)
test/           Tidehook.t.sol (hooks), Launch.t.sol (launch/trade/fees), Upgrade.t.sol (rename/migrate), Fork.t.sol (live)
script/         Deploy.s.sol (deploys the frozen init code)
deployments/    robinhood.json (addresses, salts, init code hashes)
web/            the app; scripts/ regenerates ABIs and addresses and runs the fork E2E
lib/            Uniswap v4 (git submodule)
```

After changing a contract: `forge fmt` → `forge build` → `node web/scripts/abis.mjs` →
`node web/scripts/deployments.mjs`, in that order. Formatting changes the bytecode metadata and so the addresses.
