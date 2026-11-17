// "Reset my save data" on the Account tab. Pure text and rules, so the card stays thin and can be tested without a window.
// Nothing is sent until the game is closed, no Dauntless Revived transfer is pending and the player has typed the confirm word.

export const RESET_WORD = "RESET";

export const RESET_TEXT = {
  button: "Reset my save data",
  heading: "Start over with a new save",
  warning: "This deletes ALL your Ramsgate Reborn progress, gear and currency. It cannot be undone from the launcher.",
  intro: "This gives your account a brand new save, as if you had just made it.",
  deletedTitle: "What is deleted",
  deleted: "All your progress, levels, items, currency and unlocks in the game.",
  backup: "A backup of your save is kept for 30 days. Only staff can restore it, and only if you ask.",
  keptTitle: "What stays",
  kept: "Your account and login, your Discord link, your friends list and your Dauntless Revived link.",
  retransfer: "If you moved your Dauntless Revived progress before, you can ask for it again afterwards.",
  closeGame: "Close the game completely first.",
  once: "You can reset once every 24 hours.",
  typePrompt: "Type RESET to confirm.",
  confirmButton: "Reset my save data now",
  working: "Resetting…",
  cancel: "Cancel",
  blockedGame: "Close the game to reset your save.",
  blockedTransfer: "Finish or skip your Dauntless Revived transfer on the Home tab first.",
  reset: "Your save data was reset. You can start the game for a fresh start. A backup is kept for 30 days.",
  already_fresh: "Your save is already new, so there was nothing to reset.",
  confirm_required: "Type RESET to confirm.",
  not_allowed: "This can't be done right now. Nothing was changed.",
  in_game: "Close the game first, then try again. Your save can only be reset while the game is closed.",
  cooldown: "You can only reset your save once every 24 hours. Please try again later.",
  wait: "Too many tries. Please wait a few minutes and try again.",
  unavailable: "Resetting your save isn't available yet.",
  error: "We couldn't reset your save just now. Nothing was changed. Please try again in a little while.",
  failed: "We could not reach the server just now. Nothing was changed. You can try again.",
} as const;

export type ResetOutcome = "reset" | "already_fresh" | "confirm_required" | "not_allowed" | "in_game" | "cooldown" | "wait" | "unavailable" | "error" | "unknown";

/** Answers that mean the save is new now. */
export const RESET_DONE: readonly string[] = ["reset", "already_fresh"];

/** The line for a server answer. Only "not_allowed" may carry the server's own sentence (it says why); a cooldown adds the wait. */
export function resetMessage(outcome: string | null | undefined, server?: string | null, retryAfterSeconds?: number | null): string {
  switch (outcome) {
    case "reset": case "already_fresh": case "confirm_required": case "in_game": case "wait": case "unavailable": case "error":
      return RESET_TEXT[outcome];
    case "not_allowed": {
      const t = typeof server === "string" ? server.trim() : "";
      return t.length > 0 && t.length <= 300 && !/[–—]/.test(t) ? t : RESET_TEXT.not_allowed;
    }
    case "cooldown": {
      const hours = typeof retryAfterSeconds === "number" && retryAfterSeconds > 0 ? Math.ceil(retryAfterSeconds / 3600) : 0;
      return hours > 0 ? `${RESET_TEXT.cooldown} About ${hours} ${hours === 1 ? "hour" : "hours"} left.` : RESET_TEXT.cooldown;
    }
    case "unknown": return RESET_TEXT.error;
    default: return RESET_TEXT.failed;
  }
}

/** Dauntless Revived states where a transfer is still open or waiting: resetting is held until the player finishes or skips it. */
const TRANSFER_PENDING_STATES = ["dr_choice_open", "dr_not_copied_yet"];
export function transferPending(drState: string | null | undefined): boolean {
  return typeof drState === "string" && TRANSFER_PENDING_STATES.includes(drState);
}

export interface ResetInput {
  /** false once the server said the route is not there (404): the card is hidden. */
  available: boolean;
  gameRunning: boolean;
  transferPending: boolean;
  typed: string;
  busy: boolean;
}
export interface ResetGate { visible: boolean; enabled: boolean; blocked: "game" | "transfer" | null }

/** What the card shows. The confirm button is on only with the game closed, no pending transfer, the exact word typed and nothing in flight. */
export function resetGate(i: ResetInput): ResetGate {
  if (!i.available) return { visible: false, enabled: false, blocked: null };
  const blocked = i.gameRunning ? "game" : i.transferPending ? "transfer" : null;
  return { visible: true, enabled: blocked === null && !i.busy && i.typed.trim() === RESET_WORD, blocked };
}
