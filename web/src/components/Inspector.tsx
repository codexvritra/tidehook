import { useState } from "react";
import { isAddress } from "viem";
import { HOOKS, client, explorer } from "../lib/chain";
import { decodeHookFlags } from "../lib/model";
import { Kicker } from "./ui";

const OURS = Object.entries(HOOKS).filter(([, a]) => a) as [string, string][];

export function Inspector() {
  const [addr, setAddr] = useState("");
  const [code, setCode] = useState<{ addr: string; size: number } | "error" | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = isAddress(addr);
  const flags = valid ? decodeHookFlags(addr) : null;

  async function check(a: string) {
    setBusy(true);
    try {
      const bytecode = await client.getCode({ address: a as `0x${string}` });
      setCode({ addr: a.toLowerCase(), size: bytecode ? (bytecode.length - 2) / 2 : 0 });
    } catch {
      setCode("error");
    } finally {
      setBusy(false);
    }
  }

  const current = code && code !== "error" && code.addr === addr.toLowerCase() ? code : null;

  return (
    <section id="inspector">
      <div className="wrap">
        <Kicker n="05">Hook inspector</Kicker>
        <h2>
          Check any hook <em>before you trade.</em>
        </h2>
        <p className="section-lede">
          Uniswap v4 writes a hook's permissions into the last 14 bits of its address. Paste any hook on Robinhood
          Chain to see which callbacks it can run on your swap. The check runs in your browser against the public
          RPC, with no server.
        </p>
        <div className="panel">
          <div className="row">
            <div className="field" style={{ flex: "1 1 360px", marginBottom: 0 }}>
              <input
                className="input mono"
                placeholder="0x… hook address"
                value={addr}
                onChange={(e) => setAddr(e.target.value.trim())}
                onKeyDown={(e) => e.key === "Enter" && valid && check(addr)}
                aria-label="Hook address"
              />
            </div>
            <button className="btn primary" disabled={!valid || busy} onClick={() => check(addr)}>
              {busy ? "Reading…" : "Read on-chain"}
            </button>
          </div>
          {OURS.length > 0 && (
            <div className="row" style={{ marginTop: 10 }}>
              <span className="note" style={{ margin: 0 }}>Try:</span>
              {OURS.map(([n, a]) => (
                <button key={n} className="btn small" onClick={() => { setAddr(a); check(a); }}>{n}</button>
              ))}
            </div>
          )}
          {flags && (
            <>
              <div className="row" style={{ marginTop: 18, gap: 8 }}>
                <span className="pill tide">{flags.filter((f) => f.on).length} callbacks enabled</span>
                {flags.some((f) => f.on && f.name.includes("ReturnsDelta")) && (
                  <span className="pill moon">can take or give tokens during your swap</span>
                )}
                {current && (current.size > 0 ? (
                  <span className="pill ok">{current.size.toLocaleString()} bytes deployed · <a href={explorer(addr)} target="_blank" rel="noreferrer">explorer</a></span>
                ) : (
                  <span className="pill warn">no code at this address on chain 4663</span>
                ))}
                {code === "error" && <span className="pill warn">RPC unreachable</span>}
              </div>
              <div className="flags">
                {flags.map((f) => (
                  <div key={f.name} className={`flag ${f.on ? "on" : ""}`}>{f.name}</div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
