import { useEffect, useMemo, useState } from "react";
import { decodeEventLog, isAddress, type Address } from "viem";
import { tideLauncherAbi } from "../lib/abis";
import { go, useApp } from "../lib/appContext";
import { ADDR, ETH } from "../lib/chain";
import { KINDS, KIND_BLURB, readAsset, type Asset } from "../lib/data";
import { floorTickFor, fmtNum, mcapForStartTick, startTickForMcap } from "../lib/price";
import { errMsg, sendTx } from "../lib/tx";
import { Avatar, Spinner } from "../components/bits";

const KIND_DETAIL = [
  ["Instant swaps pay 1%", "Committed swaps fall to 0.05% after 1h", "No early commits for snipers"],
  ["0.30% near the average price", "Up to 5% for pushing it further away", "0.05% for swaps that pull it back"],
  ["1% pool fee", "Creator tokens vest only while price ≥ floor", "Anyone can burn them if the floor breaks"],
  ["0.05% while NYSE is open", "0.30% in extended hours, 1% overnight", "2% at weekends and on holidays"],
];

export function LaunchPage() {
  const { requireWallet, toast, deploy } = useApp();
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [image, setImage] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState(0);
  const [quoteMode, setQuoteMode] = useState<"eth" | "erc20">("eth");
  const [quoteAddr, setQuoteAddr] = useState("");
  const [asset, setAsset] = useState<Asset | null>({ address: ETH, symbol: "ETH", decimals: 18 });
  const [mcap, setMcap] = useState("3");
  const [creatorPct, setCreatorPct] = useState(5);
  const [floorX, setFloorX] = useState(2);
  const [vestDays, setVestDays] = useState(30);
  const [graceHours, setGraceHours] = useState(24);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (quoteMode === "eth") return setAsset({ address: ETH, symbol: "ETH", decimals: 18 });
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

  const mcapNum = Number(mcap);
  const plan = useMemo(() => {
    if (!asset || !(mcapNum > 0)) return null;
    const startTick = startTickForMcap(mcapNum, asset.decimals);
    if (!isFinite(startTick) || Math.abs(startTick) > 880_000) return null;
    return { startTick, actualMcap: mcapForStartTick(startTick, asset.decimals), floorTick: floorTickFor(startTick, floorX) };
  }, [asset, mcapNum, floorX]);

  const isBond = kind === 2;
  const bondInvalid = isBond && creatorPct === 0;
  const errors = [
    !name.trim() && "name",
    !symbol.trim() && "symbol",
    !plan && "starting market cap",
    quoteMode === "erc20" && !asset && "quote token",
    bondInvalid && "Bond needs a creator allocation",
  ].filter(Boolean) as string[];

  async function submit() {
    const session = requireWallet();
    if (!session || !plan || !asset || errors.length) return;
    setBusy(true);
    try {
      const receipt = await sendTx(session, {
        address: ADDR.launcher,
        abi: tideLauncherAbi,
        functionName: "launch",
        args: [
          {
            name: name.trim(),
            symbol: symbol.trim().toUpperCase(),
            imageURI: image.trim(),
            description: description.trim(),
            kind,
            quote: asset.address,
            startTick: plan.startTick,
            creatorBps: Math.round(creatorPct * 100),
            floorTick: plan.floorTick,
            vestDuration: BigInt(vestDays * 86400),
            grace: BigInt(graceHours * 3600),
          },
        ],
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
            Launch a token <em>in one transaction.</em>
          </h2>
          <p className="section-lede">
            1,000,000,000 tokens are minted. Everything you don't keep becomes single-sided liquidity in a Uniswap v4 pool,
            locked forever. You earn that pool's swap fees.
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
            <div className="field">
              <label>
                <span>Image URL</span>
                <span className="dim">https:// or ipfs://</span>
              </label>
              <input className="input mono" maxLength={256} value={image} onChange={(e) => setImage(e.target.value)} placeholder="https://…/logo.png" />
            </div>
            <div className="field">
              <label>
                <span>Description</span>
                <span className="dim">{description.length}/512</span>
              </label>
              <textarea className="input" rows={3} maxLength={512} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this token for?" />
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
                <div className="seg">
                  <button type="button" className={quoteMode === "eth" ? "on" : ""} onClick={() => setQuoteMode("eth")}>
                    ETH
                  </button>
                  <button type="button" className={quoteMode === "erc20" ? "on" : ""} onClick={() => setQuoteMode("erc20")}>
                    Any token (e.g. a stock token)
                  </button>
                </div>
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
              <div className="field">
                <label>
                  <span>Your allocation</span>
                  <span className="mono">{creatorPct}%</span>
                </label>
                <input type="range" min={0} max={20} step={1} value={creatorPct} onChange={(e) => setCreatorPct(Number(e.target.value))} aria-label="Creator allocation" style={{ ["--p" as string]: `${(creatorPct / 20) * 100}%` }} />
              </div>
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
                    <input className="input mono" type="number" min={1} max={365} value={vestDays} onChange={(e) => setVestDays(Math.max(1, Number(e.target.value) || 1))} />
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
            <Avatar src={image} label={symbol || "??"} size={56} />
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
            <dd className="mono">{fmtNum(1e9 * (1 - creatorPct / 100))} tokens</dd>
            <dt>Your allocation</dt>
            <dd className="mono">
              {fmtNum(1e9 * (creatorPct / 100))} {isBond ? "(bonded)" : "(sent to you)"}
            </dd>
            <dt>Start market cap</dt>
            <dd className="mono">{plan ? `${fmtNum(plan.actualMcap)} ${asset?.symbol}` : "—"}</dd>
            <dt>Start price</dt>
            <dd className="mono">{plan ? `${(plan.actualMcap / 1e9).toExponential(3)} ${asset?.symbol}` : "—"}</dd>
            <dt>Pool fee</dt>
            <dd>{["1% → 0.05%", "0.05%–5%", "1%", "0.05%–2%"][kind]}</dd>
          </dl>
          <button className="btn primary block" disabled={busy || errors.length > 0 || !deploy?.ready} onClick={submit}>
            {busy ? (
              <>
                <Spinner /> Launching…
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
            <p className="note">One transaction. Only gas: there's no launch fee.</p>
          )}
        </aside>
      </div>
    </section>
  );
}
