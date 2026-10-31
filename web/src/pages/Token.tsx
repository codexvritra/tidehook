import { useEffect, useMemo, useState } from "react";
import { formatUnits } from "viem";
import { useApp } from "../lib/appContext";
import { explorer, explorerTx } from "../lib/chain";
import { KINDS, KIND_BLURB, balanceOf, readAsset, readLaunch, readPending, readRenames, readTrades, usePoll, type Asset } from "../lib/data";
import { short } from "../lib/format";
import { poolIdOf } from "../lib/pool";
import { fmtNum, marketCap, priceAtTick, tokenPrice } from "../lib/price";
import { Avatar, KindBadge, Price, Spinner } from "../components/bits";
import { PriceChart } from "../components/Chart";
import { BondPanel, PatiencePanel, SessionPanel, SpringPanel } from "../components/HookPanels";
import { Swap } from "../components/Swap";
import { ManagePanel, PendingBanner } from "../components/Manage";
import { EarningsPanel } from "../components/Earnings";
import { Copy } from "../components/ui";

export function TokenPage({ id }: { id: number }) {
  const { session, deploy } = useApp();
  const [launch, err, reload] = usePoll(() => readLaunch(id), 8_000, [id, deploy?.ready]);
  const [asset, setAsset] = useState<Asset>();
  useEffect(() => {
    if (launch) readAsset(launch.quote).then(setAsset).catch(() => setAsset(undefined));
  }, [launch?.quote]); // eslint-disable-line react-hooks/exhaustive-deps

  const poolId = useMemo(() => (launch ? poolIdOf(launch.key) : undefined), [launch?.id, launch?.migrations]); // eslint-disable-line react-hooks/exhaustive-deps
  const [trades, , reloadTrades] = usePoll(
    () => (launch && poolId ? readTrades(poolId, launch.createdBlock, launch.tokenIsCurrency0) : Promise.resolve([])),
    15_000,
    [poolId],
  );
  const [myBal, , reloadBal] = usePoll(() => (session && launch ? balanceOf(launch.token, session.account) : Promise.resolve(0n)), 12_000, [session?.account, launch?.token]);

  const isCreator = !!session && !!launch && session.account.toLowerCase() === launch.creator.toLowerCase();
  const [tab, setTab] = useState<"trades" | "hook">("trades");
  const [pending, , reloadPending] = usePoll(() => readPending(id), 20_000, [id, deploy?.ready]);
  const [renames] = usePoll(() => (launch ? readRenames(id, launch.createdBlock) : Promise.resolve([])), 60_000, [id, launch?.renamedAt]);
  const [pendingQuote, setPendingQuote] = useState("…");
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
  const points = [{ t: 0, p: startPrice }, ...(trades ?? []).map((t, i) => ({ t: i + 1, p: tokenPrice(t.sqrtPriceX96, l.tokenIsCurrency0, asset.decimals) }))];
  const volume = (trades ?? []).reduce((s, t) => s + Number(formatUnits(t.quoteAmount, asset.decimals)), 0);
  const refresh = () => {
    reload();
    reloadTrades();
    reloadBal();
    reloadPending();
  };

  const panelProps = { launch: l, asset, poolId, onChanged: refresh };
  const HookPanel = [PatiencePanel, SpringPanel, BondPanel, SessionPanel][l.kind];
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
              <span>
                CA {short(l.token)} <Copy text={l.token} />
              </span>
              <span>·</span>
              <span>CREATED BY {isCreator ? "YOU" : short(l.creator)}</span>
              <span>·</span>
              <a href={explorer(l.token)} target="_blank" rel="noreferrer">
                EXPLORER ↗
              </a>
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
              {fmtNum(marketCap(price))} {asset.symbol}
            </b>
          </div>
          <div>
            <label>Volume</label>
            <b>
              {fmtNum(volume)} {asset.symbol}
            </b>
          </div>
          <div>
            <label>Trades</label>
            <b>{trades ? trades.length : "…"}</b>
          </div>
          <div>
            <label>Liquidity</label>
            <b className="up">Locked ∞</b>
          </div>
        </div>
      </div>

      <div className="tgrid">
        <div className="tmain">
          <div className="panel chart-panel">
            <div className="chart-head">
              <b>
                {l.symbol}/{asset.symbol}
              </b>
              <span>Price per trade · from PoolManager swaps</span>
              <span style={{ marginLeft: "auto" }}>
                Launch <Price value={startPrice} />
              </span>
            </div>
            <div className="chart-box">
              <PriceChart points={points} symbol={l.symbol} />
            </div>
          </div>

          <div className="tabs" role="tablist">
            <button className={tab === "trades" ? "on" : ""} onClick={() => setTab("trades")}>
              Txns {trades ? `(${trades.length})` : ""}
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
                      <th>Type</th>
                      <th>Price</th>
                      <th>{asset.symbol}</th>
                      <th>{l.symbol}</th>
                      <th>Fee</th>
                      <th>Tx</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...trades]
                      .reverse()
                      .slice(0, 60)
                      .map((t) => (
                        <tr key={t.tx + t.tokenAmount}>
                          <td className={t.buy ? "up" : "down"}>
                            <b>{t.buy ? "BUY" : "SELL"}</b>
                          </td>
                          <td className={t.buy ? "up" : "down"}>
                            <Price value={tokenPrice(t.sqrtPriceX96, l.tokenIsCurrency0, quoteDec)} />
                          </td>
                          <td>{fmtNum(Number(formatUnits(t.quoteAmount, quoteDec)))}</td>
                          <td>{fmtNum(Number(formatUnits(t.tokenAmount, 18)))}</td>
                          <td className="dim">{(t.fee / 10_000).toFixed(2)}%</td>
                          <td>
                            <a href={explorerTx(t.tx)} target="_blank" rel="noreferrer">
                              {short(t.tx)}
                            </a>
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

          {isCreator && <EarningsPanel asset={asset} mode="creator" />}

          {isCreator && <ManagePanel launch={l} pending={pending ?? null} onChanged={refresh} />}


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
              <dt>MCap</dt>
              <dd>
                {fmtNum(marketCap(price))} {asset.symbol}
              </dd>
              <dt>Launch MCap</dt>
              <dd>
                {fmtNum(marketCap(startPrice))} {asset.symbol}
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
              <dt>Created</dt>
              <dd>{new Date(l.createdAt * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC</dd>
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
