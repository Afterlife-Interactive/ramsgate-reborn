// RR-38 offline mode: the Online | Offline switch and the one-time notice about the one-way rule.

import { useState } from "react";
import { Button } from "../components/Button";
import { ONE_WAY_NOTICE, ONE_WAY_NOTICE_TITLE } from "./oneWay";
import { useOfflineMode } from "./OfflineModeContext";

export function ModeSwitch({ onInk = true }: { onInk?: boolean }) {
  const { mode, requestMode } = useOfflineMode();
  const base = "px-4 py-1.5 text-[11px] font-bold uppercase tracking-[0.16em] transition-colors";
  const off = onInk ? "text-on-ink-muted hover:text-on-ink" : "text-text-muted hover:text-text";
  const on = "bg-cta text-on-ink";
  return (
    <div
      role="radiogroup"
      aria-label="Launcher mode"
      className={`inline-flex overflow-hidden rounded-full border ${onInk ? "border-ink-line" : "border-border-strong"}`}
    >
      {(["online", "offline"] as const).map((m) => (
        <button key={m} role="radio" aria-checked={mode === m} onClick={() => requestMode(m)} className={`${base} ${mode === m ? on : off}`}>
          {m === "online" ? "Online" : "Offline"}
        </button>
      ))}
    </div>
  );
}

export function OneWayNotice() {
  const { noticeOpen, confirmNotice, cancelNotice } = useOfflineMode();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!noticeOpen) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/55 px-6" role="dialog" aria-modal="true" aria-labelledby="one-way-title">
      <div className="w-full max-w-lg border border-border-strong bg-surface p-6 shadow-[0_20px_50px_-20px] shadow-black/50">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-text-faint">Offline mode</p>
        <h2 id="one-way-title" className="display mt-2 text-[28px] leading-none text-text">
          {ONE_WAY_NOTICE_TITLE}
        </h2>
        <div className="mt-4 space-y-3 text-[13px] leading-relaxed text-text-muted">
          {ONE_WAY_NOTICE.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
        {error && <p className="mt-3 text-[13px] text-danger">{error}</p>}
        <div className="mt-6 grid grid-cols-2 gap-3">
          <Button variant="secondary" onClick={cancelNotice} disabled={saving}>
            Stay online
          </Button>
          <Button
            loading={saving}
            onClick={() => {
              setSaving(true);
              setError(null);
              confirmNotice()
                .catch(() => setError("Couldn't switch to offline. Try again."))
                .finally(() => setSaving(false));
            }}
          >
            I understand, go offline
          </Button>
        </div>
      </div>
    </div>
  );
}
