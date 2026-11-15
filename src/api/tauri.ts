import { invoke } from "@tauri-apps/api/core";
import type { LauncherPolicy, LogPaths } from "./types";
import type { LaunchedGameState } from "../launch/runningPhase";

export interface InstallStatus {
  located: boolean;
  exePath?: string | null;
  exeSha256?: string | null;
  error?: string | null;
  /** A game location was saved before, but the game file is gone. */
  savedMissing?: boolean;
}

export async function getInstallStatus(): Promise<InstallStatus> {
  return invoke<InstallStatus>("get_install_status");
}

export async function pickInstallPath(): Promise<InstallStatus> {
  return invoke<InstallStatus>("pick_install_path");
}

/** Where an existing Dauntless install seems to be (a read-only look at the usual folders), or null. */
export async function findExistingInstall(): Promise<string | null> {
  return invoke<string | null>("find_existing_install");
}

/** Saves the install found above. Call only after the player confirms. */
export async function useExistingInstall(): Promise<InstallStatus> {
  return invoke<InstallStatus>("use_existing_install");
}

export async function isGameRunning(): Promise<boolean> {
  return invoke<boolean>("is_game_running");
}

/** State of the game this launcher run started: "none" (nothing launched), "running" or "exited". */
export async function launchedGameState(): Promise<LaunchedGameState> {
  return invoke<LaunchedGameState>("launched_game_state");
}

export async function setLauncherMinimized(minimized: boolean): Promise<void> {
  return invoke<void>("set_launcher_minimized", { minimized });
}

export async function secureLaunch(expectedChannel: string): Promise<void> {
  return invoke<void>("secure_launch", { expectedChannel });
}

// The backend's launch queue. Anything but "queued" (including an older backend) means the game may start.
export type QueueAnswer = { kind: "go" } | { kind: "queued"; position: number; length: number };

export async function queuePoll(): Promise<QueueAnswer> {
  return invoke<QueueAnswer>("native_queue_poll");
}

export async function queueLeave(): Promise<void> {
  return invoke<void>("native_queue_leave");
}

export interface RuntimeUpdateStatus {
  available: boolean;
  version?: string | null;
  currentSha256?: string | null;
  latestSha256?: string | null;
  size?: number | null;
}

export async function checkRuntimeUpdate(channel = "stable"): Promise<RuntimeUpdateStatus> {
  return invoke<RuntimeUpdateStatus>("check_runtime_update", { channel });
}

export async function installRuntimeUpdate(channel = "stable"): Promise<RuntimeUpdateStatus> {
  return invoke<RuntimeUpdateStatus>("install_runtime_update", { channel });
}

/** Moves the player's Dauntless Revived progress over, using the account key saved on this PC. */
export type DrClaimStatus = "ported" | "already" | "no_match" | "not_found" | "fetching" | "wait" | "has_progress" | "in_game" | "not_ready" | "no_key"
  | "not_copied_yet" | "transfers_ended" | "try_later" | "declined";

/**
 * The one-time Dauntless Revived choice. One status read (POST /launcher/v1/dr-choice/status) and one decision (POST /launcher/v1/dr-choice)
 * that is only sent after the second confirm. The PC's account keys are added by the native side, in the body; the page never sees them.
 */
export interface DrChoiceReply { state: string; text?: string | null }

export async function drChoiceStatus(): Promise<DrChoiceReply> {
  return invoke<DrChoiceReply>("native_dr_choice_status");
}

export async function drChoiceDecide(choice: "transfer" | "decline"): Promise<DrChoiceReply> {
  return invoke<DrChoiceReply>("native_dr_choice_decide", { choice });
}

/**
 * The line for players whose Dauntless Revived copy is not here yet. Join (only on the player's click), status (also the heartbeat) and leave.
 * Same key handling as the choice: the native side adds the keys to the body, the page never sees them.
 */
export interface DrQueueReply {
  state: string;
  text?: string | null;
  queueState?: string | null;
  position?: number | null;
  waitingTotal?: number | null;
  etaLowMinutes?: number | null;
  etaHighMinutes?: number | null;
  etaText?: string | null;
  longWait?: boolean | null;
  startFreshText?: string | null;
  retryAfterSeconds?: number | null;
}

export async function drQueueJoin(): Promise<DrQueueReply> {
  return invoke<DrQueueReply>("native_dr_queue_join");
}

export async function drQueueStatus(): Promise<DrQueueReply> {
  return invoke<DrQueueReply>("native_dr_queue_status");
}

