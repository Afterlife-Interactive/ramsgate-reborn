// RR-38 offline mode: the Offline panel on the Play tab. One "Install offline" button, then "Play offline". Offline mode
// has its own local save made on this PC. Everything here runs through offline_* commands; this file never calls the
// account server. "Load my online save" is the one optional exception to "nothing comes from online": the signed-in
// launcher hands this panel a function that fetches a read-only copy of the player's own save (done outside this folder, in
// the online half), and this panel then only asks the local offline_import_save command to read that one saved copy.
// One way, down only: nothing here can send anything out.

import { useCallback, useEffect, useRef, useState } from "react";
import { BrandMark } from "../components/BrandMark";
import { PlayIcon } from "../components/icons";
import { sanitizeError } from "../lib/sanitize";
import {
  getInstallState,
  getOverview,
  getStatus,
  importSave,
  installOffline,
  openOfflineLogFolder,
  playOffline,
  restartServers,
  stopServers,
  type InstallState,
  type OfflineOverview,
  type StackStatus,
} from "./api";
import { ModeSwitch } from "./ModeSwitch";

/** Supplied by the signed-in launcher. Resolves with the saved copy's file name, or a message when it is not available. */
export type SavedCopyResult = { status: "saved"; fileName: string } | { status: "unavailable"; message: string };
export interface OnlineSaveSource {
  getSavedCopy: () => Promise<SavedCopyResult>;
}

type Busy = null | "stop" | "restart" | "play" | "load";

function errorText(err: unknown, fallback: string): string {
  return sanitizeError(typeof err === "string" ? err : err instanceof Error ? err.message : undefined) || fallback;
}

function serversUp(s: StackStatus | null): boolean {
  return !!(s?.mongod?.running && s?.backend?.running && s?.director?.running);
}

