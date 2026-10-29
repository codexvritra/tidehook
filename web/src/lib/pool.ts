import { encodeAbiParameters, keccak256, toHex, type Hex } from "viem";
import { ADDR } from "./chain";
import type { PoolKey } from "./data";

/** PoolId = keccak256(abi.encode(PoolKey)), identical to v4's PoolIdLibrary. */
export function poolIdOf(k: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks],
    ),
  );
}

/** PatienceHook.commitmentOf, computed locally so the salt never leaves the browser before reveal. */
export function commitmentOf(poolId: Hex, zeroForOne: boolean, amountIn: bigint, limit: bigint, salt: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bool" }, { type: "int256" }, { type: "uint160" }, { type: "bytes32" }],
      [poolId, zeroForOne, -amountIn, limit, salt],
    ),
  );
}

export const newSalt = (): Hex => toHex(crypto.getRandomValues(new Uint8Array(32)));
export const saltHookData = (salt: Hex): Hex => encodeAbiParameters([{ type: "bytes32" }], [salt]);

// ------------------------------------------------------------------ saved commitments (per browser)

export type SavedCommit = {
  commitment: Hex;
  salt: Hex;
  zeroForOne: boolean;
  amountIn: string; // bigint as string
  limit: string;
  createdAt: number;
  account: string;
};

const key = (launchId: number) => `tidehook:commits:${ADDR.launcher.toLowerCase()}:${launchId}`;
const EVT = "tidehook:commits";

export function loadCommits(launchId: number): SavedCommit[] {
  try {
    return JSON.parse(localStorage.getItem(key(launchId)) || "[]");
  } catch {
    return [];
  }
}

export function saveCommits(launchId: number, list: SavedCommit[]) {
  try {
    localStorage.setItem(key(launchId), JSON.stringify(list));
  } catch {
    /* storage unavailable: commitments still show for this session */
  }
  window.dispatchEvent(new Event(EVT));
}

export function onCommitsChange(fn: () => void): () => void {
  window.addEventListener(EVT, fn);
  window.addEventListener("storage", fn);
  return () => {
    window.removeEventListener(EVT, fn);
    window.removeEventListener("storage", fn);
  };
}
