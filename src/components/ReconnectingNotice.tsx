import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

// The native side retries quietly for up to about 90 s when the server is briefly away (restart) and sends
// `launcher-reconnecting` true/false around it. Show a calm notice for that time instead of an error.
export function ReconnectingNotice() {
  const [active, setActive] = useState(false);

  useEffect(() => {
    const unlisten = listen<boolean>("launcher-reconnecting", (event) => setActive(event.payload === true));
    return () => { void unlisten.then((fn) => fn()).catch(() => {}); };
  }, []);

  if (!active) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-5 bottom-5 z-50 mx-auto flex max-w-sm items-center gap-3 rounded-xl border border-border-strong bg-surface px-4 py-3 shadow-[0_12px_30px_-12px] shadow-black/25"
    >
      <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent" />
      <div className="min-w-0">
        <p className="text-[12px] font-semibold text-text">Reconnecting…</p>
        <p className="mt-0.5 text-[11px] text-text-muted">The server is restarting. This usually takes under a minute.</p>
      </div>
    </div>
  );
}
