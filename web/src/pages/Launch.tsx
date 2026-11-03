import { useEffect, useMemo, useState } from "react";
import { decodeEventLog, isAddress, type Address } from "viem";
import { tideLauncherAbi } from "../lib/abis";
import { go, useApp } from "../lib/appContext";
import { ADDR, ETH } from "../lib/chain";
import { PAIR_ASSETS } from "../lib/stocks";
import { poolIdOf, sqrtPriceOf } from "../lib/pool";
import { KINDS, KIND_BLURB, readAsset, type Asset } from "../lib/data";
import { floorTickFor, fmtNum, mcapForStartTick, startTickForMcap } from "../lib/price";
import { errMsg, sendTx } from "../lib/tx";
import { usd, useEthUsd } from "../lib/ethPrice";
import { client } from "../lib/chain";
import { usePoll } from "../lib/data";
import { formatEther } from "viem";
import { Avatar, Spinner } from "../components/bits";
import { MediaFields } from "../components/MediaFields";
import { cleanWebsite, cleanX, mediaErrors, storeMeta, type MediaDraft } from "../lib/media";

const KIND_DETAIL = [
  ["Flat 2% per trade, no LP fee", "Optional commit-reveal swaps hide size", "No early commits for snipers"],
  ["Flat 2% per trade, no LP fee", "Tracks an on-chain rest price", "Movable to another hook or pair later"],
  ["Flat 2% per trade, no LP fee", "Only kind with a creator allocation (≥30d vest)", "Anyone can burn it if the floor breaks"],
  ["Flat 2% per trade, no LP fee", "Built for tokenized-stock pairs", "Trades 24/7"],
];

