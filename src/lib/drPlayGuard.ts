// Entering the game while a Dauntless Revived transfer is still on its way can lock that transfer out. This decides
// when Play stays off, and holds the words shown instead.
// The states are the ones the server really reports: the choice check answers dr_not_copied_yet while the copy is
// queued, being fetched or not ready (the line itself answers queue_waiting / queue_pulling), the old claim route
// answers "fetching" / "wait" while the save is being pulled, and dr_try_again_later means the check did not succeed.
// Ready (the choice screen opens, or the claim is "ported"), Start fresh (dr_already_declined) and accounts with no
// Dauntless Revived link (dr_no_dr_account, no claim) are never held.
import type { DrChoiceView } from "./drChoice.ts";

export const DR_PLAY_HOLD_TEXT = {
  pending: 'Wait for "Your progress is ready" before pressing Play. Entering the game early can lock out your transfer.',
  unreadable: "Checking your Dauntless Revived account. Play is on hold for a moment.",
} as const;

export type DrPlayHold = "pending" | "unreadable";

/** What the held Play button shows instead of a spinner and "Starting...". */
export const DR_PLAY_HOLD_LABEL: Record<DrPlayHold, string> = { pending: "Waiting for your transfer", unreadable: "Checking your account" };

/** Why Play must stay off, or null when it may be used. */
export function playHoldFor(choice: DrChoiceView | "loading", claimState: string | null | undefined, gate = false): DrPlayHold | null {
  if (gate) return "pending";
  if (claimState === "fetching" || claimState === "wait") return "pending";
  if (choice === "loading") return null;
  if (choice.kind === "notice" && choice.state === "dr_not_copied_yet") return "pending";
  // Only while the automatic re-checks run. Once they gave up the player gets Retry / Start fresh and Play is released,
  // so a backend hiccup never traps anyone (an RR-only player included).
  if (choice.kind === "notice" && choice.state === "dr_try_again_later" && !choice.exhausted) return "unreadable";
  return null;
}