export function OfflinePanel({ onlineSave }: { onlineSave?: OnlineSaveSource } = {}) {
  const [overview, setOverview] = useState<OfflineOverview | null>(null);
  const [status, setStatus] = useState<StackStatus | null>(null);
  const [install, setInstall] = useState<InstallState | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmLoad, setConfirmLoad] = useState(false);
  const [loadedNote, setLoadedNote] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const refreshOverview = useCallback(async () => {
    try {
      const o = await getOverview();
      if (mounted.current) {
        setOverview(o);
        setInstall(o.install);
      }
      return o;
    } catch (err) {
      if (mounted.current) setError(errorText(err, "Couldn't read the offline folder."));
      return null;
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await getStatus();
      if (mounted.current) setStatus(s);
      return s;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    void refreshOverview().then((o) => { if (o?.installed) void refreshStatus(); });
  }, [refreshOverview, refreshStatus]);

  const installing = install?.phase === "running";

  // One progress state while the install runs: poll until it is done or failed.
  useEffect(() => {
    if (!installing) return;
    const t = setInterval(() => {
      void getInstallState().then(async (s) => {
        if (!mounted.current) return;
        setInstall(s);
        if (s.phase !== "running") {
          await refreshOverview();
          await refreshStatus();
        }
      }).catch(() => {});
    }, 1500);
    return () => clearInterval(t);
  }, [installing, refreshOverview, refreshStatus]);

  const installed = overview?.installed === true;

  useEffect(() => {
    if (!installed) return;
    const t = setInterval(() => { void refreshStatus(); }, 10_000);
    return () => clearInterval(t);
  }, [installed, refreshStatus]);

  const run = useCallback(async (what: Busy, fn: () => Promise<void>, fallback: string) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
    } catch (err) {
      if (mounted.current) setError(errorText(err, fallback));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }, []);

  const startInstall = async () => {
    setError(null);
    try {
      setInstall(await installOffline());
    } catch (err) {
      setError(errorText(err, "Offline install couldn't start."));
    }
  };

  const loadOnlineSave = async () => {
    if (!onlineSave) return;
    setConfirmLoad(false);
    setLoadedNote(null);
    await run("load", async () => {
      const copy = await onlineSave.getSavedCopy();
      if (copy.status !== "saved") {
        setError(copy.message);
        return;
      }
      const done = await importSave(copy.fileName);
      const characters = done.counts?.characters ?? 0;
      setLoadedNote(`Loaded the online save for ${done.displayName} (${characters} character${characters === 1 ? "" : "s"}). Your online account was not changed.`);
      await refreshOverview();
      await refreshStatus();
    }, "Couldn't load your online save.");
  };

  const up = serversUp(status);
  const clientRunning = status?.clientRunning === true;

  const ghost =
    "slant-btn flex h-11 shrink-0 items-center justify-center gap-2 border-0 bg-on-ink/15 px-6 text-[12px] font-bold uppercase tracking-[0.14em] text-on-ink transition-colors hover:bg-on-ink/25 disabled:cursor-not-allowed disabled:opacity-40";
  const solid =
    "slant-btn flex h-12 min-w-[190px] shrink-0 items-center justify-center gap-2.5 bg-cta px-8 text-[13px] font-bold uppercase tracking-[0.14em] text-on-ink transition-colors hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-40";
  const card = "border border-border bg-surface p-5";

  const progressLine =
    install?.phase === "running"
      ? `Step ${install.step} of ${install.steps}: ${install.message}`
      : install?.phase === "failed"
      ? install.error ?? "Offline install failed. See the offline log folder."
      : null;

  return (
    <div className="flex min-h-full flex-col">
      <section className="ink-panel slant-bottom relative overflow-hidden px-10 pb-20 pt-8 text-on-ink">
        <div aria-hidden className="pointer-events-none absolute -right-10 top-1/2 -translate-y-1/2 opacity-[0.07]">
          <BrandMark height={300} />
        </div>
        <div className="relative max-w-2xl">
          <ModeSwitch />
          <h1 className="display mt-5 text-[52px] leading-[0.95]">{clientRunning ? "Playing offline" : "Offline"}</h1>
          <p className="mt-3 max-w-lg text-[13px] leading-relaxed text-on-ink-muted">
            Play on servers that run on this PC. Offline mode keeps its own separate save and never connects to your online account.
          </p>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            {!installed && (
              <button
                className={solid}
                disabled={installing || !overview?.onlineGameFound || !overview?.componentFound}
                onClick={() => void startInstall()}
              >
                {installing ? "Installing…" : "Install offline"}
              </button>
            )}
            {installed && (
              <button
                className={solid}
                disabled={busy !== null || clientRunning}
                onClick={() => run("play", async () => {
                  await playOffline();
                  await refreshStatus();
                }, "Couldn't start offline play.")}
              >
                <PlayIcon className="h-4 w-4" />
                {busy === "play" ? "Starting…" : "Play offline"}
              </button>
            )}
            {installed && up && (
              <button className={ghost} disabled={busy !== null} onClick={() => run("stop", async () => { setStatus(await stopServers()); }, "Couldn't stop the offline servers.")}>
                {busy === "stop" ? "Stopping…" : "Stop servers"}
              </button>
            )}
            {installed && (
              <button className={ghost} disabled={busy !== null} onClick={() => run("restart", async () => { setStatus(await restartServers()); }, "Couldn't restart the offline servers.")}>
                {busy === "restart" ? "Restarting…" : up ? "Restart servers" : "Start servers"}
              </button>
            )}
            {installed && onlineSave && (
              <button className={ghost} disabled={busy !== null || clientRunning} onClick={() => { setLoadedNote(null); setConfirmLoad(true); }}>
                {busy === "load" ? "Loading…" : "Load my online save"}
              </button>
            )}
            <button className={ghost} onClick={() => void openOfflineLogFolder().catch(() => {})}>
              Open log folder
            </button>
          </div>

          <p className="mt-4 text-[12px] text-on-ink-muted">
            {installing || install?.phase === "failed"
              ? progressLine
              : !installed
              ? "Offline mode is not installed yet."
              : status === null
              ? "Checking the offline servers…"
              : up
              ? `Offline servers running${status.gameServers ? ` · ${status.gameServers} game server${status.gameServers === 1 ? "" : "s"}` : ""}${clientRunning ? " · game open" : ""}`
              : "Offline servers stopped. Play offline starts them."}
          </p>
          {confirmLoad && (
            <div className="mt-3 max-w-lg border border-on-ink/30 p-4 text-[12px] leading-relaxed text-on-ink-muted">
              <p>
                This replaces your offline save with a read-only copy of your online save. Your current offline save is backed up
                first. It only goes down: nothing from offline is ever sent to your online account.
              </p>
              <div className="mt-3 flex gap-3">
                <button className={ghost} onClick={() => void loadOnlineSave()}>Load it</button>
                <button className={ghost} onClick={() => setConfirmLoad(false)}>Cancel</button>
              </div>
            </div>
          )}
          {loadedNote && <p className="mt-2 max-w-lg text-[13px] text-on-ink-muted">{loadedNote}</p>}
          {error && <p className="mt-2 max-w-lg text-[13px] text-[oklch(0.8_0.12_25)]">{error}</p>}
        </div>
      </section>

      <div className="relative z-10 -mt-10 grid gap-4 px-10 pb-10">
        {!installed && overview && (
          <article className={card}>
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-text-faint">Install offline</p>
            <p className="mt-2 text-[13px] leading-relaxed text-text-muted">
              One button sets everything up: a separate copy of the Ramsgate Reborn game already installed on this PC, the
              offline runtime inside that copy only, and a fresh offline save. Ramsgate Reborn does not include any Phoenix Labs
              game files or data. Your online game folder is not changed.
            </p>
            <ul className="mt-3 space-y-1 text-[12px] text-text-muted">
              <li>{overview.onlineGameFound ? "✓" : "✗"} Your installed game {overview.onlineGameFound ? "was found" : "was not found: install it from the online Play tab first"}</li>
              <li>{overview.componentFound ? "✓" : "✗"} Offline files {overview.componentFound ? "are ready" : "are not part of this launcher build yet"}</li>
            </ul>
          </article>
        )}
      </div>
    </div>
  );
}
