import { createPublicClient, defineChain, http, type Address } from "viem";

export const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

export const client = createPublicClient({ chain: robinhood, transport: http(), batch: { multicall: true } });

/** Uniswap v4 singleton on Robinhood Chain (verified on-chain: 24 KB code, owner(), protocolFeeController()). */
export const POOL_MANAGER: Address = "0x8366a39CC670B4001A1121B8F6A443A643e40951";

const env = import.meta.env;
const addr = (v: string | undefined) => (v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : undefined);

/** Hook deployments. Set VITE_*_HOOK in Vercel once the deploy script has been broadcast. */
export const HOOKS = {
  patience: addr(env.VITE_PATIENCE_HOOK),
  spring: addr(env.VITE_SPRING_HOOK),
  bond: addr(env.VITE_BOND_HOOK),
  session: addr(env.VITE_SESSION_HOOK),
} as const;

export const GITHUB_URL: string = env.VITE_GITHUB_URL || "https://github.com";

export const explorer = (a: string) => `${robinhood.blockExplorers.default.url}/address/${a}`;
