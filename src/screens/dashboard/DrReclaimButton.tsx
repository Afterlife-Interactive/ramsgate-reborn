import { useRef, useState } from "react";
import { drReclaim } from "../../api/tauri";
import { RECLAIM_SUCCESS, RECLAIM_TEXT, reclaimMessage } from "../../lib/drReclaim";

const FETCH_POLL_MS = 5000;
const FETCH_POLL_MAX = 12;

/** Asks the server to pull the Dauntless Revived save again. One request at a time; a failure only shows a retry line. */
export function DrReclaimButton({ onStarted }: { onStarted?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Once the server says the route is not there (404), or that this account is not eligible, the button goes away for good.
  const [gone, setGone] = useState(false);
  const flight = useRef(false);
  const press = () => {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    setMessage(null);
    const ask = (tries: number): Promise<void> =>
      drReclaim().then((outcome) => {
        // "fetching": the server is pulling the save; ask again every few seconds, but only a bounded number of times.
        if (outcome === "fetching" && tries < FETCH_POLL_MAX) {
          setMessage(RECLAIM_TEXT.fetching);
          return new Promise<void>((r) => setTimeout(r, FETCH_POLL_MS)).then(() => ask(tries + 1));
        }
        setMessage(reclaimMessage(outcome === "fetching" ? "not_ready" : outcome));
        if (RECLAIM_SUCCESS.includes(outcome)) onStarted?.();
        if (outcome === "unavailable" || outcome === "not_eligible") setGone(true);
      });
    ask(0)
      .catch(() => setMessage(reclaimMessage(null)))
      .finally(() => { flight.current = false; setBusy(false); });
  };
  if (gone) return message ? <p className="mt-2 max-w-[44ch] text-[13px] text-text" role="status">{message}</p> : null;
  return (
    <div className="mt-2 max-w-[44ch] text-[13px] text-text-muted">
      <button onClick={press} disabled={busy} className="rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-[13px] font-medium text-text enabled:hover:bg-white/10 disabled:opacity-50">
        {busy ? RECLAIM_TEXT.working : RECLAIM_TEXT.button}
      </button>
      {message && <p className="mt-2 text-text" role="status">{message}</p>}
    </div>
  );
}
