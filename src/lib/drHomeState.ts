// What the Home screen shows, as ONE primary state with ONE action, in strict priority:
//   1 game missing or wrong folder, 2 downloading, 3 game needs repair, 4 one Dauntless Revived (DR) state, 5 ready to play.
// DR messages are never shown while the game is not installed or is downloading, and two DR messages never stack.
import type { DrChoiceView } from "./drChoice.ts";

export type GameState = "missing" | "wrong_folder" | "downloading" | "needs_repair" | "ready";

export type HomePrimary =
  | "locate"
  | "wrong_folder"
  | "download"
  | "repair"
  | "dr_gate" // the server refused Play because the transfer is still being prepared
  | "dr_screen" // the one-time choice screen
  | "dr_queue" // waiting / pulling / not ready
  | "dr_notice" // answer of the choice check (retry, Start fresh, locked out, ended, declined ...)
  | "dr_claim_fetching"
  | "dr_claim" // another claim answer (ported, not found, in game, error ...)
  | "play";

const CLAIM_SHOWN_WITH_NOTICE = new Set(["dr_already_transferred"]);

export function homePrimary(input: {
  game: GameState;
  choice: DrChoiceView | "loading";
  claimState: string | null | undefined;
  gate: boolean;
}): HomePrimary {
  const { game, choice, claimState, gate } = input;
  if (game === "missing") return "locate";
  if (game === "wrong_folder") return "wrong_folder";
  if (game === "downloading") return "download";
  if (game === "needs_repair") return "repair";
  if (gate) return "dr_gate";
  const claim = claimState != null && claimState !== "none" && claimState !== "checking" ? claimState : null;
  if (choice !== "loading") {
    if (choice.kind === "screen") return "dr_screen";
    if (choice.kind === "notice") {
      if (choice.state === "dr_not_copied_yet") return "dr_queue";
      if (claim && CLAIM_SHOWN_WITH_NOTICE.has(choice.state)) return claim === "fetching" || claim === "wait" ? "dr_claim_fetching" : "dr_claim";
      return "dr_notice";
    }
  }
  if (claim === "fetching" || claim === "wait") return "dr_claim_fetching";
  if (claim) return "dr_claim";
  return "play";
}

/** The Play button is the action only for these. */
export function playIsAction(p: HomePrimary): boolean {
  return p === "play";
}

/** Kept in step with DR_GATE_TEXT_START in auth.rs by a test. */
export const DR_GATE_TEXT_START = "Your Dauntless Revived transfer is still being prepared";
export const START_FRESH_CONFIRM = "This skips your transfer for good. Start fresh?";

export function isDrGateMessage(message: string | null | undefined): boolean {
  return typeof message === "string" && message.trim().startsWith(DR_GATE_TEXT_START);
}
export const DR_GATE_TEXT = "Your Dauntless Revived transfer is still being prepared. Please wait until the launcher says it is ready; playing now can cancel it.";
