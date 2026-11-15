// RR-38 offline mode: calls from the offline half of the UI to its native commands. Only offline_* commands (typed by
// OfflineCommand); no fetch, no account server, no online session. Arguments are rate values only.

import { invoke } from "@tauri-apps/api/core";
import type { OfflineCommand } from "./oneWay";
import type { OfflineRates } from "./rates";

function call<T>(command: OfflineCommand, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args);
}

export type LauncherMode = "online" | "offline";

export interface ModeState {
  mode: LauncherMode;
  noticeAccepted: boolean;
}

export interface InstallState {
  phase: "idle" | "running" | "done" | "failed";
  step: number;
  steps: number;
  message: string;
  error: string | null;
}

export interface OfflineOverview {
  root: string;
  logsDir: string;
  installed: boolean;
  onlineGameFound: boolean;
  componentFound: boolean;
  install: InstallState;
}

export interface RoleStatus {
  running: boolean;
  pid: number | null;
}

export interface StackStatus {
  configured?: boolean;
  mongod?: RoleStatus;
  backend?: RoleStatus;
  director?: RoleStatus;
  clientRunning?: boolean;
  gameServers?: number;
}

export interface RatesView {
  rates: OfflineRates;
  source: "file" | "official";
  warnings: string[];
}

export const getMode = () => call<ModeState>("offline_get_mode");
export const acceptNotice = () => call<ModeState>("offline_accept_notice");
export const setMode = (mode: LauncherMode) => call<ModeState>("offline_set_mode", { mode });

export const getOverview = () => call<OfflineOverview>("offline_overview");
export const getStatus = () => call<StackStatus>("offline_status");
export const startServers = () => call<StackStatus>("offline_start");
export const stopServers = () => call<StackStatus>("offline_stop");
export const restartServers = () => call<StackStatus>("offline_restart");
export const playOffline = () => call<{ started: boolean; pid: number }>("offline_play");
export const installOffline = () => call<InstallState>("offline_install");
export const getInstallState = () => call<InstallState>("offline_install_state");

export const getRates = () => call<RatesView>("offline_get_rates");
export const saveRates = (rates: OfflineRates) => call<RatesView>("offline_save_rates", { rates });
export const resetRates = () => call<RatesView>("offline_reset_rates");
export const applyRatesNow = () => call<{ applied: boolean; reason?: string }>("offline_apply_rates");

export interface LoadedSave {
  displayName: string;
  replacedProfile: boolean;
  signed: boolean;
  counts: Record<string, number>;
}

// Fills the local offline save from the downloaded copy with this file name (a name, never a path). Local only.
export const importSave = (fileName: string) => call<LoadedSave>("offline_import_save", { fileName });

export const openOfflineLogFolder = () => call<void>("offline_open_log_folder");
