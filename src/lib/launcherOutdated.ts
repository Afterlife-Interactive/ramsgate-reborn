// The server refuses a launcher that is below its minimum version with GAME_BUILD_UNSUPPORTED. The native side turns
// that into a text starting with LAUNCHER_OUTDATED_TEXT_START (kept in step with auth.rs by a test); the screen
// then fetches and installs the update on its own instead of waiting for the player to find the website.
export const LAUNCHER_OUTDATED_TEXT_START = "Please update the launcher";

export const LAUNCHER_OUTDATED_EVENT = "launcher-outdated";

export function isLauncherOutdatedMessage(message: string | null | undefined): boolean {
  return typeof message === "string" && message.trim().startsWith(LAUNCHER_OUTDATED_TEXT_START);
}

// Called where a refusal text is shown from an event handler; the app shell listens and starts the update.
export function announceIfLauncherOutdated(message: string | null | undefined): void {
  if (isLauncherOutdatedMessage(message) && typeof window !== "undefined") {
    window.dispatchEvent(new Event(LAUNCHER_OUTDATED_EVENT));
  }
}
