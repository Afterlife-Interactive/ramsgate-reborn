// RR-81: the Home tab showed "In the hunt" after the game was closed, because nothing moved it out of the running
// phase except a manual "Check status". While the phase is running the tab polls; this decides what each poll means.
//
// The launcher waits on the game process it started, so its own answer ("running" or "exited") is trusted first. The
// process-list scan is only used when this launcher run did not start the game (the phase came from "Check status"),
// because it can also count a client the launcher did not start or a server whose command line Windows hides.

export type LaunchedGameState = "none" | "running" | "exited";

/** Poll interval while the game is open. The launched-game check is a cheap read, so this can be short. */
export const RUNNING_POLL_MS = 3_000;

/**
 * Whether the game still counts as running.
 * `launched` is the launcher's own state for the game it started; `scan` reads the process list and is only called
 * when the launcher did not start a game this run. A failing scan keeps the current phase, it is retried next poll.
 */
export async function stillRunning(
  launched: () => Promise<LaunchedGameState>,
  scan: () => Promise<boolean>,
): Promise<boolean> {
  const state = await launched();
  if (state === "running") return true;
  if (state === "exited") return false;
  return scan();
}
