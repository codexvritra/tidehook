import { ADDR, GITHUB_URL, POOL_MANAGER, explorer } from "../lib/chain";
import { short } from "../lib/format";
import { Inspector } from "../components/Inspector";

const HOOKS = [
  {
    name: "PatienceHook",
    addr: ADDR.patience,
    title: "Pay less for waiting",
    body: "Every pool has two lanes. Instant swaps pay 1%. A patient trader first posts a salted hash of their exact swap, waits, then reveals it: the fee falls linearly to 0.05% over an hour. Snipers who must act in the launch block pay the most, and that goes to LPs. The hash hides size and direction until reveal. Age counts from the pool's creation, so nobody can pre-commit a launch snipe.",
  },
  {
    name: "SpringHook",
    addr: ADDR.spring,
    title: "Fees as a restoring force",
    body: "The pool tracks a time-weighted rest price. Near it, swaps pay 0.30%. Push the price further away and each tick costs more (Hooke's law), up to 5%. Swaps that pull it back pay 0.05%, as long as their price limit stops at the rest price. The rest point only moves with elapsed time, so many swaps in one block can't drag it.",
  },
  {
    name: "CreatorBondHook",
    addr: ADDR.bond,
    title: "The creator's tokens back the floor",
    body: "The creator's allocation is escrowed with a price floor they choose. It vests over time, but the creator can claim only once the price has held above the floor for the grace period. If the price stays below the floor that long, anyone can slash the bond and every unclaimed token is burned. Flash pumps can't claim and round trips can't stall a slash.",
  },
  {
    name: "SessionHook",
    addr: ADDR.session,
    title: "Fees that follow the market clock",
    body: "For pools paired with tokenized stocks: 0.05% in regular NYSE hours, 0.30% extended, 1% overnight, 2% at weekends and on holidays. Trading never halts. LPs are paid for the gap risk the real market can't arbitrage while it's closed. The admin can keep DST and holidays current, and fees are hard-capped at 5%.",
  },
];

export function About() {
  return (
    <>
      <section className="tight">
        <div className="wrap">
          <div className="kicker">
            <span className="n">How it works</span>
          </div>
          <h2>
            Other hooks <em>block</em> trades. These <em>price</em> them.
          </h2>
          <p className="section-lede">
            Most hook launchpads use on/off rules: sell caps, allowlists, circuit breakers. A blocked trade earns nothing.
            tidehook lets every trade through and charges for the risk it adds. The fees go to the locked liquidity, and the
            creator can collect them.
          </p>
          <div className="about-grid">
            {HOOKS.map((h) => (
              <div key={h.name} className="panel">
                <div className="panel-head">
                  <span className="tag">{h.name}</span>
                  <a className="mono" href={explorer(h.addr)} target="_blank" rel="noreferrer">
                    {short(h.addr)}
                  </a>
                </div>
                <h3>{h.title}</h3>
                <p className="muted">{h.body}</p>
              </div>
            ))}
          </div>

          <div className="panel" style={{ marginTop: 16 }}>
            <div className="panel-head">
              <span className="tag">What a launch does, in one transaction</span>
            </div>
            <ol className="steps">
              <li>Deploys a plain 1B-supply ERC20 with no owner, no mint function, no tax and no blacklist.</li>
              <li>Initializes a Uniswap v4 pool against ETH or any token, at the start price the creator chose.</li>
              <li>Adds every public token as single-sided liquidity, held by the launcher forever. It can never be removed.</li>
              <li>Bonds the creator's share in CreatorBondHook (Bond pools), or sends it to the creator.</li>
              <li>The locked position earns every swap fee. Only the creator can collect them.</li>
              <li>No cap and no graduation: liquidity reaches the v4 maximum price from block one, so a coin never gets stuck waiting to "migrate".</li>
              <li>Rename: the creator can change name, symbol, image and description. The ERC20 itself changes, at most once per 24h, with every rename logged.</li>
              <li>Upgrade the hook or change the pair: a v4 pool's hook and currencies are fixed, so the launcher moves all locked liquidity into a new pool at the same price. It's announced 24h ahead. Pairs are limited to admin-approved assets and deep route pools, with a 5% price-sanity bound. Bond launches can't migrate.</li>
            </ol>
            <p className="note">
              Uniswap v4 PoolManager:{" "}
              <a className="mono" href={explorer(POOL_MANAGER)} target="_blank" rel="noreferrer">
                {short(POOL_MANAGER)}
              </a>{" "}
              · Launcher{" "}
              <a className="mono" href={explorer(ADDR.launcher)} target="_blank" rel="noreferrer">
                {short(ADDR.launcher)}
              </a>{" "}
              · Router{" "}
              <a className="mono" href={explorer(ADDR.router)} target="_blank" rel="noreferrer">
                {short(ADDR.router)}
              </a>{" "}
              ·{" "}
              <a href={GITHUB_URL} target="_blank" rel="noreferrer">
                source
              </a>
            </p>
          </div>
        </div>
      </section>
      <Inspector />
    </>
  );
}
