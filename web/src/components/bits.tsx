import { useState } from "react";
import { KINDS } from "../lib/data";
import { priceParts } from "../lib/price";

export function Avatar({ src, label, size = 44 }: { src?: string; label: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  const safe = src && /^(https:\/\/|ipfs:\/\/)/.test(src) ? src.replace(/^ipfs:\/\//, "https://ipfs.io/ipfs/") : "";
  if (!safe || broken) {
    const hue = [...label].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
    return (
      <span className="avatar" style={{ width: size, height: size, background: `linear-gradient(135deg, hsl(${hue} 70% 45%), hsl(${(hue + 60) % 360} 70% 35%))` }}>
        {label.slice(0, 2).toUpperCase()}
      </span>
    );
  }
  return <img className="avatar" src={safe} alt="" width={size} height={size} onError={() => setBroken(true)} referrerPolicy="no-referrer" />;
}

export function KindBadge({ kind }: { kind: number }) {
  return <span className={`pill kind-${kind}`}>{KINDS[kind] ?? "?"}</span>;
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

/** Price with subscript-zero notation for tiny values: 0.0<sub>7</sub>4150 */
export function Price({ value }: { value: number }) {
  const p = priceParts(value);
  if ("plain" in p) return <>{p.plain}</>;
  return (
    <>
      0.0<sub className="zeros">{p.zeros}</sub>
      {p.digits}
    </>
  );
}

/** tidehook mark: a hook dropping into a wave, drawn on a pixel grid. */
export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden="true">
      <g fill="#d0ff00">
        <rect x="9" y="1" width="2" height="7" />
        <rect x="7" y="8" width="2" height="2" />
        <rect x="9" y="8" width="2" height="2" />
        <rect x="5" y="6" width="2" height="3" />
        <rect x="1" y="12" width="3" height="2" />
        <rect x="4" y="11" width="2" height="2" />
        <rect x="6" y="12" width="3" height="2" />
        <rect x="9" y="11" width="2" height="2" />
        <rect x="11" y="12" width="4" height="2" />
      </g>
    </svg>
  );
}