export async function drQueueLeave(): Promise<DrQueueReply> {
  return invoke<DrQueueReply>("native_dr_queue_leave");
}

export async function pickDrKeyFile(): Promise<"ok" | "cancelled" | "invalid"> {
  return invoke<"ok" | "cancelled" | "invalid">("native_pick_dr_key_file");
}

export async function setDrKey(key: string): Promise<"ok" | "invalid"> {
  return invoke<"ok" | "invalid">("native_set_dr_key", { key });
}

export async function drClaim(replace = false): Promise<DrClaimStatus> {
  return invoke<DrClaimStatus>("native_dr_claim", { replace });
}

export async function getPolicy(channel?: "stable" | "beta"): Promise<LauncherPolicy> {
  return invoke<LauncherPolicy>("native_get_policy", { channel: channel ?? null });
}

export async function getLogPaths(): Promise<LogPaths> {
  return invoke<LogPaths>("native_get_log_paths");
}

export async function openLogFolder(): Promise<void> {
  return invoke<void>("native_open_log_folder");
}

export async function uploadLastSession(): Promise<number> {
  return invoke<number>("native_upload_last_session");
}

export interface GameManifest {
  version: string;
  fileName: string;
  size: number;
  sha256: string;
  format: string;
}

export interface GameDownloadProgress {
  phase: "downloading" | "verifying" | "unpacking" | "done";
  received: number;
  total: number;
  /** Where the game is being installed. */
  folder: string;
  /** Smoothed download speed and time left at that speed; absent until a speed is known. */
  bytesPerSecond?: number | null;
  secondsLeft?: number | null;
}

/** The game download the server offers, or null when it offers none. */
export async function getGameManifest(): Promise<GameManifest | null> {
  return invoke<GameManifest | null>("native_game_manifest");
}

/** Downloads, verifies and unpacks the game into a folder the launcher picks itself. */
export async function downloadGame(): Promise<boolean> {
  return invoke<boolean>("native_download_game");
}

/** Sends the last session's logs if the game crashed and the server asks for automatic reports. */
export async function reportCrash(): Promise<boolean> {
  return invoke<boolean>("native_report_crash");
}

/** Whether the game's crash dumps are sent: ask after each crash (default), always, or never. */
export type CrashDumpChoice = "ask" | "always" | "never";

export async function getCrashDumpChoice(): Promise<CrashDumpChoice> {
  return invoke<CrashDumpChoice>("native_get_crash_dump_choice");
}

export async function setCrashDumpChoice(choice: CrashDumpChoice): Promise<void> {
  return invoke<void>("native_set_crash_dump_choice", { choice });
}

/** Crash dumps from the last session that the player has not been asked about yet, or null. */
export interface CrashDumpOffer {
  count: number;
  bytes: number;
}

export async function getCrashDumpOffer(): Promise<CrashDumpOffer | null> {
  return invoke<CrashDumpOffer | null>("native_crash_dump_offer");
}

/** Sends (or keeps) the last session's crash dumps; remember saves the answer as the setting. Returns how many went. */
export async function answerCrashDump(send: boolean, remember: boolean): Promise<number> {
  return invoke<number>("native_answer_crash_dump", { send, remember });
}

/** Where the downloaded game is, how big, and whether it may be deleted right now. Changes nothing. */
export interface UninstallPreview {
  canUninstall: boolean;
  reason?: string | null;
  path?: string | null;
  bytes: number;
  files: number;
  logsBytes: number;
}

export interface UninstallResult {
  path: string;
  files: number;
  bytes: number;
  logsDeleted: boolean;
}

export interface UninstallProgress {
  phase: "removing" | "logs" | "done";
  done: number;
  total: number;
}

export async function uninstallPreview(): Promise<UninstallPreview> {
  return invoke<UninstallPreview>("uninstall_preview");
}

/** Deletes the launcher-installed game folder (local only). Launcher settings, logins and offline data are kept. */
export async function uninstallGame(deleteLogs: boolean): Promise<UninstallResult> {
  return invoke<UninstallResult>("uninstall_game", { deleteLogs });
}

export interface GameLanguageOption {
  code: string;
  name: string;
}

export async function getGameLanguages(): Promise<GameLanguageOption[]> {
  return invoke<GameLanguageOption[]>("native_game_languages");
}

export async function getGameLanguage(): Promise<string> {
  return invoke<string>("native_get_game_language");
}

export async function setGameLanguage(code: string): Promise<void> {
  return invoke<void>("native_set_game_language", { code });
}
