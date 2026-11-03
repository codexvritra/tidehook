import { useEffect, useState } from "react";
import { isAddress, type Address } from "viem";
import { tideLauncherAbi } from "../lib/abis";
import { useApp } from "../lib/appContext";
import { ADDR, client } from "../lib/chain";
import { KINDS, readAllowedQuotes, readAsset, usePoll, type Asset, type Launch, type Pending } from "../lib/data";
import { fmtDuration } from "../lib/format";
import { errMsg, sendTx } from "../lib/tx";
import { useChainNow } from "../lib/wallet";
import { Spinner } from "./bits";

const RENAME_COOLDOWN = 86_400;
const MIGRATION_WINDOW = 3 * 86_400;

/** Public notice: holders see a scheduled migration before it can happen. */
export function PendingBanner({ pending, quoteSymbol }: { pending: Pending; quoteSymbol: string }) {
  const now = useChainNow(1000);
  if (!pending) return null;
  const left = pending.readyAt - now;
  return (
    <div className="banner moon" role="status">
      Migration scheduled: this pool moves to the <b>{KINDS[pending.kind]}</b> hook paired with <b>{quoteSymbol}</b>{" "}
      {left > 0 ? `in ${fmtDuration(left)}` : "now (the creator can execute it)"}. Price and liquidity carry over; open
      Patience commitments on this pool won't.
    </div>
  );
}

