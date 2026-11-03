import { useEffect, useMemo, useState } from "react";
import { formatUnits } from "viem";
import { useApp } from "../lib/appContext";
import { ADDR, POOL_MANAGER, explorer, explorerTx } from "../lib/chain";
import { KINDS, KIND_BLURB, balanceOf, readAsset, readHolders, readLaunch, readPending, readRenames, readTrades, usePoll, type Asset, type Trade } from "../lib/data";
import { short } from "../lib/format";
import { poolIdOf } from "../lib/pool";
import { fmtNum, marketCap, priceAtTick, tokenPrice } from "../lib/price";
import { Avatar, KindBadge, Price, Spinner } from "../components/bits";
import { CandleChart } from "../components/CandleChart";
import { useChainNow } from "../lib/wallet";
import { BondPanel, PatiencePanel, SessionPanel, SpringPanel } from "../components/HookPanels";
import { Swap } from "../components/Swap";
import { CreatorTransfer, ManagePanel, PendingBanner } from "../components/Manage";
import { EarningsPanel } from "../components/Earnings";
import { VetoPanel } from "../components/Veto";
import { OrdersPanel } from "../components/Orders";
import { Copy } from "../components/ui";
import { useTokenMeta } from "../lib/media";
import { useUsdPrices } from "../lib/usd";
import { Money } from "../components/Money";

