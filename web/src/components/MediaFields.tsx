import { useRef, useState } from "react";
import { cleanWebsite, cleanX, compressImage, validWebsite, validX, type MediaDraft } from "../lib/media";
import { Avatar } from "./bits";

/** Logo upload plus optional X and website, all saved on-chain with the launch. */
export function MediaFields({ value, onChange, label }: { value: MediaDraft; onChange: (m: MediaDraft) => void; label: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function pick(file: File | undefined) {
    if (!file) return;
    setErr(null);
    setBusy(true);
    try {
      onChange({ ...value, image: await compressImage(file) });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  const x = cleanX(value.x);
  const site = cleanWebsite(value.website);
  return (
    <>
      <div className="field">
        <label>
          <span>Logo</span>
          <span className="dim">optional · PNG, JPG, WEBP or GIF</span>
        </label>
        <div
          className="upload"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            pick(e.dataTransfer.files[0]);
          }}
        >
          <Avatar src={value.image} label={label || "??"} size={56} />
          <div className="upload-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => input.current?.click()}>
              {busy ? "Processing…" : value.image ? "Change image" : "Upload image"}
            </button>
            {value.image && (
              <button type="button" className="btn ghost-lime" onClick={() => onChange({ ...value, image: "" })}>
                Remove
              </button>
            )}
            <span className="dim upload-hint">or drop a file here. Stored on-chain, resized to fit.</span>
          </div>
          <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => pick(e.target.files?.[0])} />
        </div>
        {err && <p className="note warn">{err}</p>}
      </div>
      <div className="row">
        <div className="field">
          <label>
            <span>X (Twitter)</span>
            <span className="dim">optional</span>
          </label>
          <input className="input mono" maxLength={60} value={value.x} onChange={(e) => onChange({ ...value, x: e.target.value })} placeholder="@yourtoken" />
          {!validX(x) && <p className="note warn">Use a handle like @yourtoken (letters, numbers, _; max 15).</p>}
        </div>
        <div className="field">
          <label>
            <span>Website</span>
            <span className="dim">optional</span>
          </label>
          <input className="input mono" maxLength={200} value={value.website} onChange={(e) => onChange({ ...value, website: e.target.value })} placeholder="yourtoken.com" />
          {!validWebsite(site) && <p className="note warn">Enter a valid web address.</p>}
        </div>
      </div>
    </>
  );
}
