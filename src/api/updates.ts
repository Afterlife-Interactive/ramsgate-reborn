import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";

export type LauncherUpdate = { version: string; notes?: string | null };

// Asks the update address compiled into this build (tauri.conf.json plugins.updater.endpoints) whether a newer
// signed launcher exists. A build with no address, an unreachable server or a bad signature all answer "no update":
// an update check must never get in the way of signing in or playing.
export async function checkLauncherUpdate(): Promise<LauncherUpdate | null> {
  try {
    return await invoke<LauncherUpdate | null>("launcher_update_check");
  } catch {
    return null;
  }
}

// The native side keeps only the update found by the last check, so there is nothing to close here. Kept so the
// screen code can drop an update it does not keep without caring how it is held.
export function releaseLauncherUpdate(_update: LauncherUpdate): void {}

export async function installLauncherUpdate(_update: LauncherUpdate): Promise<void> {
  // On Windows the NSIS updater (installMode "passive") downloads, then CLOSES and RE-OPENS the app
  // itself as part of the install. Calling relaunch() right after races that: the app restarts the
  // OLD version while the passive installer is mid-swap, so the installer aborts and nothing changes
  // ("installer flashes for a moment, then nothing"). Let the install own the close+reopen on
  // Windows; only relaunch on non-Windows platforms, where the installer does not restart the app.
  // The native side installs the update found by the last check, after checking its signature.
  await invoke("launcher_update_install");

  const isWindows =
    (typeof navigator !== "undefined" &&
      (navigator.userAgent.includes("Windows") || navigator.platform?.startsWith("Win"))) ??
    false;
  if (!isWindows) {
    await relaunch();
  }
}
