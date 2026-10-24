import { useState, type ReactNode } from "react";

export function Copy({ text, label = "copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="copy-btn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          /* clipboard blocked: the value stays selectable */
        }
      }}
    >
      {done ? "copied" : label}
    </button>
  );
}

export function Code({ children, copy }: { children: ReactNode; copy?: string }) {
  return (
    <div className="code">
      <span>{children}</span>
      {copy && <Copy text={copy} />}
    </div>
  );
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: "hi" | "bad" }) {
  return (
    <div className={`stat ${tone ?? ""}`}>
      <label>{label}</label>
      <b>{value}</b>
    </div>
  );
}

export function Range(props: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  label?: string;
}) {
  const p = ((props.value - props.min) / (props.max - props.min)) * 100;
  return (
    <input
      type="range"
      aria-label={props.label}
      min={props.min}
      max={props.max}
      step={props.step ?? 1}
      value={props.value}
      style={{ ["--p" as string]: `${p}%` }}
      onChange={(e) => props.onChange(Number(e.target.value))}
    />
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="radiogroup">
      {options.map(([v, l]) => (
        <button key={v} role="radio" aria-checked={v === value} className={v === value ? "on" : ""} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

export function Kicker({ n, children }: { n: string; children: ReactNode }) {
  return (
    <div className="kicker">
      <span className="n">{n}</span>
      <span>{children}</span>
    </div>
  );
}
