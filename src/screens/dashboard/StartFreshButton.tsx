import { useState } from "react";
import { DR_TEXT } from "../../lib/drChoice";
import { START_FRESH_CONFIRM } from "../../lib/drHomeState";

/** "Start fresh" with its own confirmation: nothing is sent until the player confirms. */
export function StartFreshButton({ onConfirm, busy, error }: { onConfirm: () => void; busy: boolean; error: string | null }) {
  const [asking, setAsking] = useState(false);
  return (
    <span className="inline-flex flex-col">
      {!asking ? (
        <button onClick={() => setAsking(true)} disabled={busy} className="underline disabled:opacity-50">{DR_TEXT.startFreshButton}</button>
      ) : (
        <span role="alertdialog" aria-label={START_FRESH_CONFIRM} className="flex flex-wrap items-center gap-3">
          <span className="text-text">{START_FRESH_CONFIRM}</span>
          <button onClick={() => { setAsking(false); onConfirm(); }} disabled={busy} className="underline disabled:opacity-50">Yes, start fresh</button>
          <button onClick={() => setAsking(false)} className="underline">Cancel</button>
        </span>
      )}
      {error && <span className="mt-1 text-text" role="status">{error}</span>}
    </span>
  );
}
