import { useCallback, useEffect, useRef, useState } from "react";
import { usePolicy } from "../../policy/PolicyContext";
import { getInstallStatus, pickInstallPath, installRuntimeUpdate, type InstallStatus, type UninstallResult } from "../../api/tauri";
import { sanitizeError } from "../../lib/sanitize";
import { LibraryIcon } from "../../components/icons";
import { UninstallModal } from "./UninstallModal";
import { resultLine } from "../../ui/uninstall";

export function LibraryTab() {
  const { policy } = usePolicy();
  const [install, setInstall] = useState<InstallStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const [uninstallNote, setUninstallNote] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const status = await getInstallStatus();
      if (mountedRef.current) setInstall(status);
    } catch {
      // leave install as-is
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleRepair = useCallback(async () => {
    setBusy(true);
    try {
      // Missing/corrupt runtime DLLs are downloadable from the signed runtime channel. Fetch them,
      // then re-check so the status reflects the repair (fixes "DLLs missing, can't play" + a Verify
      // button that previously only re-checked without ever repairing).
      await installRuntimeUpdate(policy?.channel ?? "stable");
    } catch {
      // Fall through to refresh; any remaining problem is shown in the status below.
    } finally {
      try {
        const status = await getInstallStatus();
        if (mountedRef.current) setInstall(status);
      } catch { /* leave install as-is */ }
      if (mountedRef.current) setBusy(false);
    }
  }, [policy]);

  const handleLocate = useCallback(async () => {
    setBusy(true);
    try {
      const status = await pickInstallPath();
      if (mountedRef.current) setInstall(status);
    } catch {
      // user cancelled or error — leave current state
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, []);

  // The delete ran in Rust and already cleared the record; Home reads it again when it opens, so it shows Install.
  const handleUninstalled = useCallback(async (result: UninstallResult) => {
    setUninstalling(false);
    setUninstallNote(resultLine(result));
    await refresh();
  }, [refresh]);

  const located = install?.located === true;
  const hasError = install?.error != null;

  return (
    <div className="max-w-[560px] px-12 pb-6 pt-4">
      <h1 className="display text-[30px] leading-none text-text">Game files</h1>
      <p className="mt-1 text-[13px] text-text-muted">Your Dauntless install.</p>

      {uninstallNote && (
        <p className="mt-5 rounded-xl border border-border bg-surface-raised px-3.5 py-2.5 text-[13px] text-text" role="status">{uninstallNote}</p>
      )}

      {located ? (
        <div className="mt-7 space-y-4">
          <div className="glass rounded-2xl p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-text">Dauntless-Win64-Shipping.exe</p>
                <p className="mt-1 break-all text-[13px] text-text-muted">{install?.exePath}</p>
              </div>
              {hasError && (
                <span className="shrink-0 rounded-md bg-danger-muted px-2.5 py-1 text-[12px] font-medium text-danger">
                  Issues found
                </span>
              )}
              {!hasError && install?.exeSha256 && (
                <span className="shrink-0 rounded-md bg-accent-faint px-2.5 py-1 text-[12px] font-medium text-accent-hover">
                  Verified
                </span>
              )}
            </div>

            <div className="mt-5 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-[13px]">
              <span className="text-text-faint">SHA-256</span>
              <span className="font-mono text-text-muted">
                {install?.exeSha256 ? `${install.exeSha256.slice(0, 16)}…${install.exeSha256.slice(-16)}` : "—"}
              </span>

              <span className="text-text-faint">Runtime DLLs</span>
              <span className={hasError ? "text-text-muted" : "text-online"}>
                {install?.exeSha256 ? (hasError ? "Failed" : "Present") : "—"}
              </span>

              {hasError && (
                <>
                  <span className="text-text-faint">Status</span>
                  <span className="text-danger">{sanitizeError(install?.error)}</span>
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3">
            {hasError && (
              <button
                onClick={handleRepair}
                disabled={busy}
                className="rounded-lg border border-accent-muted bg-accent-muted/30 px-4 py-2 text-[13px] font-medium text-accent-hover transition-all hover:bg-accent-muted/50 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? "Downloading…" : "Download runtime DLLs"}
              </button>
            )}
            <button
              onClick={handleLocate}
              disabled={busy}
              className="rounded-lg border border-border bg-surface-raised px-4 py-2 text-[13px] font-medium text-text transition-all hover:bg-surface active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Locate again
            </button>
            <button
              onClick={() => setUninstalling(true)}
              disabled={busy}
              className="rounded-lg border border-danger/40 bg-danger-muted px-4 py-2 text-[13px] font-medium text-danger transition-all hover:brightness-110 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Uninstall
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-7 flex flex-col items-center rounded-sm border border-dashed border-border px-8 py-12 text-center">
          <div className="grid h-12 w-12 place-items-center rounded-sm bg-surface-raised text-text-faint">
            <LibraryIcon className="h-5 w-5" />
          </div>
          <p className="mt-4 text-sm font-medium text-text">No game folder yet</p>
          <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-text-muted">
            Choose the folder with your Dauntless game files (the one that contains Archon) and the launcher will check every file before you set sail.
          </p>
          <button
            onClick={handleLocate}
            disabled={busy}
            className="mt-5 rounded-lg border border-accent-muted bg-accent-muted/30 px-4 py-2 text-[13px] font-medium text-accent-hover transition-all hover:bg-accent-muted/50 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Opening…" : "Locate game"}
          </button>
        </div>
      )}
      {uninstalling && <UninstallModal onClose={() => setUninstalling(false)} onDone={handleUninstalled} />}
    </div>
  );
}