export function TokenPage({ id }: { id: number }) {
  const { session, deploy } = useApp();
  const [launch, err, reload] = usePoll(() => readLaunch(id), 8_000, [id, deploy?.ready]);
  const [asset, setAsset] = useState<Asset>();
  useEffect(() => {
    if (launch) readAsset(launch.quote).then(setAsset).catch(() => setAsset(undefined));
  }, [launch?.quote]); // eslint-disable-line react-hooks/exhaustive-deps

  const poolId = useMemo(() => (launch ? poolIdOf(launch.key) : undefined), [launch?.id, launch?.migrations]); // eslint-disable-line react-hooks/exhaustive-deps
  const [trades, , reloadTrades] = usePoll(
    () => (launch && poolId ? readTrades(poolId, launch.createdBlock, launch.tokenIsCurrency0, launch.id) : Promise.resolve([])),
    15_000,
    [poolId],
  );
  const [myBal, , reloadBal] = usePoll(() => (session && launch ? balanceOf(launch.token, session.account) : Promise.resolve(0n)), 12_000, [session?.account, launch?.token]);

  const isCreator = !!session && !!launch && session.account.toLowerCase() === launch.creator.toLowerCase();
  const [tab, setTab] = useState<"trades" | "holders" | "traders" | "hook">("trades");
  const [holders] = usePoll(() => (launch ? readHolders(launch.token, launch.createdBlock, launch.id) : Promise.resolve([])), 30_000, [launch?.token]);
  const now = useChainNow(5000);
  const usd = useUsdPrices();
  const traders = useTraders(trades ?? [], asset?.decimals ?? 18);
  const [pending, , reloadPending] = usePoll(() => readPending(id), 20_000, [id, deploy?.ready]);
  const [renames] = usePoll(() => (launch ? readRenames(id, launch.createdBlock) : Promise.resolve([])), 60_000, [id, launch?.renamedAt]);
  const [pendingQuote, setPendingQuote] = useState("…");
  const tokenMeta = useTokenMeta(launch?.imageURI);
  useEffect(() => {
    if (pending) readAsset(pending.quote).then((a) => setPendingQuote(a.symbol)).catch(() => setPendingQuote("?"));
  }, [pending?.quote]); // eslint-disable-line react-hooks/exhaustive-deps

  if (err && !launch)
    return (
      <section className="tight">
        <div className="wrap">
          <div className="empty">
            <h3>Launch #{id} not found</h3>
            <a className="btn" href="#/">
              Back to Explore
            </a>
          </div>
        </div>
      </section>
    );
  if (!launch || !asset || !poolId)
    return (
      <section className="tight">
        <div className="wrap">
          <p className="muted">
            <Spinner /> Reading launch #{id} from Robinhood Chain…
          </p>
        </div>
      </section>
    );

  const l = launch;
  const price = tokenPrice(l.sqrtPriceX96, l.tokenIsCurrency0, asset.decimals);
  const startPrice = priceAtTick(l.tokenIsCurrency0 ? l.tickLower : l.tickUpper, l.tokenIsCurrency0, asset.decimals);
  const change = startPrice > 0 ? (price / startPrice - 1) * 100 : 0;
  const q = (t: Trade) => Number(formatUnits(t.quoteAmount, asset.decimals));
  const ticks = [
    { time: l.createdAt, price: startPrice, volume: 0, buy: true },
    ...(trades ?? []).map((t) => ({ time: Math.max(t.time, l.createdAt), price: tokenPrice(t.sqrtPriceX96, l.tokenIsCurrency0, asset.decimals), volume: q(t), buy: t.buy })),
  ];
  const vol24 = (trades ?? []).filter((t) => t.time > now - 86400).reduce((s, t) => s + q(t), 0);
  const label = (a: string) => {
    const x = a.toLowerCase();
    if (x === POOL_MANAGER.toLowerCase()) return "Pool (locked liquidity)";
    if (x === "0x000000000000000000000000000000000000dead") return "Burned";
    if (x === ADDR.bond.toLowerCase()) return "Creator bond (vesting)";
    if (x === l.creator.toLowerCase()) return `${short(a)} (creator)`;
    if (session && x === session.account.toLowerCase()) return `${short(a)} (you)`;
    return short(a);
  };
  const mcap = marketCap(price);
  const refresh = () => {
    reload();
    reloadTrades();
    reloadBal();
    reloadPending();
  };

  const panelProps = { launch: l, asset, poolId, onChanged: refresh };
  const HookPanel = [PatiencePanel, SpringPanel, BondPanel, SessionPanel][l.kind];
  const meta = tokenMeta;
  const quoteDec = asset.decimals;

  return (
    <div className="terminal">
      <PendingBanner pending={pending ?? null} quoteSymbol={pendingQuote} />
      <div className="tbar">
        <div className="tbar-id">
          <Avatar src={l.imageURI} label={l.symbol} size={46} />
          <div style={{ minWidth: 0 }}>
            <h2>
              ${l.symbol} <span>{l.name}</span> <KindBadge kind={l.kind} />
              {renames && renames.length > 0 && (
                <span className="pill moon" title={`Rename history: ${renames.map((r) => `$${r.symbol} (${r.name})`).join(" → ")}`}>
                  Renamed ×{renames.length}
                </span>
              )}
              {l.migrations > 0 && <span className="pill tide">Migrated ×{l.migrations}</span>}
            </h2>
            <div className="tbar-meta">
              <span className="tag-b">
                CA{" "}
                <a href={explorer(l.token)} target="_blank" rel="noreferrer">
                  {short(l.token)}
                </a>{" "}
                <Copy text={l.token} />
              </span>
              <span className="tag-b">
                CREATED BY{" "}
                <a href={explorer(l.creator)} target="_blank" rel="noreferrer">
                  {isCreator ? "YOU" : short(l.creator)}
                </a>
              </span>
              {meta.x && (
                <a className="soc" href={`https://x.com/${meta.x}`} target="_blank" rel="noreferrer noopener" title={`@${meta.x} on X`} aria-label="X">
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
                    <path d="M18.9 2H22l-6.8 7.8L23 22h-6.2l-4.8-6.3L6.4 22H3.3l7.3-8.3L1 2h6.3l4.4 5.8L18.9 2Zm-1.1 18h1.7L6.3 3.9H4.5L17.8 20Z" />
                  </svg>
                </a>
              )}
              {meta.website && (
                <a className="soc" href={meta.website} target="_blank" rel="noreferrer noopener nofollow" title={meta.website} aria-label="Website">
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
                  </svg>
                </a>
              )}
            </div>
          </div>
        </div>
        <div className="tbar-price">
          <b>
            <Price value={price} />{" "}
            <span className="dim" style={{ fontSize: 12 }}>
              {asset.symbol}
            </span>
          </b>
          <span className={change > 0.005 ? "up" : change < -0.005 ? "down" : "dim"}>
            {change > 0.005 ? "+" : ""}
            {Math.abs(change) < 0.005 ? "0.00" : change.toFixed(2)}% since {l.migrations > 0 ? "migration" : "launch"}
          </span>
        </div>
        <div className="tbar-stats">
          <div>
            <label>MCap</label>
            <b>
              <Money amount={mcap} quote={l.quote} symbol={asset.symbol} prices={usd} />
            </b>
          </div>
          <div>
            <label>24h Vol</label>
            <b>
              <Money amount={vol24} quote={l.quote} symbol={asset.symbol} prices={usd} />
            </b>
          </div>
          <div>
            <label>Liquidity</label>
            <b className="up">Locked ∞</b>
          </div>
          <div>
            <label>Holders</label>
            <b>{holders ? holders.length : "…"}</b>
          </div>
          <div>
            <label>Taxes</label>
            <b>2%/2%</b>
          </div>
        </div>
      </div>

      <div className="tgrid">
        <div className="tmain">
          <div className="chart-panel">
            <CandleChart ticks={ticks} symbol={l.symbol} quote={asset.symbol} supply={1e9} usd={usd.get(l.quote.toLowerCase())} />
          </div>

          <div className="tabs" role="tablist">
            <button className={tab === "trades" ? "on" : ""} onClick={() => setTab("trades")}>
              Txns {trades ? `(${trades.length})` : ""}
            </button>
            <button className={tab === "holders" ? "on" : ""} onClick={() => setTab("holders")}>
              Holders {holders ? `(${holders.length})` : ""}
            </button>
            <button className={tab === "traders" ? "on" : ""} onClick={() => setTab("traders")}>
              Traders {trades ? `(${traders.length})` : ""}
            </button>
            <button className={tab === "hook" ? "on" : ""} onClick={() => setTab("hook")}>
              {KINDS[l.kind]} hook
            </button>
          </div>

          {tab === "hook" && (
            <div style={{ padding: 16 }}>
              <HookPanel {...panelProps} />
            </div>
          )}

          {tab === "trades" && (
            <div className="trades">
              {!trades ? (
                <p className="muted" style={{ padding: 16 }}>
                  Loading…
                </p>
              ) : trades.length === 0 ? (
                <p className="muted" style={{ padding: 16, margin: 0 }}>
                  No trades yet. Be the first buyer.
                </p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Age</th>
                      <th>Type</th>
                      <th>Price</th>
                      <th>{asset.symbol}</th>
                      <th>{l.symbol}</th>
                      <th>Trader</th>
                      <th>Tx</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...trades]
                      .reverse()
                      .slice(0, 100)
                      .map((t) => (
                        <tr key={t.tx + t.tokenAmount} className={t.buy ? "row-buy" : "row-sell"}>
                          <td className="dim">{age(now - t.time)}</td>
                          <td className={t.buy ? "up" : "down"}>
                            <b>{t.buy ? "BUY" : "SELL"}</b>
                          </td>
                          <td className={t.buy ? "up" : "down"}>
                            <Price value={tokenPrice(t.sqrtPriceX96, l.tokenIsCurrency0, quoteDec)} />
                          </td>
                          <td className={t.buy ? "up" : "down"}>{fmtNum(q(t))}</td>
                          <td>{fmtNum(Number(formatUnits(t.tokenAmount, 18)))}</td>
                          <td>
                            <a href={explorer(t.trader)} target="_blank" rel="noreferrer">
                              {label(t.trader)}
                            </a>
                          </td>
                          <td>
                            <a href={explorerTx(t.tx)} target="_blank" rel="noreferrer">
                              {short(t.tx)} ↗
                            </a>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {tab === "holders" && (
            <div className="trades">
              {!holders ? (
                <p className="muted" style={{ padding: 16 }}>
                  Loading…
                </p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Holder</th>
                      <th>Share</th>
                      <th>{l.symbol}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {holders.slice(0, 100).map((h, i) => {
                      const pct = Number((h.amount * 1_000_000n) / 10n ** 27n) / 10_000;
                      return (
                        <tr key={h.address}>
                          <td className="dim">{i + 1}</td>
                          <td>
                            <a href={explorer(h.address)} target="_blank" rel="noreferrer">
                              {label(h.address)}
                            </a>
                          </td>
                          <td>
                            <span className="pct-bar" style={{ ["--w" as string]: `${Math.min(100, pct)}%` }}>
                              {pct.toFixed(2)}%
                            </span>
                          </td>
                          <td>{fmtNum(Number(formatUnits(h.amount, 18)))}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {tab === "traders" && (
            <div className="trades">
              {traders.length === 0 ? (
                <p className="muted" style={{ padding: 16, margin: 0 }}>
                  No traders yet.
                </p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Trader</th>
                      <th>Buys</th>
                      <th>Sells</th>
                      <th>Bought ({asset.symbol})</th>
                      <th>Sold ({asset.symbol})</th>
                      <th>Net ({asset.symbol})</th>
                    </tr>
                  </thead>
                  <tbody>
                    {traders.slice(0, 100).map((t) => (
                      <tr key={t.address}>
                        <td>
                          <a href={explorer(t.address)} target="_blank" rel="noreferrer">
                            {label(t.address)}
                          </a>
                        </td>
                        <td className="up">{t.buys}</td>
                        <td className="down">{t.sells}</td>
                        <td>{fmtNum(t.bought)}</td>
                        <td>{fmtNum(t.sold)}</td>
                        <td className={t.sold - t.bought >= 0 ? "up" : "down"}>
                          {t.sold - t.bought >= 0 ? "+" : ""}
                          {fmtNum(t.sold - t.bought)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>

        <aside className="tside">
          <Swap launch={l} asset={asset} poolId={poolId} onTraded={refresh} />
          <OrdersPanel launch={l} asset={asset} poolId={poolId} onChanged={refresh} />
          <VetoPanel launch={l} pending={pending ?? null} onChanged={refresh} />

          {isCreator && <EarningsPanel asset={asset} mode="creator" />}

          {isCreator && <ManagePanel launch={l} pending={pending ?? null} onChanged={refresh} />}
          <CreatorTransfer launch={l} onChanged={refresh} />


          {l.description && (
            <div className="panel">
              <div className="panel-head">
                <span className="tag">Description</span>
              </div>
              <p className="muted" style={{ margin: 0, fontSize: 12, whiteSpace: "pre-wrap" }}>
                {l.description}
              </p>
            </div>
          )}

          <div className="panel">
            <div className="panel-head">
              <span className="tag">Token info</span>
            </div>
            <dl className="kv">
              <dt>24h Vol</dt>
              <dd>
                <Money amount={vol24} quote={l.quote} symbol={asset.symbol} prices={usd} />
              </dd>
              <dt>MCap</dt>
              <dd>
                <Money amount={mcap} quote={l.quote} symbol={asset.symbol} prices={usd} />
              </dd>
              <dt>FDV</dt>
              <dd>
                <Money amount={mcap} quote={l.quote} symbol={asset.symbol} prices={usd} />
              </dd>
              <dt>Holders</dt>
              <dd>{holders ? holders.length : "…"}</dd>
              <dt>Change</dt>
              <dd className={change >= 0 ? "up" : "down"}>
                {change >= 0 ? "+" : ""}
                {change.toFixed(2)}%
              </dd>
              <dt>Launch MCap</dt>
              <dd>
                <Money amount={marketCap(startPrice)} quote={l.quote} symbol={asset.symbol} prices={usd} />
              </dd>
              <dt>Max supply</dt>
              <dd>1,000,000,000</dd>
              <dt>You hold</dt>
              <dd>{session ? fmtNum(Number(formatUnits(myBal ?? 0n, 18))) : "—"}</dd>
              <dt>Hook</dt>
              <dd>
                <a href={explorer(l.key.hooks)} target="_blank" rel="noreferrer">
                  {KINDS[l.kind]} {short(l.key.hooks)}
                </a>
              </dd>
              <dt>Pool id</dt>
              <dd>
                {short(poolId)} <Copy text={poolId} />
              </dd>
              <dt>Liquidity</dt>
              <dd className="up">Locked forever</dd>
              <dt>Paired with</dt>
              <dd>{asset.symbol}</dd>
              <dt>Create time</dt>
              <dd>{new Date(l.createdAt * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC</dd>
              <dt>Creator</dt>
              <dd>
                <a href={explorer(l.creator)} target="_blank" rel="noreferrer">
                  {short(l.creator)}
                </a>
              </dd>
            </dl>
            <p className="note" style={{ marginBottom: 0 }}>
              <b className="lime">{KINDS[l.kind]}:</b> {KIND_BLURB[l.kind]}
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

function age(s: number): string {
  if (s < 60) return `${Math.max(0, Math.floor(s))}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Per-wallet buys/sells from the trade list, most active first. */
function useTraders(trades: Trade[], decimals: number) {
  return useMemo(() => {
    const m = new Map<string, { address: string; buys: number; sells: number; bought: number; sold: number }>();
    for (const t of trades) {
      const k = t.trader.toLowerCase();
      const e = m.get(k) ?? { address: t.trader, buys: 0, sells: 0, bought: 0, sold: 0 };
      const v = Number(formatUnits(t.quoteAmount, decimals));
      if (t.buy) {
        e.buys++;
        e.bought += v;
      } else {
        e.sells++;
        e.sold += v;
      }
      m.set(k, e);
    }
    return [...m.values()].sort((a, b) => b.bought + b.sold - (a.bought + a.sold));
  }, [trades, decimals]);
}
