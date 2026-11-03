import { useEffect, useState, useSyncExternalStore } from "react";
import { createWalletClient, custom, numberToHex, type Address, type EIP1193Provider, type WalletClient } from "viem";
import { client, robinhood } from "./chain";

// EIP-6963 multi-wallet discovery. Nothing is remembered between visits: connect is per session.

type Info = { uuid: string; name: string; icon: string; rdns: string };
export type Discovered = { info: Info; provider: EIP1193Provider };

const found = new Map<string, Discovered>();
const listeners = new Set<() => void>();
let snapshot: Discovered[] = [];

if (typeof window !== "undefined") {
  window.addEventListener("eip6963:announceProvider", (e: Event) => {
    const d = (e as CustomEvent<Discovered>).detail;
    if (!d?.info?.uuid || found.has(d.info.uuid)) return;
    found.set(d.info.uuid, d);
    snapshot = [...found.values()];
    listeners.forEach((l) => l());
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

export function useWallets(): Discovered[] {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => snapshot,
    () => snapshot,
  );
}

export type Session = { account: Address; wallet: WalletClient; name: string };

export async function connect(d: Discovered): Promise<Session> {
  const [account] = (await d.provider.request({ method: "eth_requestAccounts" })) as Address[];
  const hex = numberToHex(robinhood.id);
  try {
    await d.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (err) {
    if ((err as { code?: number }).code !== 4902) throw err;
    await d.provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: hex,
          chainName: robinhood.name,
          nativeCurrency: robinhood.nativeCurrency,
          rpcUrls: robinhood.rpcUrls.default.http,
          blockExplorerUrls: [robinhood.blockExplorers.default.url],
        },
      ],
    });
  }
  const wallet = createWalletClient({ account, chain: robinhood, transport: custom(d.provider) });
  return { account, wallet, name: d.info.name };
}

/** Re-renders every `ms` with the current unix time in seconds. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

// Chain clock: contracts judge cooldowns, timelocks and commitment ages by block.timestamp, so countdowns
// follow the latest block's time instead of the viewer's (possibly wrong) system clock.
let offset = 0;
let synced = 0;
async function syncOffset() {
  if (Date.now() - synced < 15_000) return;
  synced = Date.now();
  try {
    const b = await client.getBlock();
    offset = Number(b.timestamp) - Math.floor(Date.now() / 1000);
  } catch {
    /* keep the last known offset */
  }
}

/** Current chain time in seconds, re-rendering every `ms`. */
export function useChainNow(ms = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000) + offset);
  useEffect(() => {
    syncOffset().then(() => setNow(Math.floor(Date.now() / 1000) + offset));
    const id = setInterval(() => {
      syncOffset();
      setNow(Math.floor(Date.now() / 1000) + offset);
    }, ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
