// RR-38 offline mode without an online sign-in (for example when the account server can't be reached). Offline play
// needs no account.

import { BrandMark } from "../components/BrandMark";
import { OfflinePanel } from "./OfflinePanel";
import { OfflineRatesSection } from "./OfflineRatesSection";

export function OfflineShell() {
  return (
    <div className="flex h-full flex-col bg-bg">
      <header data-tauri-drag-region className="ink-panel relative z-10 flex h-16 shrink-0 items-center gap-3 pl-6 pr-28 text-on-ink">
        <div data-tauri-drag-region className="flex items-center gap-3 [&_*]:pointer-events-none">
          <BrandMark height={30} />
          <span className="border-l border-ink-line pl-3 text-[10px] font-semibold uppercase tracking-[0.3em] text-on-ink-muted">
            Ramsgate Reborn · Offline
          </span>
        </div>
      </header>
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <OfflinePanel />
        <div className="mx-auto max-w-xl px-8 pb-10">
          <OfflineRatesSection />
        </div>
      </main>
    </div>
  );
}