export function ManagePanel({ launch: l, pending, onChanged }: { launch: Launch; pending: Pending; onChanged: () => void }) {
  const { session, toast } = useApp();
  const now = useChainNow(1000);
  const [busy, setBusy] = useState<string | null>(null);

  // ---- rename
  const [name, setName] = useState(l.name);
  const [symbol, setSymbol] = useState(l.symbol);
  const [image, setImage] = useState(l.imageURI);
  const [desc, setDesc] = useState(l.description);
  const renameReady = l.renamedAt === 0 || now >= l.renamedAt + RENAME_COOLDOWN;
  const changed = name !== l.name || symbol !== l.symbol || image !== l.imageURI || desc !== l.description;

  // ---- migrate
  const [quotes, setQuotes] = useState<Asset[]>([]);
  const [allowed] = usePoll(readAllowedQuotes, 120_000, []);
  useEffect(() => {
    const list = [...new Set([l.quote.toLowerCase(), ...(allowed ?? []).map((a) => a.toLowerCase())])];
    Promise.all(list.map((a) => readAsset(a as Address).catch(() => null))).then((xs) => setQuotes(xs.filter(Boolean) as Asset[]));
  }, [allowed, l.quote]);
  const [kind, setKind] = useState(l.kind === 0 ? 1 : 0);
  const [quote, setQuote] = useState<string>(l.quote.toLowerCase());
  const same = kind === l.kind && quote === l.quote.toLowerCase();

  async function run(label: string, fn: string, args: readonly unknown[], ok: string) {
    if (!session) return;
    setBusy(label);
    try {
      await sendTx(session, { address: ADDR.launcher, abi: tideLauncherAbi, functionName: fn, args });
      toast(ok);
      onChanged();
    } catch (e) {
      toast(errMsg(e), "err");
    } finally {
      setBusy(null);
    }
  }

  const symOf = (a: string) => quotes.find((q) => q.address.toLowerCase() === a.toLowerCase())?.symbol ?? "…";

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="tag">Creator controls</span>
      </div>

      <h3>Rename token</h3>
      <p className="note" style={{ marginTop: 0 }}>
        Changes the ERC20 <span className="lime">name()</span> and <span className="lime">symbol()</span> on-chain. Once
        every 24h; every rename is public.
      </p>
      <div className="row">
        <div className="field">
          <label>Name</label>
          <input className="input" maxLength={32} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field" style={{ flex: "0 1 120px" }}>
          <label>Symbol</label>
          <input className="input" maxLength={12} value={symbol} onChange={(e) => setSymbol(e.target.value.replace(/\s/g, "").toUpperCase())} />
        </div>
      </div>
      <div className="field">
        <label>Image URL</label>
        <input className="input" maxLength={256} value={image} onChange={(e) => setImage(e.target.value)} />
      </div>
      <div className="field">
        <label>Description</label>
        <textarea className="input" rows={2} maxLength={512} value={desc} onChange={(e) => setDesc(e.target.value)} />
      </div>
      <button
        className="btn primary block"
        disabled={!!busy || !changed || !renameReady || !name.trim() || !symbol.trim()}
        onClick={() => run("rename", "updateMetadata", [BigInt(l.id), name.trim(), symbol.trim(), image.trim(), desc.trim()], "Renamed on-chain.")}
      >
        {busy === "rename" ? <Spinner /> : renameReady ? "Save rename" : `Next rename in ${fmtDuration(l.renamedAt + RENAME_COOLDOWN - now)}`}
      </button>

      <div className="subpanel">
        <h3>Upgrade hook / change pair</h3>
        {l.kind === 2 ? (
          <p className="note" style={{ marginTop: 0 }}>
            Bond launches can't migrate: the creator escrow is tied to this pool's price.
          </p>
        ) : pending ? (
          <>
            <p className="note" style={{ marginTop: 0 }}>
              Scheduled: <b className="lime">{KINDS[pending.kind]}</b> paired with <b className="lime">{symOf(pending.quote)}</b>.{" "}
              {now < pending.readyAt
                ? `Executable in ${fmtDuration(pending.readyAt - now)}.`
                : now <= pending.readyAt + MIGRATION_WINDOW
                  ? `Executable now, until ${fmtDuration(pending.readyAt + MIGRATION_WINDOW - now)} from now.`
                  : "Expired: cancel and propose again."}
            </p>
            <div className="row">
              <button
                className="btn primary"
                disabled={!!busy || now < pending.readyAt || now > pending.readyAt + MIGRATION_WINDOW}
                onClick={() => run("exec", "executeMigration", [BigInt(l.id), 1n], "Migrated: liquidity is in the new pool.")}
              >
                {busy === "exec" ? <Spinner /> : "Execute migration"}
              </button>
              <button className="btn" disabled={!!busy} onClick={() => run("cancel", "cancelMigration", [BigInt(l.id)], "Migration cancelled.")}>
                {busy === "cancel" ? <Spinner /> : "Cancel"}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="note" style={{ marginTop: 0 }}>
              Moves all locked liquidity into a new v4 pool with another hook and/or pair, at the same price. It's announced
              publicly and can be executed only after 24h. Pairs are limited to admin-approved assets and routes.
            </p>
            <div className="field">
              <label>New hook</label>
              <div className="seg">
                {[0, 1, 3].map((k) => (
                  <button key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
                    {KINDS[k]}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <label>Pair with</label>
              <div className="seg" style={{ flexWrap: "wrap" }}>
                {quotes.map((q) => (
                  <button key={q.address} className={quote === q.address.toLowerCase() ? "on" : ""} onClick={() => setQuote(q.address.toLowerCase())}>
                    {q.symbol}
                  </button>
                ))}
              </div>
            </div>
            <button
              className="btn primary block"
              disabled={!!busy || same}
              onClick={() => run("propose", "proposeMigration", [BigInt(l.id), kind, quote as Address], "Migration announced. Executable in 24h.")}
            >
              {busy === "propose" ? <Spinner /> : same ? "Pick a different hook or pair" : `Announce move to ${KINDS[kind]} / ${symOf(quote)}`}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const ZERO = "0x0000000000000000000000000000000000000000";

/** Two-step creator handover: the creator names a wallet, that wallet accepts. Moves future fees, rename and migration rights. */
export function CreatorTransfer({ launch: l, onChanged }: { launch: Launch; onChanged: () => void }) {
  const { session, toast } = useApp();
  const [pending, , reload] = usePoll(
    () => client.readContract({ address: ADDR.launcher, abi: tideLauncherAbi, functionName: "pendingCreator", args: [BigInt(l.id)] }),
    30_000,
    [l.id],
  );
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const me = session?.account.toLowerCase();
  const isCreator = me === l.creator.toLowerCase();
  const isPending = !!pending && pending !== ZERO && me === pending.toLowerCase();
  if (!isCreator && !isPending) return null;

  async function run(fn: string, args: readonly unknown[], ok: string) {
    if (!session) return;
    setBusy(true);
    try {
      await sendTx(session, { address: ADDR.launcher, abi: tideLauncherAbi, functionName: fn, args });
      toast(ok);
      reload();
      onChanged();
    } catch (e) {
      toast(errMsg(e), "err");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="tag">Creator wallet</span>
      </div>
      {isPending ? (
        <>
          <p className="note" style={{ marginTop: 0 }}>You were offered this launch. Accepting moves future 1% buy fees, rename and migration rights to you.</p>
          <button className="btn primary block" disabled={busy} onClick={() => run("acceptCreator", [BigInt(l.id)], "You are now the creator.")}>
            {busy ? <Spinner /> : "Accept creator role"}
          </button>
        </>
      ) : (
        <>
          <p className="note" style={{ marginTop: 0 }}>
            Hand the launch to another wallet (for example a multisig). It must accept. Fees you already earned stay claimable by you.
            {pending && pending !== ZERO ? ` Pending: ${pending.slice(0, 6)}…${pending.slice(-4)}.` : ""}
          </p>
          <div className="field">
            <input className="input" placeholder="0x… new creator wallet" value={to} onChange={(e) => setTo(e.target.value.trim())} />
          </div>
          <button className="btn block" disabled={busy || !isAddress(to)} onClick={() => run("transferCreator", [BigInt(l.id), to as Address], "Offer sent. The new wallet must accept.")}>
            {busy ? <Spinner /> : "Offer creator role"}
          </button>
        </>
      )}
    </div>
  );
}
