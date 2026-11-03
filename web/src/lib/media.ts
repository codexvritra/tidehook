// Token media (logo, X, website) stored fully on-chain, no server or pinning service.
// The metadata is a small JSON blob saved as the runtime code of a data-only contract (the SSTORE2 pattern),
// deployed through the deterministic CREATE2 deployer. The launch's `imageURI` holds "onchain:<address>".
// Identical metadata maps to the same address, so re-using it costs nothing.
import { useEffect, useState } from "react";
import { concat, getContractAddress, hexToString, numberToHex, padHex, size, stringToHex, type Address, type Hex } from "viem";
import { CREATE2_DEPLOYER, client } from "./chain";
import { sendRaw } from "./tx";
import type { Session } from "./wallet";

export type TokenMeta = { image?: string; x?: string; website?: string };
/** Form state: raw user input before cleaning. */
export type MediaDraft = { image: string; x: string; website: string };

const MAX_CODE = 24_575; // EIP-170 limit minus the leading STOP byte
const DATA_IMAGE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

export const cleanX = (v: string) => v.trim().replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "").replace(/^@/, "").replace(/[/?#].*$/, "");
export const validX = (v: string) => v === "" || /^[A-Za-z0-9_]{1,15}$/.test(v);
export const cleanWebsite = (v: string) => {
  const t = v.trim();
  return t && !/^https?:\/\//i.test(t) ? `https://${t}` : t;
};
export const validWebsite = (v: string) => {
  if (v === "") return true;
  try {
    const u = new URL(v);
    return (u.protocol === "https:" || u.protocol === "http:") && u.hostname.includes(".") && v.length <= 200;
  } catch {
    return false;
  }
};

export const mediaErrors = (m: MediaDraft) =>
  [!validX(cleanX(m.x)) && "X handle", !validWebsite(cleanWebsite(m.website)) && "website"].filter(Boolean) as string[];

/** Resize + re-encode an uploaded image until it is small enough to live on-chain (~15 KB). */
export async function compressImage(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("That file isn't an image.");
  if (file.size > 15 * 1024 * 1024) throw new Error("Image is over 15 MB.");
  const bitmap = await createImageBitmap(file);
  for (const side of [256, 192, 128, 96]) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = side;
    const ctx = canvas.getContext("2d")!;
    // Center-crop to a square.
    const s = Math.min(bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, (bitmap.width - s) / 2, (bitmap.height - s) / 2, s, s, 0, 0, side, side);
    for (const q of [0.85, 0.7, 0.55, 0.4]) {
      const url = canvas.toDataURL("image/webp", q);
      const out = url.startsWith("data:image/webp") ? url : canvas.toDataURL("image/jpeg", q);
      if (out.length <= 15_000) return out;
    }
  }
  throw new Error("Couldn't shrink this image enough. Try a simpler one.");
}

export function encodeMeta(m: TokenMeta): string {
  const o: TokenMeta = {};
  if (m.image) o.image = m.image;
  if (m.x) o.x = m.x;
  if (m.website) o.website = m.website;
  return JSON.stringify(o);
}

function initcode(json: string): Hex {
  const runtime = concat(["0x00", stringToHex(json)]); // leading STOP: the data can never execute
  const len = size(runtime);
  if (len > MAX_CODE) throw new Error("Metadata too large to store on-chain.");
  // PUSH2 len, DUP1, PUSH1 12, PUSH1 0, CODECOPY, PUSH1 0, RETURN, then the runtime itself.
  return concat([`0x61${numberToHex(len, { size: 2 }).slice(2)}80600c6000396000f3`, runtime]);
}

/** Store metadata on-chain (skipped if identical metadata already exists). Returns the `imageURI` to launch with. */
export async function storeMeta(session: Session, m: TokenMeta): Promise<string> {
  const json = encodeMeta(m);
  if (json === "{}") return "";
  const code = initcode(json);
  const salt = padHex("0x0", { size: 32 });
  const addr = getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt, bytecode: code });
  const existing = await client.getCode({ address: addr });
  if (!existing || existing === "0x") await sendRaw(session, CREATE2_DEPLOYER, concat([salt, code]));
  cache.set(addr.toLowerCase(), Promise.resolve(sanitize(json)));
  return `onchain:${addr}`;
}

function sanitize(json: string): TokenMeta {
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    const m: TokenMeta = {};
    if (typeof o.image === "string" && DATA_IMAGE.test(o.image)) m.image = o.image;
    if (typeof o.x === "string" && validX(o.x)) m.x = o.x;
    if (typeof o.website === "string" && validWebsite(o.website)) m.website = o.website;
    return m;
  } catch {
    return {};
  }
}

const cache = new Map<string, Promise<TokenMeta>>();

export function resolveMeta(uri: string | undefined): Promise<TokenMeta> {
  if (!uri) return Promise.resolve({});
  if (DATA_IMAGE.test(uri)) return Promise.resolve({ image: uri });
  if (/^(https:\/\/|ipfs:\/\/)/.test(uri)) return Promise.resolve({ image: uri.replace(/^ipfs:\/\//, "https://ipfs.io/ipfs/") });
  const m = /^onchain:(0x[0-9a-fA-F]{40})$/.exec(uri);
  if (!m) return Promise.resolve({});
  const key = m[1].toLowerCase();
  if (!cache.has(key)) {
    cache.set(
      key,
      client
        .getCode({ address: m[1] as Address })
        .then((code) => (code && code.length > 4 ? sanitize(hexToString(`0x${code.slice(4)}`)) : {}))
        .catch(() => {
          cache.delete(key);
          return {};
        }),
    );
  }
  return cache.get(key)!;
}

export function useTokenMeta(uri: string | undefined): TokenMeta {
  const [meta, setMeta] = useState<TokenMeta>({});
  useEffect(() => {
    let live = true;
    resolveMeta(uri).then((m) => live && setMeta(m));
    return () => {
      live = false;
    };
  }, [uri]);
  return meta;
}
