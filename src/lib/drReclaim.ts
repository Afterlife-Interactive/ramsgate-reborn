// The "Retry my Dauntless Revived transfer" button: a player-initiated re-pull of the Dauntless Revived save.
// Pure text and rules, so the button stays thin and can be tested without a window.
export const RECLAIM_TEXT = {
  button: "Retry my Dauntless Revived transfer",
  working: "Asking the server…",
  fetching: "Fetching your Dauntless Revived save now…",
  started: "Your transfer was started again. Wait for \"Your progress is ready\" before pressing Play.",
  reclaimed: "Your Dauntless Revived progress has been moved into your account again. You can start the game now.",
  will_apply: "Your Dauntless Revived progress is ready. It will be in your account the next time you start the game.",
  already_done: "Your Dauntless Revived progress is already in your account.",
  nothing: "Your Dauntless Revived account has no progress to move.",
  has_progress: "You already have progress in Ramsgate Reborn, so your transfer can't be re-pulled automatically. Make a ticket and staff will look at it.",
  not_eligible: "You already have progress in Ramsgate Reborn, so your transfer can't be re-pulled automatically. Make a ticket and staff will look at it.",
  in_game: "Close the game first, then try again. Your progress can only be moved while the game is closed.",
  wait: "You can only re-pull once an hour. Please try again later.",
  not_ready: "Your Dauntless Revived save isn't ready to move yet. Staff have been told. Please try again later.",
  no_match: "We couldn't find a Dauntless Revived account for the keys on this PC. Check your key file in Documents\\Dauntless Revived\\Account Keys.",
  no_key: "We could not find your Dauntless Revived account key on this PC. Check your key file, then try again.",
  transfers_ended: "Moving Dauntless Revived accounts has ended, so this can't be moved.",
  declined: "You chose not to move your Dauntless Revived account. That can't be changed.",
  unavailable: "This is not available right now.",
  try_later: "The server could not do this just now. Nothing was changed. Please try again in a little while.",
  failed: "We could not reach the server just now. Nothing was changed. You can try again.",
} as const;

const NOT_OUTCOMES = new Set(["button", "working", "failed"]);

export type ReclaimOutcome = Exclude<keyof typeof RECLAIM_TEXT, "button" | "working" | "failed">;

/** Answers that mean the progress is in (or on its way in): Play may follow the normal gate again. */
export const RECLAIM_SUCCESS: readonly string[] = ["started", "reclaimed", "will_apply", "already_done", "nothing"];

/** The line for an answer; a thrown error (network, unreadable answer) gives the retry line. */
export function reclaimMessage(outcome: string | null | undefined): string {
  if (outcome && outcome in RECLAIM_TEXT && !NOT_OUTCOMES.has(outcome) && outcome !== "button") {
    return RECLAIM_TEXT[outcome as keyof typeof RECLAIM_TEXT];
  }
  return RECLAIM_TEXT.failed;
}
