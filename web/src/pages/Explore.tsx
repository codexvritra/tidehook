import { useEffect, useMemo, useState } from "react";
import { go, useApp } from "../lib/appContext";
import { client } from "../lib/chain";
import { KINDS, readAsset, readLaunches, usePoll, type Asset, type Launch } from "../lib/data";
import { ago, short } from "../lib/format";
import { fmtNum, marketCap, priceAtTick, tokenPrice } from "../lib/price";
import { Avatar, KindBadge, Logo, Price } from "../components/bits";

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

const HOOK_LINE = ["flat 2%", "flat 2%", "flat 2% · bonded", "flat 2%"];

function Chg({ v }: { v: number }) {
  if (!isFinite(v)) return <span className="chg flat">—</span>;
  const flat = Math.abs(v) < 0.005;
  return <span className={`chg ${flat ? "flat" : v > 0 ? "up" : "down"}`}>{flat ? "0.00%" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`}</span>;
}

export function Explore() {
  const { deploy } = useApp();
  const [launches, err] = usePoll(() => (deploy?.ready ? readLaunches() : Promise.resolve([])), 20_000, [deploy?.ready]);
  const [block] = usePoll(() => client.getBlockNumber(), 10_000, []);
  const assets = useAssets(launches);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<number | null>(null);
  const [sort, setSort] = useState<"new" | "mcap" | "gain">("new");
  const [view, setView] = useState<"list" | "grid">("list");

  const rows = useMemo(() => {
    let r = (launches ?? []).map((l) => {
      const a = assets[l.quote.toLowerCase()];
      const price = a ? tokenPrice(l.sqrtPriceX96, l.tokenIsCurrency0, a.decimals) : NaN;
      const start = a ? priceAtTick(l.tokenIsCurrency0 ? l.tickLower : l.tickUpper, l.tokenIsCurrency0, a.decimals) : NaN;
      return { l, a, price, mcap: marketCap(price), chg: (price / start - 1) * 100 };
    });
    const needle = q.trim().toLowerCase();
    if (needle) r = r.filter(({ l }) => [l.name, l.symbol, l.token].some((s) => s.toLowerCase().includes(needle)));
    if (kind !== null) r = r.filter(({ l }) => l.kind === kind);
    if (sort === "mcap") r = [...r].sort((x, y) => (y.mcap || 0) - (x.mcap || 0));
    if (sort === "gain") r = [...r].sort((x, y) => (y.chg || -1e9) - (x.chg || -1e9));
    return r;
  }, [launches, assets, q, kind, sort]);

  return (
    <>
      <header className="hero">
        <div className="wrap">
          <div>
            <h1 className="wordmark">
              <Logo size={96} /> tidehook
            </h1>
            <a className="btn-hero" href="#/launch">
              Create token <span aria-hidden="true">→</span>
            </a>
            <p className="tagline">The hook launchpad that prices time · Robinhood Chain</p>
            <p className="lede">
              Launch in one transaction. Liquidity is locked forever and every pool runs an on-chain Uniswap v4 hook: snipers pay
              more than patient buyers, dumps cost more the further they push, and creator tokens unlock only while their floor
              holds.
            </p>
          </div>
          <aside className="hero-banner" aria-label="Protocol status">
            <h3>4 hooks · liquidity locked</h3>
            <ul>
              <li>No market-cap cap · no graduation · nothing gets stuck</li>
              <li>Liquidity locked at launch, earning fees for the creator</li>
              <li>Creators earn 1% of every buy, paid in ETH</li>
              <li>Rename the coin any time (24h cooldown, public history)</li>
              <li>Upgrade the hook or change the pair: timelocked v4 migration</li>
            </ul>
            <div className="hero-stats">
              <div>
                <label>Launches</label>
                <b>{deploy?.ready ? (launches ? launches.length : "…") : "—"}</b>
              </div>
              <div>
                <label>Block</label>
                <b>{block ? `#${block.toLocaleString()}` : "…"}</b>
              </div>
              <div>
                <label>Protocol</label>
                <b className={deploy?.ready ? "up" : "moon"}>{deploy ? (deploy.ready ? "Live" : "Not deployed") : "…"}</b>
              </div>
            </div>
          </aside>
        </div>
      </header>

      <section>
        <div className="wrap">
          <div className="toolbar">
            <div className="chips" role="tablist" aria-label="Filter by hook">
              <button className={`chip ${kind === null ? "on" : ""}`} onClick={() => setKind(null)}>
                🔥 All
              </button>
              {KINDS.map((k, i) => (
                <button key={k} className={`chip ${kind === i ? "on" : ""}`} onClick={() => setKind(i)}>
                  <span className={`k k-${i}`} /> {k}
                </button>
              ))}
            </div>
            <div className="search">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <input placeholder="Search name, ticker or CA" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search launches" />
            </div>
            <div className="chips" style={{ flex: "0 0 auto" }}>
              {(
                [
                  ["new", "New"],
                  ["mcap", "MCap"],
                  ["gain", "Gainers"],
                ] as const
              ).map(([v, l]) => (
                <button key={v} className={`chip ${sort === v ? "on" : ""}`} onClick={() => setSort(v)}>
                  ⇅ {l}
                </button>
              ))}
            </div>
            <div className="viewtoggle" role="radiogroup" aria-label="View">
              <button className={view === "list" ? "on" : ""} onClick={() => setView("list")} aria-label="List view">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
                </svg>
              </button>
              <button className={view === "grid" ? "on" : ""} onClick={() => setView("grid")} aria-label="Grid view">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <rect x="3" y="3" width="7" height="7" />
                  <rect x="14" y="3" width="7" height="7" />
                  <rect x="3" y="14" width="7" height="7" />
                  <rect x="14" y="14" width="7" height="7" />
                </svg>
              </button>
            </div>
          </div>

          {!deploy && <p className="muted">Checking Robinhood Chain…</p>}
          {deploy && !deploy.ready && (
            <div className="empty">
              <h3>Protocol not deployed yet</h3>
              <p className="muted">Six contracts go to fixed, precomputed addresses. Anyone with a little ETH on Robinhood Chain can deploy them.</p>
              <a className="btn primary" href="#/deploy">
                Open deploy
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
                Create token
              </a>
            </div>
          )}

          {rows.length > 0 && view === "list" && (
            <div className="board">
              <table>
                <thead>
                  <tr>
                    <th>Coin</th>
                    <th>Price</th>
                    <th>Pay token</th>
                    <th>MCap</th>
                    <th>Tax</th>
                    <th>Hook</th>
                    <th>Hook fee</th>
                    <th>Created</th>
                    <th>Creator</th>
                    <th style={{ textAlign: "right" }}>Since launch</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ l, a, price, mcap, chg }) => (
                    <tr key={l.id} onClick={() => go(`/t/${l.id}`)}>
                      <td>
                        <a className="coin" href={`#/t/${l.id}`} onClick={(e) => e.stopPropagation()} style={{ color: "inherit" }}>
                          <Avatar src={l.imageURI} label={l.symbol} size={34} />
                          <span className="coin-name">
                            <b>${l.symbol}</b>
                            <span>{l.name}</span>
                          </span>
                        </a>
                      </td>
                      <td>
                        <b>
                          <Price value={price} />
                        </b>
                      </td>
                      <td>
                        <span className="pay">
                          <i /> {a?.symbol ?? "…"}
                        </span>
                      </td>
                      <td>
                        {fmtNum(mcap)} <span className="dim">{a?.symbol}</span>
                      </td>
                      <td>
                        <span className="tax" title="Buy 2% (1% creator + 1% platform) / sell 2% (platform), paid in ETH">
                          2%/2%
                        </span>
                      </td>
                      <td>
                        <KindBadge kind={l.kind} />
                      </td>
                      <td className="dim">{HOOK_LINE[l.kind]}</td>
                      <td className="dim">{ago(l.createdAt)}</td>
                      <td className="dim">{short(l.creator)}</td>
                      <td style={{ textAlign: "right" }}>
                        <Chg v={chg} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {rows.length > 0 && view === "grid" && (
            <div className="grid">
              {rows.map(({ l, a, price, mcap, chg }) => (
                <a key={l.id} className="card" href={`#/t/${l.id}`}>
                  <div className="card-top">
                    <Avatar src={l.imageURI} label={l.symbol} size={44} />
                    <div className="card-title">
                      <b>${l.symbol}</b>
                      <span className="dim" style={{ fontSize: 12 }}>
                        {l.name}
                      </span>
                    </div>
                    <KindBadge kind={l.kind} />
                  </div>
                  {l.description && <p className="card-desc">{l.description}</p>}
                  <div className="card-stats">
                    <div>
                      <label>MCap</label>
                      <b>
                        {fmtNum(mcap)} {a?.symbol}
                      </b>
                    </div>
                    <div>
                      <label>Price</label>
                      <b>
                        <Price value={price} />
                      </b>
                    </div>
                    <div>
                      <label>Since launch</label>
                      <b className={chg > 0.005 ? "up" : chg < -0.005 ? "down" : ""}>{isFinite(chg) ? `${chg > 0 ? "+" : ""}${chg.toFixed(1)}%` : "—"}</b>
                    </div>
                  </div>
                </a>
              ))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
