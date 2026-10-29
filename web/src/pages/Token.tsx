import { useEffect, useMemo, useState } from "react";
import { formatUnits } from "viem";
import { tideLauncherAbi } from "../lib/abis";
import { useApp } from "../lib/appContext";
import { ADDR, client, explorer, explorerTx } from "../lib/chain";
import { KINDS, KIND_BLURB, balanceOf, readAsset, readLaunch, readTrades, usePoll, type Asset } from "../lib/data";
import { short } from "../lib/format";
import { poolIdOf } from "../lib/pool";
import { fmtNum, marketCap, priceAtTick, tokenPrice } from "../lib/price";
import { errMsg, sendTx } from "../lib/tx";
import { Avatar, KindBadge, Price, Spinner } from "../components/bits";
import { PriceChart } from "../components/Chart";
import { BondPanel, PatiencePanel, SessionPanel, SpringPanel } from "../components/HookPanels";
import { Swap } from "../components/Swap";
import { Copy } from "../components/ui";

export function TokenPage({ id }: { id: number }) {
  const { session, toast, deploy } = useApp();
  const [launch, err, reload] = usePoll(() => readLaunch(id), 8_000, [id, deploy?.ready]);
  const [asset, setAsset] = useState<Asset>();
  useEffect(() => {
    if (launch) readAsset(launch.quote).then(setAsset).catch(() => setAsset(undefined));
  }, [launch?.quote]); // eslint-disable-line react-hooks/exhaustive-deps

  const poolId = useMemo(() => (launch ? poolIdOf(launch.key) : undefined), [launch?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [trades, , reloadTrades] = usePoll(
    () => (launch && poolId ? readTrades(poolId, launch.createdBlock, launch.tokenIsCurrency0) : Promise.resolve([])),
    15_000,
    [poolId],
  );
  const [myBal, , reloadBal] = usePoll(() => (session && launch ? balanceOf(launch.token, session.account) : Promise.resolve(0n)), 12_000, [session?.account, launch?.token]);

  const isCreator = !!session && !!launch && session.account.toLowerCase() === launch.creator.toLowerCase();
  const [fees, , reloadFees] = usePoll(
    async () => {
      if (!isCreator || !session) return null;
      const { result } = await client.simulateContract({ account: session.account, address: ADDR.launcher, abi: tideLauncherAbi, functionName: "collectFees", args: [BigInt(id)] });
      return result;
    },
    20_000,
    [isCreator, id],
  );
  const [collecting, setCollecting] = useState(false);

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
    reloadFees();
  };

  async function collect() {
    if (!session) return;
    setCollecting(true);
    try {
      await sendTx(session, { address: ADDR.launcher, abi: tideLauncherAbi, functionName: "collectFees", args: [BigInt(id)] });
      toast("Fees collected to your wallet.");
      reloadFees();
    } catch (e) {
      toast(errMsg(e), "err");
    } finally {
      setCollecting(false);
    }
  }

  const panelProps = { launch: l, asset, poolId, onChanged: refresh };

  return (
    <section className="tight">
      <div className="wrap">
        <div className="token-head">
          <Avatar src={l.imageURI} label={l.symbol} size={64} />
          <div className="token-title">
            <h2 style={{ margin: 0 }}>
              {l.name} <span className="mono dim">${l.symbol}</span>
            </h2>
            <div className="row" style={{ gap: 8 }}>
              <KindBadge kind={l.kind} />
              <span className="pill mono">
                {short(l.token)} <Copy text={l.token} />
              </span>
              <a className="pill" href={explorer(l.token)} target="_blank" rel="noreferrer">
                explorer ↗
              </a>
              <span className="pill">by {isCreator ? "you" : short(l.creator)}</span>
            </div>
          </div>
          <div className="token-price">
            <b className="mono"><Price value={price} /></b>
            <span className="dim">{asset.symbol} per token</span>
            <span className={change >= 0 ? "ok" : "warn"}>
              {change >= -0.005 ? "+" : ""}
              {Math.abs(change) < 0.005 ? "0.00" : change.toFixed(2)}% since launch
            </span>
          </div>
        </div>
        {l.description && <p className="section-lede" style={{ marginBottom: 20 }}>{l.description}</p>}

        <div className="token-grid">
          <div className="token-main">
            <div className="stats four">
              <div className="stat">
                <label>Market cap</label>
                <b>
                  {fmtNum(marketCap(price))} {asset.symbol}
                </b>
              </div>
              <div className="stat">
                <label>Volume</label>
                <b>
                  {fmtNum(volume)} {asset.symbol}
                </b>
              </div>
              <div className="stat">
                <label>Trades</label>
                <b>{trades ? trades.length : "…"}</b>
              </div>
              <div className="stat">
                <label>You hold</label>
                <b>{session ? fmtNum(Number(formatUnits(myBal ?? 0n, 18))) : "—"}</b>
              </div>
            </div>

            <div className="panel chart-panel">
              <PriceChart points={points} symbol={l.symbol} />
            </div>

            {l.kind === 0 && <PatiencePanel {...panelProps} />}
            {l.kind === 1 && <SpringPanel {...panelProps} />}
            {l.kind === 2 && <BondPanel {...panelProps} />}
            {l.kind === 3 && <SessionPanel {...panelProps} />}

            <div className="panel">
              <div className="panel-head">
                <span className="tag">Trades · straight from PoolManager events</span>
              </div>
              {!trades ? (
                <p className="muted">Loading…</p>
              ) : trades.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>
                  No trades yet.
                </p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Side</th>
                        <th>{l.symbol}</th>
                        <th>{asset.symbol}</th>
                        <th>Price</th>
                        <th>Fee</th>
                        <th>Tx</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...trades]
                        .reverse()
                        .slice(0, 40)
                        .map((t) => (
                          <tr key={t.tx + t.tokenAmount}>
                            <td className={t.buy ? "ok" : "warn"}>{t.buy ? "Buy" : "Sell"}</td>
                            <td className="mono">{fmtNum(Number(formatUnits(t.tokenAmount, 18)))}</td>
                            <td className="mono">{fmtNum(Number(formatUnits(t.quoteAmount, asset.decimals)))}</td>
                            <td className="mono"><Price value={tokenPrice(t.sqrtPriceX96, l.tokenIsCurrency0, asset.decimals)} /></td>
                            <td className="mono dim">{(t.fee / 10_000).toFixed(2)}%</td>
                            <td>
                              <a className="mono" href={explorerTx(t.tx)} target="_blank" rel="noreferrer">
                                {short(t.tx)}
                              </a>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <aside className="token-side">
            <Swap launch={l} asset={asset} poolId={poolId} onTraded={refresh} />

            {isCreator && (
              <div className="panel">
                <div className="panel-head">
                  <span className="tag">Creator · locked-liquidity fees</span>
                </div>
                <p className="muted" style={{ marginTop: 0 }}>
                  Your launch liquidity is locked in the launcher forever and earns every swap fee. Collect them any time.
                </p>
                <dl className="kv">
                  <dt>{l.tokenIsCurrency0 ? l.symbol : asset.symbol}</dt>
                  <dd className="mono">{fees ? fmtNum(Number(formatUnits(fees[0], l.tokenIsCurrency0 ? 18 : asset.decimals))) : "…"}</dd>
                  <dt>{l.tokenIsCurrency0 ? asset.symbol : l.symbol}</dt>
                  <dd className="mono">{fees ? fmtNum(Number(formatUnits(fees[1], l.tokenIsCurrency0 ? asset.decimals : 18))) : "…"}</dd>
                </dl>
                <button className="btn primary block" disabled={collecting || !fees || fees[0] + fees[1] === 0n} onClick={collect}>
                  {collecting ? <Spinner /> : "Collect fees"}
                </button>
              </div>
            )}

            <div className="panel">
              <div className="panel-head">
                <span className="tag">About this pool</span>
              </div>
              <p className="muted" style={{ marginTop: 0 }}>
                <b>{KINDS[l.kind]}:</b> {KIND_BLURB[l.kind]}
              </p>
              <dl className="kv">
                <dt>Hook</dt>
                <dd>
                  <a className="mono" href={explorer(l.key.hooks)} target="_blank" rel="noreferrer">
                    {short(l.key.hooks)}
                  </a>
                </dd>
                <dt>Pool id</dt>
                <dd className="mono">
                  {short(poolId)} <Copy text={poolId} />
                </dd>
                <dt>Liquidity</dt>
                <dd>Locked forever</dd>
                <dt>Supply</dt>
                <dd className="mono">1,000,000,000</dd>
                <dt>Paired with</dt>
                <dd>{asset.symbol}</dd>
              </dl>
            </div>
          </aside>
        </div>
      </div>
    </section>
  );
}
