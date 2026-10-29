import { useEffect, useMemo, useState } from "react";
import { useApp } from "../lib/appContext";
import { KINDS, readAsset, readLaunches, usePoll, type Asset, type Launch } from "../lib/data";
import { fmtNum, marketCap, tokenPrice } from "../lib/price";
import { Avatar, KindBadge, Price } from "../components/bits";
import { ago } from "../lib/format";

function useAssets(launches: Launch[] | undefined) {
  const [assets, setAssets] = useState<Record<string, Asset>>({});
  useEffect(() => {
    if (!launches) return;
    const quotes = [...new Set(launches.map((l) => l.quote.toLowerCase()))];
    Promise.all(quotes.map((q) => readAsset(q as `0x${string}`).catch(() => null))).then((list) => {
      const m: Record<string, Asset> = {};
      list.forEach((a, i) => a && (m[quotes[i]] = a));
      setAssets(m);
    });
  }, [launches]);
  return assets;
}

export function Explore() {
  const { deploy } = useApp();
  const [launches, err] = usePoll(() => (deploy?.ready ? readLaunches() : Promise.resolve([])), 20_000, [deploy?.ready]);
  const assets = useAssets(launches);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<number | null>(null);
  const [sort, setSort] = useState<"new" | "mcap">("new");

  const rows = useMemo(() => {
    let r = (launches ?? []).map((l) => {
      const a = assets[l.quote.toLowerCase()];
      const price = a ? tokenPrice(l.sqrtPriceX96, l.tokenIsCurrency0, a.decimals) : NaN;
      return { l, a, price, mcap: marketCap(price) };
    });
    const needle = q.trim().toLowerCase();
    if (needle) r = r.filter(({ l }) => [l.name, l.symbol, l.token].some((s) => s.toLowerCase().includes(needle)));
    if (kind !== null) r = r.filter(({ l }) => l.kind === kind);
    if (sort === "mcap") r = [...r].sort((x, y) => (y.mcap || 0) - (x.mcap || 0));
    return r;
  }, [launches, assets, q, kind, sort]);

  return (
    <>
      <header className="hero compact">
        <div className="wrap">
          <span className="eyebrow">
            <span className="dot" /> Live on Robinhood Chain · Uniswap v4
          </span>
          <h1>
            Launch tokens with <em>hooks that set the price of time.</em>
          </h1>
          <p className="lede">
            On tidehook a trade is never blocked. It's priced instead. Launch a token in one transaction: its liquidity is
            locked forever and the pool runs one of four on-chain hooks. Instant snipers pay more than patient buyers. Dumps
            cost more the further they push. Creator tokens unlock only while their price floor holds.
          </p>
          <div className="cta">
            <a className="btn primary" href="#/launch">
              Launch a token
            </a>
            <a className="btn" href="#/about">
              How the hooks work
            </a>
          </div>
        </div>
      </header>

      <section className="tight">
        <div className="wrap">
          <div className="toolbar">
            <input className="input" placeholder="Search name, symbol or address" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search launches" />
            <div className="seg">
              <button className={kind === null ? "on" : ""} onClick={() => setKind(null)}>
                All
              </button>
              {KINDS.map((k, i) => (
                <button key={k} className={kind === i ? "on" : ""} onClick={() => setKind(i)}>
                  {k}
                </button>
              ))}
            </div>
            <div className="seg">
              <button className={sort === "new" ? "on" : ""} onClick={() => setSort("new")}>
                Newest
              </button>
              <button className={sort === "mcap" ? "on" : ""} onClick={() => setSort("mcap")}>
                Market cap
              </button>
            </div>
          </div>

          {!deploy && <p className="muted">Checking Robinhood Chain…</p>}
          {deploy && !deploy.ready && (
            <div className="empty">
              <h3>The protocol isn't deployed yet</h3>
              <p className="muted">Six contracts go to fixed, precomputed addresses. Anyone with a little ETH on Robinhood Chain can deploy them.</p>
              <a className="btn primary" href="#/deploy">
                Open the Deploy page
              </a>
            </div>
          )}
          {deploy?.ready && !launches && !err && <p className="muted">Loading launches from the chain…</p>}
          {Boolean(err) && <p className="warn">Couldn't read launches: the RPC may be rate-limiting. Retrying…</p>}
          {deploy?.ready && launches && launches.length === 0 && (
            <div className="empty">
              <h3>No launches yet</h3>
              <p className="muted">Be the first. It takes one transaction.</p>
              <a className="btn primary" href="#/launch">
                Launch a token
              </a>
            </div>
          )}

          <div className="grid">
            {rows.map(({ l, a, price, mcap }) => (
              <a key={l.id} className="card" href={`#/t/${l.id}`}>
                <div className="card-top">
                  <Avatar src={l.imageURI} label={l.symbol} />
                  <div className="card-title">
                    <b>{l.name}</b>
                    <span className="mono dim">${l.symbol}</span>
                  </div>
                  <KindBadge kind={l.kind} />
                </div>
                {l.description && <p className="card-desc">{l.description}</p>}
                <div className="card-stats">
                  <div>
                    <label>Market cap</label>
                    <b className="mono">
                      {fmtNum(mcap)} {a?.symbol ?? ""}
                    </b>
                  </div>
                  <div>
                    <label>Price</label>
                    <b className="mono"><Price value={price} /></b>
                  </div>
                  <div>
                    <label>Launched</label>
                    <b>{ago(l.createdAt)}</b>
                  </div>
                </div>
              </a>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
