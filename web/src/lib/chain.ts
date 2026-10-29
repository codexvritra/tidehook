import { createPublicClient, defineChain, http, type Address } from "viem";
import { ADDR } from "./deployments";

const RPC_URL: string = import.meta.env.VITE_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";

/** True when pointed at a local fork (development). */
export const IS_LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)/.test(RPC_URL);

export const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

// Multicall batching on mainnet. A local anvil fork of a non-archive RPC can't lazily load Multicall3
// once its fork block ages out, so local mode sends plain calls.
export const client = createPublicClient({ chain: robinhood, transport: http(RPC_URL), batch: { multicall: !IS_LOCAL } });

/** Uniswap v4 singleton on Robinhood Chain (verified on-chain: 24 KB code, owner(), protocolFeeController()). */
export const POOL_MANAGER: Address = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
export const CREATE2_DEPLOYER: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
export const ETH: Address = "0x0000000000000000000000000000000000000000";

export { ADDR };

export const GITHUB_URL: string = import.meta.env.VITE_GITHUB_URL || "https://github.com";

export const explorer = (a: string) => `${robinhood.blockExplorers.default.url}/address/${a}`;
export const explorerTx = (h: string) => `${robinhood.blockExplorers.default.url}/tx/${h}`;
