import { useEffect, useRef, useState } from "react";
import { drChoiceStatus, isGameRunning, launchedGameState, resetSave } from "../../api/tauri";
import { stillRunning, RUNNING_POLL_MS } from "../../launch/runningPhase";
import { RESET_DONE, RESET_TEXT, RESET_WORD, resetGate, resetMessage, transferPending } from "../../lib/saveReset";

/**
 * "Reset my save data". Account tab only (never Home, never near Play). Two steps: press the button, then read the warning, close the
 * game and type RESET. A server without the route (404) hides the whole card; the probe sends no word and changes nothing.
 */
export function ResetSaveCard() {
  const [available, setAvailable] = useState(true);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [gameRunning, setGameRunning] = useState(false);
  const [pending, setPending] = useState(false);
  const flight = useRef(false);

  // Probe once: a server that has the route answers "confirm_required" and changes nothing.
  useEffect(() => {
    let cancelled = false;
    resetSave("").then((r) => { if (!cancelled && r.outcome === "unavailable") setAvailable(false); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  // While the warning is open: watch the game and check for a pending transfer. The timer stops when it closes or the tab goes away.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const poll = () => stillRunning(launchedGameState, isGameRunning).then((r) => { if (!cancelled) setGameRunning(r); }).catch(() => undefined);
    void poll();
    drChoiceStatus().then((a) => { if (!cancelled) setPending(transferPending(a.state)); }).catch(() => undefined);
    const timer = setInterval(() => void poll(), RUNNING_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [open]);

  const gate = resetGate({ available, gameRunning, transferPending: pending, typed, busy });
  if (!gate.visible) return null;

  const confirm = () => {
    if (flight.current || !gate.enabled) return;
    flight.current = true;
    setBusy(true);
    setMessage(null);
    resetSave(RESET_WORD)
      .then((r) => {
        if (r.outcome === "unavailable") setAvailable(false);
        setMessage(resetMessage(r.outcome, r.message, r.retryAfterSeconds));
        if (RESET_DONE.includes(r.outcome)) { setOpen(false); setTyped(""); }
      })
      .catch(() => setMessage(resetMessage(null)))
      .finally(() => { flight.current = false; setBusy(false); });
  };

  return (
    <div className="mt-6 overflow-hidden glass rounded-2xl p-6 text-[13px]">
      <p className="font-medium text-text">{RESET_TEXT.heading}</p>
      {!open ? (
        <button onClick={() => { setOpen(true); setMessage(null); }} className="mt-3 rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-[13px] font-medium text-text hover:bg-white/10">
          {RESET_TEXT.button}
        </button>
      ) : (
        <div role="group" aria-label={RESET_TEXT.heading} className="mt-2 flex flex-col gap-3 text-text-muted">
          <p className="font-medium text-text">{RESET_TEXT.warning}</p>
          <p>{RESET_TEXT.intro}</p>
          <div>
            <p className="font-medium text-text">{RESET_TEXT.deletedTitle}</p>
            <p>{RESET_TEXT.deleted}</p>
            <p className="mt-1">{RESET_TEXT.backup}</p>
          </div>
          <div>
            <p className="font-medium text-text">{RESET_TEXT.keptTitle}</p>
            <p>{RESET_TEXT.kept}</p>
            <p className="mt-1">{RESET_TEXT.retransfer}</p>
          </div>
          <p>{RESET_TEXT.closeGame} {RESET_TEXT.once}</p>
          {gate.blocked === "game" && <p className="text-text" role="status">{RESET_TEXT.blockedGame}</p>}
          {gate.blocked === "transfer" && <p className="text-text" role="status">{RESET_TEXT.blockedTransfer}</p>}
          <label className="flex flex-col gap-1">
            <span className="text-text">{RESET_TEXT.typePrompt}</span>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} disabled={busy || gate.blocked !== null} autoComplete="off" spellCheck={false}
              className="w-48 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-text disabled:opacity-50" />
          </label>
          <div className="flex items-center gap-3">
            <button onClick={confirm} disabled={!gate.enabled} className="rounded-xl border border-white/15 bg-white/5 px-4 py-2 font-medium text-text enabled:hover:bg-white/10 disabled:opacity-50">
              {busy ? RESET_TEXT.working : RESET_TEXT.confirmButton}
            </button>
            <button onClick={() => { setOpen(false); setTyped(""); }} disabled={busy} className="underline disabled:opacity-50">{RESET_TEXT.cancel}</button>
          </div>
        </div>
      )}
      {message && <p className="mt-3 max-w-[48ch] text-text" role="status">{message}</p>}
    </div>
  );
}
