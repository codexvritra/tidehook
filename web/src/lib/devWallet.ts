// DEVELOPMENT ONLY. Announces an EIP-6963 wallet backed by anvil's well-known dev account so the real UI
// can be exercised end to end against a LOCAL fork. It is imported only when import.meta.env.DEV is true,
// VITE_DEV_WALLET=anvil and the RPC is localhost, so it never exists in a production build.
import { createWalletClient, http, numberToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhood } from "./chain";

const ANVIL_DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // public anvil account #0

export function installDevWallet() {
  const account = privateKeyToAccount(ANVIL_DEV_KEY);
  const rpc = robinhood.rpcUrls.default.http[0];
  const wallet = createWalletClient({ account, chain: robinhood, transport: http(rpc) });

  const forward = async (method: string, params: unknown) => {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }),
    });
    const json = await res.json();
    if (json.error) throw Object.assign(new Error(json.error.message), json.error);
    return json.result;
  };

  const provider = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [account.address];
        case "eth_chainId":
          return numberToHex(robinhood.id);
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain":
          return null;
        case "eth_sendTransaction": {
          const tx = (params?.[0] ?? {}) as Record<string, Hex | undefined>;
          return wallet.sendTransaction({
            to: tx.to,
            data: tx.data,
            value: tx.value ? BigInt(tx.value) : undefined,
            gas: tx.gas ? BigInt(tx.gas) : undefined,
          });
        }
        default:
          return forward(method, params);
      }
    },
    on() {},
    removeListener() {},
  };

  const info = {
    uuid: "tidehook-anvil-dev",
    name: "Anvil dev wallet (local fork)",
    icon: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'><rect width='1' height='1' fill='%23fbbf24'/></svg>",
    rdns: "dev.tidehook.anvil",
  };
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
}
