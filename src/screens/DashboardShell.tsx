import { lazy, Suspense, useEffect, useState, type ComponentType, type SVGProps } from "react";
import { AboutIcon, AdminIcon, HomeIcon, LibraryIcon, PlannerIcon, SettingsIcon } from "../components/icons";
import { useAuth } from "../auth/AuthContext";
import { usePolicy } from "../policy/PolicyContext";
import { ADMIN_BUILD } from "../lib/buildConfig";
import { getCrashDumpOffer, isGameRunning, reportCrash, type CrashDumpOffer } from "../api/tauri";
import { CrashDumpPrompt } from "./dashboard/CrashDumpPrompt";
import { BrandMark } from "../components/BrandMark";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { HomeTab } from "./dashboard/HomeTab";
import { LibraryTab } from "./dashboard/LibraryTab";
import { AccountTab } from "./dashboard/AccountTab";
import { SettingsTab } from "./dashboard/SettingsTab";
import { BuildPlannerTab } from "./dashboard/BuildPlannerTab";
import { AboutTab } from "./dashboard/AboutTab";
import { OfflineHome } from "./dashboard/OfflineHome";
import { useOfflineMode } from "../offline/OfflineModeContext";

type Tab = "home" | "library" | "planner" | "account" | "settings" | "about" | "admin";

const NAV_ITEMS: { id: Tab; label: string; Icon: ComponentType<SVGProps<SVGSVGElement>> }[] = [
  { id: "home", label: "Play", Icon: HomeIcon },
  { id: "library", label: "Game files", Icon: LibraryIcon },
  { id: "planner", label: "Builds", Icon: PlannerIcon },
  { id: "settings", label: "Settings", Icon: SettingsIcon },
  { id: "about", label: "About", Icon: AboutIcon },
];

// Admin launcher build only: ADMIN_BUILD is a build-time constant, so player builds drop the tab's code
// entirely. Who may actually use it is decided by the server from the account's admin role.
const AdminTab = ADMIN_BUILD ? lazy(() => import("./dashboard/AdminTab")) : null;

const TAB_CONTENT: Partial<Record<Tab, ComponentType>> = {
  home: HomeTab,
  library: LibraryTab,
  planner: BuildPlannerTab,
  account: AccountTab,
  settings: SettingsTab,
  about: AboutTab,
  ...(AdminTab ? { admin: AdminTab } : {}),
};

export function DashboardShell() {
  const { account } = useAuth();
  const { policy } = usePolicy();
  const isAdmin = ADMIN_BUILD && (policy?.roles.includes("admin") ?? false);
  const [tab, setTab] = useState<Tab>("home");
  const { mode } = useOfflineMode();
  const offline = mode === "offline";
  // RR-38: in offline mode the Play tab is the offline panel; the online Play screen (and its server polling) is not shown.
  const ActiveTab = offline && tab === "home" ? OfflineHome : TAB_CONTENT[tab] ?? HomeTab;
  const name = account?.displayName ?? "Player";

  // Automatic crash reports: when the game stops (or at start-up, for a game that ended while the launcher was
  // closed) ask the native side to send the last session's logs if it ended abnormally. It decides everything
  // itself (exit code, server policy, once only), and any failure here is deliberately ignored.
  // Not in offline mode: offline sessions have no online session folder, and nothing about them is ever reported.
  // After the logs, the game's crash dump: sent by itself if Settings says always, asked about if it says ask.
  const [dumpOffer, setDumpOffer] = useState<CrashDumpOffer | null>(null);
  useEffect(() => {
    if (offline) return;
    let wasRunning = false;
    const report = () =>
      void reportCrash()
        .catch(() => false)
        .then(() => getCrashDumpOffer())
        .then((offer) => { if (offer) setDumpOffer(offer); })
        .catch(() => {});
    report();
    const timer = setInterval(() => {
      isGameRunning()
        .then((running) => {
          if (wasRunning && !running) report();
          wasRunning = running;
        })
        .catch(() => {});
    }, 8000);
    return () => clearInterval(timer);
  }, [offline]);

  const items = isAdmin ? [...NAV_ITEMS, { id: "admin" as const, label: "Admin", Icon: AdminIcon }] : NAV_ITEMS;

  return (
    <div className="flex h-full flex-col">
      {/* Top: the dragon and the name on the left, the rest of the strip drags the window. */}
      <header data-tauri-drag-region className="flex h-14 shrink-0 items-center gap-3 pl-6 pr-28">
        <div data-tauri-drag-region className="flex items-center gap-2.5 [&_*]:pointer-events-none">
          <BrandMark height={28} />
          <span className="display text-[15px] text-text">Ramsgate Reborn</span>
        </div>
      </header>

      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <ErrorBoundary resetKey={tab}>
          <Suspense fallback={null}>
            <div key={tab} className="tab-enter h-full">
              <ActiveTab />
            </div>
          </Suspense>
        </ErrorBoundary>
      </main>

      {/* Bottom dock: sections as icon pills, the account at the far end. */}
      <nav className="shrink-0 px-6 pb-5 pt-2" aria-label="Launcher sections">
        <div className="glass mx-auto flex w-fit items-center gap-1 rounded-full p-1.5 shadow-[0_20px_40px_-20px] shadow-black/80" role="tablist">
          {items.map(({ id, label, Icon }) => {
            const active = tab === id;
            return (
              <button
                key={id}
                role="tab"
                aria-selected={active}
                onClick={() => setTab(id)}
                className={`flex h-10 items-center gap-2 rounded-full px-4 text-[13px] font-medium transition-[background-color,color] duration-200 ${
                  active ? "bg-accent text-on-ink" : "text-text-muted hover:bg-white/8 hover:text-text"
                }`}
              >
                <Icon className="h-[18px] w-[18px]" />
                {(active || items.length <= 5) && <span>{label}</span>}
              </button>
            );
          })}

          <span aria-hidden className="mx-1.5 h-6 w-px bg-border-strong" />

          <button
            role="tab"
            aria-selected={tab === "account"}
            onClick={() => setTab("account")}
            aria-label="Open account"
            className={`flex h-10 items-center gap-2 rounded-full pl-1 pr-4 transition-colors duration-200 ${
              tab === "account" ? "bg-accent text-on-ink" : "text-text-muted hover:bg-white/8 hover:text-text"
            }`}
          >
            <span className="grid h-8 w-8 place-items-center rounded-full bg-glow/25 text-[13px] font-semibold text-text ring-1 ring-glow/50">
              {name.slice(0, 1).toUpperCase()}
            </span>
            <span className="max-w-[120px] truncate text-[13px] font-medium">{name}</span>
          </button>
        </div>
      </nav>

      {dumpOffer && !offline && <CrashDumpPrompt offer={dumpOffer} onClose={() => setDumpOffer(null)} />}
    </div>
  );
}
