import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { About } from "./pages/About";
import { Deploy } from "./pages/Deploy";
import { Explore } from "./pages/Explore";
import { LaunchPage } from "./pages/Launch";
import { TokenPage } from "./pages/Token";
import { AppCtx, useRoute, type AppState } from "./lib/appContext";
import { GITHUB_URL, IS_LOCAL } from "./lib/chain";
import { readDeployment, usePoll } from "./lib/data";
import { short } from "./lib/format";
import { connect, useWallets, type Session } from "./lib/wallet";

function Logo() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="lg" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#5eead4" />
          <stop offset="1" stopColor="#38bdf8" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="15" fill="none" stroke="url(#lg)" strokeWidth="1.5" opacity=".5" />
      <path d="M4 18c3-3 6-3 9 0s6 3 9 0 4-2 6-1" fill="none" stroke="url(#lg)" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M19 6v8a4 4 0 0 1-8 0" fill="none" stroke="#e6ecf7" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

function Wallet({ session, setSession, toast, openSignal }: { session: Session | null; setSession: (s: Session | null) => void; toast: AppState["toast"]; openSignal: number }) {
  const wallets = useWallets();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  useEffect(() => {
    if (openSignal) setOpen(true);
  }, [openSignal]);

  if (session)
    return (
      <div className="wallet">
        <button className="btn" onClick={() => setSession(null)} title="Disconnect">
          <span className="dot" /> <span className="mono">{short(session.account)}</span>
        </button>
      </div>
    );

  return (
    <div className="wallet" ref={ref}>
      <button className="btn primary" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        Connect
      </button>
      {open && (
        <div className="menu" role="menu">
          {wallets.length === 0 && <p className="muted">No browser wallet found. Install MetaMask, Rabby or another EIP-6963 wallet.</p>}
          {wallets.map((w) => (
            <button
              key={w.info.uuid}
              className="btn"
              role="menuitem"
              onClick={async () => {
                setOpen(false);
                try {
                  setSession(await connect(w));
                } catch (e) {
                  toast((e as Error).message.split("\n")[0], "err");
                }
              }}
            >
              <img src={w.info.icon} alt="" /> {w.info.name}
            </button>
          ))}
          <p className="dim">Robinhood Chain (4663). Nothing is remembered after you leave.</p>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const route = useRoute();
  const [session, setSession] = useState<Session | null>(null);
  const [msg, setMsg] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  const [openSignal, setOpenSignal] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [deploy, , refreshDeploy] = usePoll(readDeployment, 60_000, []);

  const toast = useCallback((text: string, kind: "ok" | "err" = "ok") => {
    setMsg({ text, kind });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(null), 6000);
  }, []);

  const requireWallet = useCallback(() => {
    if (session) return session;
    setOpenSignal((n) => n + 1);
    toast("Connect a wallet to continue.", "err");
    return null;
  }, [session, toast]);

  const state = useMemo<AppState>(
    () => ({ session, setSession, toast, deploy, refreshDeploy, requireWallet }),
    [session, toast, deploy, refreshDeploy, requireWallet],
  );

  const tab = (p: string, label: string, href: string) => (
    <a href={href} className={route.page === p ? "on" : ""}>
      {label}
    </a>
  );

  return (
    <AppCtx.Provider value={state}>
      <nav className="nav">
        <div className="wrap">
          <a className="brand" href="#/">
            <Logo /> tidehook
          </a>
          <div className="nav-links">
            {tab("explore", "Explore", "#/")}
            {tab("launch", "Launch", "#/launch")}
            {tab("about", "How it works", "#/about")}
            {deploy && !deploy.ready && tab("deploy", "Deploy", "#/deploy")}
          </div>
          <Wallet session={session} setSession={setSession} toast={toast} openSignal={openSignal} />
        </div>
        <div className="mobile-tabs">
          {tab("explore", "Explore", "#/")}
          {tab("launch", "Launch", "#/launch")}
          {tab("about", "How", "#/about")}
        </div>
      </nav>

      {IS_LOCAL && <div className="banner moon">Local fork mode: reading a local anvil fork of Robinhood Chain, not mainnet.</div>}
      {deploy && !deploy.ready && route.page !== "deploy" && (
        <div className="banner">
          The tidehook contracts aren't deployed on Robinhood Chain yet ({deploy.missing.length} of 6 missing).{" "}
          <a href="#/deploy">Deploy them from your wallet →</a>
        </div>
      )}

      <main>
        {route.page === "explore" && <Explore />}
        {route.page === "launch" && <LaunchPage />}
        {route.page === "token" && <TokenPage id={route.id} />}
        {route.page === "deploy" && <Deploy />}
        {route.page === "about" && <About />}
      </main>

      <footer>
        <div className="wrap">
          <p>
            tidehook is unaudited, experimental software on Robinhood Chain mainnet. Tokens launched here are created by
            anyone and can lose all value. Nothing here is investment advice. Not affiliated with Robinhood Markets, Inc.
            or Uniswap Labs.
          </p>
          <p>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">
              Source
            </a>{" "}
            · MIT
          </p>
        </div>
      </footer>
      {msg && (
        <div className={`toast ${msg.kind}`} role="status">
          {msg.text}
        </div>
      )}
    </AppCtx.Provider>
  );
}