export function LaunchPage() {
  const { requireWallet, toast, deploy } = useApp();
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [media, setMedia] = useState<MediaDraft>({ image: "", x: "", website: "" });
  const [step, setStep] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState(0);
  // "eth", a PAIR_ASSETS symbol, or "erc20" for any other token address.
  const [quoteMode, setQuoteMode] = useState<string>("eth");
  const [quoteAddr, setQuoteAddr] = useState("");
  const [asset, setAsset] = useState<Asset | null>({ address: ETH, symbol: "ETH", decimals: 18 });
  const [mcap, setMcap] = useState("3");
  const [creatorPct, setCreatorPct] = useState(5);
  const [floorX, setFloorX] = useState(2);
  const [vestDays, setVestDays] = useState(30);
  const [graceHours, setGraceHours] = useState(24);
  const [busy, setBusy] = useState(false);
  const [launchFee] = usePoll(
    () => (deploy?.ready ? client.readContract({ address: ADDR.launcher, abi: tideLauncherAbi, functionName: "launchFee" }) : Promise.resolve(undefined)),
    60_000,
    [deploy?.ready],
  );
  const ethUsd = useEthUsd();
  const feeEth = launchFee !== undefined ? Number(Number(formatEther(launchFee)).toPrecision(4)) : null;

  useEffect(() => {
    if (quoteMode === "eth") return setAsset({ address: ETH, symbol: "ETH", decimals: 18 });
    const listed = PAIR_ASSETS.find((a) => a.symbol === quoteMode);
    if (listed) return setAsset({ address: listed.address, symbol: listed.symbol, decimals: listed.decimals });
    setAsset(null);
    if (!isAddress(quoteAddr)) return;
    let live = true;
    readAsset(quoteAddr as Address)
      .then((a) => live && setAsset(a))
      .catch(() => live && setAsset(null));
    return () => {
      live = false;
    };
  }, [quoteMode, quoteAddr]);

  /** Switch pair and keep the default start cap worth ~3 ETH, priced by the live ETH/asset route pool. */
  async function pickPair(mode: string) {
    setQuoteMode(mode);
    const listed = PAIR_ASSETS.find((a) => a.symbol === mode);
    if (mode === "eth") return setMcap("3");
    setMcap(""); // a number in the old unit would silently mean something else in the new one
    if (!listed?.route) return;
    try {
      const sqrt = await sqrtPriceOf(poolIdOf(listed.route));
      const perEth = (Number(sqrt) / 2 ** 96) ** 2 * 10 ** (18 - listed.decimals); // asset per ETH
      if (isFinite(perEth) && perEth > 0) setMcap(String(Number((3 * perEth).toPrecision(3))));
    } catch {
      /* leave it empty: the creator types a cap in the new unit */
    }
  }

  const mcapNum = Number(mcap);
  const plan = useMemo(() => {
    if (!asset || !(mcapNum > 0)) return null;
    const startTick = startTickForMcap(mcapNum, asset.decimals);
    if (!isFinite(startTick) || Math.abs(startTick) > 880_000) return null;
    return { startTick, actualMcap: mcapForStartTick(startTick, asset.decimals), floorTick: floorTickFor(startTick, floorX) };
  }, [asset, mcapNum, floorX]);

  const isBond = kind === 2;
  const allocPct = isBond ? creatorPct : 0; // only Bond launches may hold a (vested) creator allocation
  const bondInvalid = isBond && (creatorPct === 0 || vestDays < 30);
  const errors = [
    !name.trim() && "name",
    !symbol.trim() && "symbol",
    !plan && "starting market cap",
    quoteMode === "erc20" && !asset && "quote token",
    bondInvalid && "Bond needs an allocation vesting at least 30 days",
    ...mediaErrors(media),
  ].filter(Boolean) as string[];

  async function submit() {
    const session = requireWallet();
    if (!session || !plan || !asset || errors.length) return;
    setBusy(true);
    try {
      const hasMedia = !!(media.image || media.x.trim() || media.website.trim());
      setStep(hasMedia ? "1/2 Saving logo and links on-chain…" : null);
      const imageURI = await storeMeta(session, { image: media.image, x: cleanX(media.x), website: cleanWebsite(media.website) });
      setStep(hasMedia ? "2/2 Launching…" : null);
      const receipt = await sendTx(session, {
        address: ADDR.launcher,
        abi: tideLauncherAbi,
        functionName: "launch",
        args: [
          {
            name: name.trim(),
            symbol: symbol.trim().toUpperCase(),
            imageURI,
            description: description.trim(),
            kind,
            quote: asset.address,
            startTick: plan.startTick,
            creatorBps: Math.round(allocPct * 100),
            floorTick: plan.floorTick,
            vestDuration: BigInt(vestDays * 86400),
            grace: BigInt(graceHours * 3600),
          },
        ],
        value: launchFee ?? 0n,
      });
      const ev = receipt.logs
        .filter((l) => l.address.toLowerCase() === ADDR.launcher.toLowerCase())
        .map((l) => {
          try {
            return decodeEventLog({ abi: tideLauncherAbi, data: l.data, topics: l.topics });
          } catch {
            return null;
          }
        })
        .find((e) => e?.eventName === "Launched");
      toast(`${symbol.toUpperCase()} is live.`);
      if (ev && ev.eventName === "Launched") go(`/t/${ev.args.id}`);
    } catch (e) {
      toast(errMsg(e), "err");
    } finally {
      setBusy(false);
      setStep(null);
    }
  }

  return (
    <section className="tight">
      <div className="wrap launch">
        <div>
          <div className="kicker">
            <span className="n">New launch</span>
          </div>
          <h2>
            Launch a token <em>in minutes.</em>
          </h2>
          <p className="section-lede">
            1,000,000,000 tokens go into a Uniswap v4 pool, locked forever, with no cap. You earn 1% of every buy in ETH, and you
            can rename the coin, switch its pair or upgrade its hook later.
          </p>

          <div className="panel">
            <div className="row">
              <div className="field">
                <label>Name</label>
                <input className="input" maxLength={32} value={name} onChange={(e) => setName(e.target.value)} placeholder="Moon Tide" />
              </div>
              <div className="field" style={{ flex: "0 1 160px" }}>
                <label>Symbol</label>
                <input className="input mono" maxLength={12} value={symbol} onChange={(e) => setSymbol(e.target.value.replace(/\s/g, ""))} placeholder="TIDE" />
              </div>
            </div>
            <MediaFields value={media} onChange={setMedia} label={symbol} />
            <div className="field">
              <label>
                <span>Bio</span>
                <span className="dim">optional · {description.length}/512</span>
              </label>
              <textarea className="input" rows={3} maxLength={512} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Tell people what this coin is about" />
            </div>

            <div className="field">
              <label>Hook</label>
              <div className="kinds">
                {KINDS.map((k, i) => (
                  <button key={k} type="button" className={`kind-card ${kind === i ? "on" : ""}`} onClick={() => setKind(i)}>
                    <b>{k}</b>
                    <span>{KIND_BLURB[i]}</span>
                    <ul>
                      {KIND_DETAIL[i].map((d) => (
                        <li key={d}>{d}</li>
                      ))}
                    </ul>
                  </button>
                ))}
              </div>
            </div>

            <div className="row">
              <div className="field">
                <label>Paired with</label>
                <div className="seg pairs">
                  <button type="button" className={quoteMode === "eth" ? "on" : ""} onClick={() => pickPair("eth")}>
                    ETH
                  </button>
                  {PAIR_ASSETS.map((a) => (
                    <button key={a.symbol} type="button" className={quoteMode === a.symbol ? "on" : ""} onClick={() => pickPair(a.symbol)} title={a.name}>
                      {a.symbol}
                    </button>
                  ))}
                  <button type="button" className={quoteMode === "erc20" ? "on" : ""} onClick={() => pickPair("erc20")}>
                    Other token
                  </button>
                </div>
                {PAIR_ASSETS.find((a) => a.symbol === quoteMode) && (
                  <p className="note" style={{ margin: "6px 0 0" }}>
                    {PAIR_ASSETS.find((a) => a.symbol === quoteMode)!.name} · buyers pay and creators earn in {quoteMode}.
                  </p>
                )}
              </div>
              {quoteMode === "erc20" && (
                <div className="field">
                  <label>
                    <span>Quote token address</span>
                    <span className={asset ? "ok" : "dim"}>{asset ? `${asset.symbol} · ${asset.decimals} dec` : isAddress(quoteAddr) ? "not an ERC20?" : ""}</span>
                  </label>
                  <input className="input mono" value={quoteAddr} onChange={(e) => setQuoteAddr(e.target.value.trim())} placeholder="0x…" />
                </div>
              )}
            </div>

            <div className="row">
              <div className="field">
                <label>
                  <span>Starting market cap</span>
                  <span className="dim">{asset?.symbol}</span>
                </label>
                <input className="input mono" inputMode="decimal" value={mcap} onChange={(e) => setMcap(e.target.value)} />
              </div>
              {isBond ? (
                <div className="field">
                  <label>
                    <span>Your allocation (vested)</span>
                    <span className="mono">{creatorPct}%</span>
                  </label>
                  <input type="range" min={1} max={20} step={1} value={creatorPct} onChange={(e) => setCreatorPct(Number(e.target.value))} aria-label="Creator allocation" style={{ ["--p" as string]: `${(creatorPct / 20) * 100}%` }} />
                </div>
              ) : (
                <div className="field">
                  <label>Your allocation</label>
                  <p className="note" style={{ margin: 0 }}>None. 100% of supply goes into the pool, so there is no dev bag to dump. Want an allocation? Pick Bond: it vests for at least 30 days.</p>
                </div>
              )}
            </div>

            {isBond && (
              <div className="subpanel">
                <div className="panel-head">
                  <span className="tag">Creator bond terms</span>
                </div>
                <div className="row">
                  <div className="field">
                    <label>
                      <span>Floor</span>
                      <span className="mono">{floorX}× launch price</span>
                    </label>
                    <input type="range" min={1.1} max={10} step={0.1} value={floorX} onChange={(e) => setFloorX(Number(e.target.value))} aria-label="Floor multiple" style={{ ["--p" as string]: `${((floorX - 1.1) / 8.9) * 100}%` }} />
                  </div>
                  <div className="field">
                    <label>Vesting (days)</label>
                    <input className="input mono" type="number" min={30} max={365} value={vestDays} onChange={(e) => setVestDays(Math.max(30, Number(e.target.value) || 30))} />
                  </div>
                  <div className="field">
                    <label>Grace (hours)</label>
                    <input className="input mono" type="number" min={1} max={720} value={graceHours} onChange={(e) => setGraceHours(Math.max(1, Number(e.target.value) || 1))} />
                  </div>
                </div>
                <p className="note">
                  Your {creatorPct}% vests over {vestDays} days. You can claim only after the price has stayed above {floorX}× the launch
                  price for {graceHours}h. Once the price has reached that floor, if it then stays below it for {graceHours}h, anyone can burn
                  what you haven't claimed.
                </p>
              </div>
            )}
          </div>
        </div>

        <aside className="panel preview">
          <div className="panel-head">
            <span className="tag">Preview</span>
          </div>
          <div className="card-top">
            <Avatar src={media.image} label={symbol || "??"} size={56} />
            <div className="card-title">
              <b>{name || "Token name"}</b>
              <span className="mono dim">${symbol.toUpperCase() || "SYMBOL"}</span>
            </div>
          </div>
          <dl className="kv">
            <dt>Hook</dt>
            <dd>{KINDS[kind]}</dd>
            <dt>Supply</dt>
            <dd className="mono">1,000,000,000</dd>
            <dt>Locked liquidity</dt>
            <dd className="mono">{fmtNum(1e9 * (1 - allocPct / 100))} tokens</dd>
            <dt>Your allocation</dt>
            <dd className="mono">
              {allocPct ? `${fmtNum(1e9 * (allocPct / 100))} (bonded, vesting)` : "none"}
            </dd>
            <dt>Start market cap</dt>
            <dd className="mono">{plan ? `${fmtNum(plan.actualMcap)} ${asset?.symbol}` : "—"}</dd>
            <dt>Start price</dt>
            <dd className="mono">{plan ? `${(plan.actualMcap / 1e9).toExponential(3)} ${asset?.symbol}` : "—"}</dd>
            <dt>LP fee</dt>
            <dd>none</dd>
            <dt>Buy tax</dt>
            <dd>1% to you + 1% platform</dd>
            <dt>Sell tax</dt>
            <dd>2% platform</dd>
            <dt>Launch fee</dt>
            <dd className="lime">{feeEth !== null ? `${feeEth} ETH ${ethUsd ? `≈ ${usd(feeEth, ethUsd)}` : ""}` : "—"}</dd>
          </dl>
          <button className="btn primary block" disabled={busy || errors.length > 0 || !deploy?.ready} onClick={submit}>
            {busy ? (
              <>
                <Spinner /> {step ?? "Launching…"}
              </>
            ) : (
              "Launch on Robinhood Chain"
            )}
          </button>
          {!deploy?.ready ? (
            <p className="note">
              Contracts not deployed yet. <a href="#/deploy">Deploy them</a>.
            </p>
          ) : errors.length > 0 ? (
            <p className="note">Missing: {errors.join(", ")}</p>
          ) : (
            <p className="note">
              One transaction: launch fee {feeEth !== null ? `${feeEth} ETH` : ""} plus gas. You earn 1% of every buy in ETH, and
              can claim it from your token page any time.
            </p>
          )}
        </aside>
      </div>
    </section>
  );
}
