import { BaseError, ContractFunctionRevertedError, decodeErrorResult, type Abi, type Address, type Hex, type TransactionReceipt } from "viem";
import { creatorBondHookAbi, patienceHookAbi, sessionHookAbi, springHookAbi, tideLauncherAbi, tideRouterAbi, wrappedErrorAbi } from "./abis";
import { client, robinhood } from "./chain";
import type { Session } from "./wallet";

const ALL_ERRORS = [
  ...patienceHookAbi,
  ...springHookAbi,
  ...creatorBondHookAbi,
  ...sessionHookAbi,
  ...tideLauncherAbi,
  ...tideRouterAbi,
].filter((x) => x.type === "error") as Abi;

const FRIENDLY: Record<string, string> = {
  CommitmentTooYoung: "This commitment is still under 30 seconds old. Wait a moment, then reveal.",
  CommitmentExpired: "This commitment is over 24h old and has expired. Commit again.",
  UnknownCommitment: "The hook doesn't know this commitment (already used, or the details changed).",
  TooLittleReceived: "The price moved past your slippage limit. Try again or raise slippage.",
  Expired: "The transaction deadline passed.",
  FloorNotHeld: "The floor hasn't held for the full grace period yet.",
  BelowFloor: "The price is below the bond floor.",
  NotSlashable: "The floor hasn't been broken for the full grace period.",
  NotCreator: "Only the creator can do this.",
};

function nameError(data: Hex): string | null {
  try {
    const w = decodeErrorResult({ abi: wrappedErrorAbi, data });
    if (w.errorName === "WrappedError") return nameError(w.args[2] as Hex) ?? "The pool's hook rejected this swap.";
  } catch {
    /* not wrapped */
  }
  try {
    const e = decodeErrorResult({ abi: ALL_ERRORS, data });
    return FRIENDLY[e.errorName] ?? `${e.errorName}${e.args?.length ? `(${e.args.map(String).join(", ")})` : ""}`;
  } catch {
    return null;
  }
}

/** Human-readable error: decoded custom error names first, then viem's short message. */
export function errMsg(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      // The undecoded revert bytes live further down the cause chain (RawContractError.data).
      const holder = e.walk((x) => typeof (x as { data?: unknown }).data === "string" && String((x as { data: string }).data).startsWith("0x"));
      const raw = (holder as { data?: Hex } | null)?.data;
      const named = raw ? nameError(raw) : null;
      if (named) return named;
      const name = revert.data?.errorName;
      if (name) return FRIENDLY[name] ?? `${name}${revert.data?.args?.length ? `(${revert.data.args.map(String).join(", ")})` : ""}`;
      if (revert.reason) return revert.reason;
    }
    if (/User rejected|denied/i.test(e.message)) return "Rejected in wallet.";
    return e.shortMessage || e.message.split("\n")[0];
  }
  return (e as Error)?.message?.split("\n")[0] ?? String(e);
}

type Call = {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
};

/** Simulate (so failures surface with a reason), pad the gas estimate 30%, send, wait for the receipt. */
export async function sendTx(session: Session, call: Call): Promise<TransactionReceipt> {
  const base = { ...call, account: session.account } as Parameters<typeof client.simulateContract>[0];
  const { request } = await client.simulateContract(base);
  const gas = ((await client.estimateContractGas(base as Parameters<typeof client.estimateContractGas>[0])) * 13n) / 10n;
  type WriteArgs = Parameters<typeof session.wallet.writeContract>[0];
  const hash = await session.wallet.writeContract({ ...(request as object), gas, chain: robinhood, account: session.account } as unknown as WriteArgs);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction reverted: ${hash}`);
  return receipt;
}

/** Raw transaction (used by the Deploy page to call the CREATE2 deployer). */
export async function sendRaw(session: Session, to: Address, data: Hex): Promise<TransactionReceipt> {
  const gas = ((await client.estimateGas({ account: session.account, to, data })) * 13n) / 10n;
  const hash = await session.wallet.sendTransaction({ to, data, gas, chain: robinhood, account: session.account });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction reverted: ${hash}`);
  return receipt;
}

/** Swap deadline from the chain's clock (the router checks block.timestamp), 10 minutes out. */
export async function chainDeadline(seconds = 600): Promise<bigint> {
  const b = await client.getBlock();
  return b.timestamp + BigInt(seconds);
}
