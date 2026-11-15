import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { uninstallPreview, uninstallGame, type UninstallProgress, type UninstallResult } from "../../api/tauri";
import { canConfirm, canDismiss, errorText, formatBytes, progressPercent, workingLabel, type UninstallStage } from "../../ui/uninstall";

interface Props {
  onClose: () => void;
  onDone: (result: UninstallResult) => void;
}

// An in-app confirm (never the browser's confirm()). Shows the folder and its size, then deletes with real progress.
export function UninstallModal({ onClose, onDone }: Props) {
  const [stage, setStage] = useState<UninstallStage>({ kind: "measuring" });
  const [deleteLogs, setDeleteLogs] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    uninstallPreview()
      .then((p) => {
        if (!mountedRef.current) return;
        if (p.canUninstall && p.path) {
          setStage({ kind: "ready", path: p.path, bytes: p.bytes, files: p.files, logsBytes: p.logsBytes });
        } else {
          setStage({ kind: "refused", reason: p.reason ?? "The game can't be uninstalled right now.", path: p.path ?? null });
        }
      })
      .catch((err) => mountedRef.current && setStage({ kind: "failed", message: errorText(err) }));
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    listen<UninstallProgress>("game-uninstall-progress", (e) => {
      if (mountedRef.current) setStage((s) => (s.kind === "working" ? { kind: "working", done: e.payload.done, total: e.payload.total || s.total, phase: e.payload.phase } : s));
    }).then((fn) => { if (cancelled) fn(); else off = fn; }).catch(() => {});
    return () => { cancelled = true; off?.(); };
  }, []);

  const confirm = async () => {
    if (!canConfirm(stage)) return;
    setStage({ kind: "working", done: 0, total: 0, phase: "removing" });
    try {
      const result = await uninstallGame(deleteLogs);
      if (mountedRef.current) onDone(result);
    } catch (err) {
      if (mountedRef.current) setStage({ kind: "failed", message: errorText(err) });
    }
  };

  const close = () => { if (canDismiss(stage)) onClose(); };
  const working = stage.kind === "working" ? stage : null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 px-6" role="dialog" aria-modal="true" aria-labelledby="uninstall-title" onClick={close}>
      <div className="glass w-full max-w-[460px] rounded-2xl p-6" onClick={(e) => e.stopPropagation()}>
        <h2 id="uninstall-title" className="display text-[22px] leading-none text-text">Uninstall Dauntless?</h2>

        {stage.kind === "measuring" && <p className="mt-4 animate-pulse text-[13px] text-text-muted">Checking the game folder…</p>}

        {stage.kind === "ready" && (
          <div className="mt-4 space-y-3 text-[13px] text-text-muted">
            <p>This deletes the game the launcher installed:</p>
            <p className="break-all rounded-lg bg-surface-raised px-3 py-2 font-mono text-text">{stage.path}</p>
            <p>{formatBytes(stage.bytes)} in {stage.files.toLocaleString("en-US")} files will be removed. Your launcher settings, login and offline data are not touched.</p>
            <label className="flex items-start gap-2 text-text">
              <input type="checkbox" checked={deleteLogs} onChange={(e) => setDeleteLogs(e.target.checked)} className="mt-0.5" />
              <span>Also delete launcher logs{stage.logsBytes > 0 ? ` (${formatBytes(stage.logsBytes)})` : ""}</span>
            </label>
          </div>
        )}

        {stage.kind === "refused" && (
          <div className="mt-4 space-y-2 text-[13px]" role="alert">
            <p className="text-danger">{stage.reason}</p>
            {stage.path && <p className="break-all font-mono text-text-muted">{stage.path}</p>}
          </div>
        )}

        {working && (
          <div className="mt-4 space-y-3 text-[13px] text-text-muted" aria-live="polite">
            <p>{workingLabel(working)}</p>
            <div className="h-2 overflow-hidden rounded-full bg-surface-raised">
              <div
                className={`h-full rounded-full bg-accent transition-[width] duration-200 ${working.total <= 0 ? "w-1/3 animate-pulse" : ""}`}
                style={working.total > 0 ? { width: `${progressPercent(working.done, working.total)}%` } : undefined}
              />
            </div>
            <p>Keep the launcher open until this finishes.</p>
          </div>
        )}

        {stage.kind === "failed" && (
          <p className="mt-4 text-[13px] text-danger" role="alert">{stage.message}</p>
        )}

        <div className="mt-6 flex justify-end gap-3">
          <button onClick={close} disabled={!canDismiss(stage)} className="rounded-lg border border-border bg-surface-raised px-4 py-2 text-[13px] font-medium text-text transition-all hover:bg-surface disabled:cursor-not-allowed disabled:opacity-40">
            {stage.kind === "refused" || stage.kind === "failed" ? "Close" : "Cancel"}
          </button>
          {(stage.kind === "ready" || stage.kind === "measuring" || stage.kind === "working") && (
            <button onClick={confirm} disabled={!canConfirm(stage)} className="rounded-lg border border-danger/40 bg-danger-muted px-4 py-2 text-[13px] font-medium text-danger transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40">
              {stage.kind === "working" ? "Uninstalling…" : "Uninstall"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
