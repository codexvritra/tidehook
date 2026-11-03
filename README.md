# tidehook

[![ci](https://github.com/codexvritra/tidehook/actions/workflows/ci.yml/badge.svg)](https://github.com/codexvritra/tidehook/actions/workflows/ci.yml)

**A token launchpad on Robinhood Chain where Uniswap v4 hooks price time instead of blocking trades.**

**Live app: https://tidehook.net**

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
| PatienceHook | `0xE8BB9967aAE67eE11b71FB628b6337F7A1eA60cC` | commit-reveal fee lane |
| SpringHook | `0x96b0b6Cd46FAcC24e9444d58cd7419526d9bb0Cc` | restoring-force fees |
| CreatorBondHook | `0x21e09C444a44514201B82bba845974d1Da2Da0Cc` | creator escrow and floor |
| SessionHook | `0x7Cf1E2709b7C57c91868638ce1Eb8577d3C4E0cc` | market-session fees |
| TideTokenFactory | `0xb265288f662E0bEFeCeE549690FacEc2e2886CEA` | deploys each launch's ERC20 |
| TideMigrator | `0x094D8Ad006AB85425742D8D9DA209Dce6bCc9c78` | liquidity migration logic (delegatecall from the launcher only) |
| TideLauncher | `0x4588f599183CD38e92db7B0EF21d6b1A637F97ee` | launch (+ launch fee), LP-fee routing, rename, migrate |
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
4. Bond pools only: escrows the creator's share (max 20%) in CreatorBondHook, vesting at least 30 days. Every other
   launch puts 100% of supply in the pool, so there is never a liquid dev bag.
5. Rounding dust is burned.

Launch prices are given in one fixed orientation (quote as currency0). The launcher flips them when the new token
sorts first, so the frontend never has to predict the token's address.

## Fees (all paid in ETH, never in the launched token)

| What | Amount | Goes to |
|---|---|---|
| Launch fee | ~$3 in ETH (admin-set, stored in wei) | platform wallet |
| Buy tax | 1% of the ETH spent | token creator |
| Buy tax | 1% of the ETH spent | platform wallet |
| Sell tax | 2% of the ETH received | platform wallet |
| LP fee | none: launchpad pools charge 0% LP fee | — |

So every trade costs exactly 2%. Across a $100 buy and a $100 sell, the creator earns $1 and the platform $3.

The buy and sell taxes are enforced **inside the v4 hooks** (`TideFeeHook`) with swap return-deltas, so trading through
any router or aggregator pays them. They are charged in the pool's quote asset: ETH for ETH pairs, or the quote token
for ERC20 pairs, never the launched token. Fees accrue as ERC-6909 claims in the PoolManager, so no ETH moves
mid-swap and a payee that rejects ETH can never block trading. Creators claim from their token page (`claim`), and anyone can push
platform fees to the platform wallet (`claimPlatform`). The admin proposes a new platform wallet (`proposeFeeRecipient`),
which anyone can apply after a public 2-day delay (`applyFeeRecipient`), and sets the launch fee (`setLaunchFee`, capped at
0.01 ETH; the Deploy page converts $3 at the current ETH price). Admin handover is two-step and delayed too
(`proposeAdmin` → `acceptAdmin` after 2 days), and a creator can hand a launch to a new wallet (`transferCreator` →
`acceptCreator`), which moves future fees, rename and migration rights.

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
| Unit, regression, fee and fuzz tests (`forge test`) | 47 pass |
| Live fork tests: every hook, then launch → buy → sell → collect, plus rename and hook upgrade, on the real Robinhood PoolManager (3 tests) | pass |
| E2E rehearsal (`web/scripts/e2e-fork.mjs`): the exact deploy txs, then every hook traded through the router, on a mainnet fork | pass |
| Real UI driven end to end on a mainnet fork: deploy, set the $3 launch fee, launch (paying it), buy, creator ETH claim, commit/reveal, approve + sell, every hook panel, rename, announce → execute migration, trade on the upgraded pool | pass |
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
src/            hooks (+ base/TideFeeHook fee layer), TideLauncher (+ TideLauncherBase, TideMigrator), TideRouter, TideToken (+ factory)
test/           Tidehook.t.sol (hooks), Launch.t.sol (launch/trade), Fees.t.sol (launch fee, taxes, claims), Upgrade.t.sol (rename/migrate), Fork.t.sol (live)
script/         Deploy.s.sol (deploys the frozen init code)
deployments/    robinhood.json (addresses, salts, init code hashes)
web/            the app; scripts/ regenerates ABIs and addresses and runs the fork E2E
lib/            Uniswap v4 (git submodule)
```

After changing a contract: `forge fmt` → `forge build` → `node web/scripts/abis.mjs` →
`node web/scripts/deployments.mjs`, in that order. Formatting changes the bytecode metadata and so the addresses.

## Lessons from Ignition, applied

Ignition (another Robinhood Chain launchpad) published its own incidents and fixes. Tidehook avoids each of them by design:

| Ignition's problem | Tidehook |
|---|---|
| A team member holding the dev wallet sold 15M tokens; one person controlled the creator-fee wallet | No liquid creator allocation ever exists (Bond only, ≥30-day vest, slashable). Platform wallet and admin changes are public and delayed 2 days, and use a multisig as admin |
| Launches couldn't move to a new owner until V3 | Two-step `transferCreator` / `acceptCreator` from day one |
| Early fees were taken in the launched token (sell pressure) | Every fee is ETH or the quote asset, never the token |
| Fixed-range liquidity gave old launches a price ceiling | Liquidity reaches the v4 max price; no cap, no graduation |
| A curve that sold out could fail to graduate and get stuck | No bonding curve, nothing to graduate |
| Owners could point a hook at their own trading code (until V17) | Migration only between the four fixed Tidehook hooks; no arbitrary code |
| Shaped liquidity could block buys (V9); Stock Mode reverts trades | No hook ever blocks a swap; selling is always possible |
| Fee could differ per launch / decay | Exactly 2% on every trade, constants in code, no LP fee on top |

## Stock pairs

Launches can be paired with ETH or with the same assets pons.family offers: USDG and the Robinhood stock tokens NVDA,
SPY, TSLA, GME, PLTR, GLD, SPCX and MU (any other ERC20 also works via "Other token"). `web/scripts/stocks.mjs`
regenerates `web/src/lib/stocks.ts` from mainnet: it checks each address's symbol, checks stocks were deployed by
the Robinhood stock factory (`0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046`) and picks the deepest hookless
ETH/<asset> Uniswap v4 pool as that asset's migration route. The admin enables them all from the Deploy page
(`setQuoteAllowed` + `setRoute`), after which an existing coin can switch its pair from ETH to any of them.

`web/scripts/pairswitch-fork.mjs` proves it on a local mainnet fork: rename, 24h notice, ETH → NVDA migration
through the real ETH/NVDA pool, then buys and sells in NVDA with the creator earning 1% in NVDA.

## Holder veto (launcher v2)

A creator's hook or pair switch is announced 24h ahead. During that notice any holder can lock the coin's tokens in
`TideVeto` against it; once locked tokens reach 10% of the circulating supply (everything outside the pool, the burn
address and the creator bond) `executeMigration` reverts with `Vetoed`. Tokens unlock at any time, and every new
proposal starts a fresh count. `web/scripts/veto-fork.mjs` runs it end to end on a mainnet fork.

## Limit orders and DCA (TideOrders)

`TideOrders` works with every launch pool and charges nothing of its own.

- **Limit orders** are one-tick-spacing range positions just outside the price (take-profit above, buy-the-dip
  below). When trades push the price through the range it fully converts; anyone can then `fill` it, which withdraws
  it and pays the owner. Takers crossing the order pay the usual 2%; the maker pays nothing extra.
- **DCA** escrows funds and swaps one slice per interval (min 60s, max 1000 slices). Anyone can `execute` a due
  slice; a slice that can't fill in full inside the owner's worst-price limit reverts and waits.
- **Keeper**: the indexer service closes filled orders and runs due slices. It generates its own gas-only wallet
  (address at `/health`) and stays idle until that wallet holds at least 0.0002 ETH.

`web/scripts/orders-fork.mjs` runs both on a mainnet fork.

## Tide Pot hook (launcher v3)

`TidePotHook` turns a coin's own trading into a last-buyer-wins game, inside the v4 swap path. Every trade still costs
exactly 2%, but on a Pot coin the creator's 1% of each buy fills the pool's pot (in ETH or the paired stock). A buy
worth at least 2% of the current pot makes the buyer the leader (named in hookData, else `tx.origin`) and resets a
1-hour clock. When the clock runs out the leader wins 80% of the pot and 20% seeds the next round; the next swap or
`settle` closes the round and the winner withdraws with `claim`. Sells never touch the pot. Pot coins can't migrate,
since a running pot belongs to its pool. `web/scripts/pot-fork.mjs` runs a full round on a mainnet fork.
