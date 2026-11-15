// Wording and state for the Uninstall confirm in the Game files tab. Pure, so node --test can check it.

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export type UninstallStage =
  | { kind: "measuring" }
  | { kind: "ready"; path: string; bytes: number; files: number; logsBytes: number }
  | { kind: "refused"; reason: string; path: string | null }
  | { kind: "working"; done: number; total: number; phase: "removing" | "logs" | "done" }
  | { kind: "failed"; message: string };

/** The Uninstall button is only live when the folder was checked and nothing is running. */
export function canConfirm(stage: UninstallStage): boolean {
  return stage.kind === "ready";
}

/** The modal can be dismissed only when no delete is running. */
export function canDismiss(stage: UninstallStage): boolean {
  return stage.kind !== "working";
}

export function progressPercent(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

export function workingLabel(stage: Extract<UninstallStage, { kind: "working" }>): string {
  if (stage.phase === "logs") return "Deleting launcher logs…";
  if (stage.phase === "done") return "Finishing…";
  if (stage.total <= 0) return "Deleting game files…";
  return `Deleting game files… ${stage.done.toLocaleString("en-US")} of ${stage.total.toLocaleString("en-US")} (${progressPercent(stage.done, stage.total)}%)`;
}

export function resultLine(result: { bytes: number; files: number; logsDeleted: boolean }): string {
  const base = `Uninstalled. Removed ${result.files.toLocaleString("en-US")} files (${formatBytes(result.bytes)}).`;
  const logs = result.logsDeleted ? " Launcher logs deleted too." : "";
  return `${base}${logs} Your settings, login and offline data were kept.`;
}

export function errorText(err: unknown): string {
  if (typeof err === "string" && err.trim()) return err;
  if (err instanceof Error && err.message) return err.message;
  return "The uninstall failed. Nothing more was changed.";
}
