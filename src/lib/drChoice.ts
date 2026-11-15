// The one-time choice for players who have a Dauntless Revived account: move the progress over now, or start fresh.
// Pure logic and every string, so the screen stays thin and the rules can be tested without a window.

export type DrChoiceState =
  | "dr_choice_open"
  | "dr_not_copied_yet"
  | "dr_transfers_ended"
  | "dr_already_declined"
  | "dr_already_transferred"
  | "dr_has_progress"
  | "dr_no_dr_account"
  | "dr_try_again_later";

export const DR_CHOICE_STATES: readonly DrChoiceState[] = [
  "dr_choice_open",
  "dr_not_copied_yet",
  "dr_transfers_ended",
  "dr_already_declined",
  "dr_already_transferred",
  "dr_has_progress",
  "dr_no_dr_account",
  "dr_try_again_later",
];

export type DrChoice = "transfer" | "decline";

/** What the server answers, for both the status check and a decision. `text` is optional plain text from the server. */
export interface DrChoiceAnswer {
  state: string;
  text?: string | null;
}

/** The decision answer: 200 { ok, state, text }, or 400 { ok: false, code: "dr_confirmation_required" | "dr_bad_choice", text }. */
export interface DrDecisionReply extends DrChoiceAnswer {
  ok?: boolean;
  code?: string;
}

/** The old POST /launcher/v1/dr-claim route answers these codes; each shows the same notice as the matching choice state. */
export const CLAIM_CODE_STATE: Readonly<Record<string, DrChoiceState>> = {
  not_copied_yet: "dr_not_copied_yet",
  transfers_ended: "dr_transfers_ended",
  try_later: "dr_try_again_later",
  declined: "dr_already_declined",
};

/** The old claim route answers not_copied_yet, transfers_ended, try_later and declined in the same words the choice notice already shows. Show them once: the claim notice only appears when the choice check has settled on something that is not a notice. */
export function showClaimNotice(choice: DrChoiceView | "loading"): boolean {
  return choice !== "loading" && choice.kind !== "notice";
}

export function viewForClaimCode(code: string): DrChoiceView | null {
  const state = CLAIM_CODE_STATE[code];
  return state ? viewFor({ state }) : null;
}

/** Same switch as the server's DR_PLAY_ENDS_OPTION (on by default): playing for real before the copy is ready ends the option. Used only for the launcher's own fallback text. */
export const DR_PLAY_ENDS_OPTION = true;

export const DR_TEXT = {
  choiceTitle: "Move your Dauntless Revived progress?",
  choiceIntro: "Your Dauntless Revived account is ready to move. You can bring your progress and items over now, or leave them behind.",
  choiceOnlyChance:
    "You only get to choose once. If you leave your progress behind, you can't move it later, and this can't be undone.",
  endsOption:
    "Moving is only possible until you start playing for real: finishing a hunt, earning XP, levels or currency, or getting items ends it.",
  moveListHeading: "What moves over",
  moveList: [
    "Your gear, cells and cosmetics",
    "Your loadouts",
    "Your weapon levels",
    "Your bounties and what you have discovered",
    "Your currencies and your look",
    "Your Escalation progress: level, XP, talents and collected rewards for each season",
  ],
  notMovedHeading: "What does not move",
  notMoved: "Store purchases and cooldowns.",
  moveButton: "Move my progress",
  freshButton: "Start fresh",

  confirmMoveTitle: "Move your progress to Ramsgate Reborn?",
  confirmMoveBody:
    "Your Dauntless Revived progress will be copied to this account the first time you play. Anything you do on Dauntless Revived after that is not included.",
  confirmMoveButton: "Yes, move my progress",
  confirmFreshTitle: "Start fresh without your progress?",
  confirmFreshBody:
    "Your Dauntless Revived progress will not be moved. You can't change this later, and it can't be undone.",
  confirmFreshButton: "Yes, start fresh for good",
  backButton: "Go back",
  sending: "Sending your choice…",
  sendFailed: "Your choice was not saved. Nothing has changed. You can try again.",
  sendAgainButton: "Try again",

  notCopiedYet:
    "Your Dauntless Revived account has not been copied over yet. You can wait and check back, or skip the move for good. You can look around in the meantime, but once you start playing for real (finishing a hunt, earning XP, levels or currency, or getting items) you lose the chance to move it.",
  notCopiedYetKeepPlaying:
    "Your Dauntless Revived account has not been copied over yet. You can check back later, or skip the move for good. You can keep playing while you wait, but if you have earned progress here by the time your copy is ready, it can't be moved. Moving is only possible until you start playing for real: finishing a hunt, earning XP, levels or currency, or getting items ends it.",
  transfersEnded: "Moving Dauntless Revived accounts has ended, and a copy of your account was not made in time, so it can't be moved.",
  alreadyDeclined: "You chose not to move your Dauntless Revived account. That can't be changed.",
  alreadyTransferred: "Your Dauntless Revived account has already been moved.",
  hasProgress:
    "You have already started playing for real on this account (finished a hunt, or earned XP, levels, currency or items), so your Dauntless Revived progress can no longer be moved. It only works until you start playing for real.",
  tryAgainLater: "We couldn't check your Dauntless Revived account just now. Nothing was changed. Try again in a little while.",
  tryAgainButton: "Check again",
} as const;

export type DrChoiceView =
  | { kind: "none"; state: DrChoiceState }
  /** The full screen. Play stays off until the player has chosen and confirmed. */
  | { kind: "screen"; state: "dr_choice_open"; blocksPlay: true }
  /** A plain notice. Play is allowed. `retry` shows a manual "Check again" button. */
  | { kind: "notice"; state: DrChoiceState; text: string; blocksPlay: false; retry: boolean };

function isKnown(state: string): state is DrChoiceState {
  return (DR_CHOICE_STATES as readonly string[]).includes(state);
}

function clean(text: string | null | undefined): string | null {
  const t = typeof text === "string" ? text.trim() : "";
  return t.length > 0 && t.length <= 600 ? t : null;
}

/** Maps a server answer to what the launcher shows. Unknown states are treated like "try again later" and never block Play. */
export function viewFor(answer: DrChoiceAnswer | null | undefined): DrChoiceView {
  const raw = answer?.state ?? "";
  const state: DrChoiceState = isKnown(raw) ? raw : "dr_try_again_later";
  const own = clean(answer?.text);
  switch (state) {
    case "dr_choice_open":
      return { kind: "screen", state, blocksPlay: true };
    case "dr_no_dr_account":
      return { kind: "none", state };
    case "dr_not_copied_yet": {
      // The server's own text already says what applies (it differs when playing does not end the option), so it is shown as sent.
      const text = own ?? (DR_PLAY_ENDS_OPTION ? DR_TEXT.notCopiedYet : DR_TEXT.notCopiedYetKeepPlaying);
      return { kind: "notice", state, text, blocksPlay: false, retry: true };
    }
    case "dr_transfers_ended":
      return { kind: "notice", state, text: own ?? DR_TEXT.transfersEnded, blocksPlay: false, retry: false };
    case "dr_already_declined":
      return { kind: "notice", state, text: own ?? DR_TEXT.alreadyDeclined, blocksPlay: false, retry: false };
    case "dr_already_transferred":
      return { kind: "notice", state, text: own ?? DR_TEXT.alreadyTransferred, blocksPlay: false, retry: false };
    case "dr_has_progress":
      return { kind: "notice", state, text: own ?? DR_TEXT.hasProgress, blocksPlay: false, retry: false };
    case "dr_try_again_later":
      return { kind: "notice", state, text: own ?? DR_TEXT.tryAgainLater, blocksPlay: false, retry: true };
  }
}

// The two-step flow. Nothing is chosen at the start and nothing is sent until the second, separate confirm.
export type DrFlow =
  | { step: "choose" }
  | { step: "confirm"; choice: DrChoice }
  | { step: "sending"; choice: DrChoice }
  | { step: "failed"; choice: DrChoice };

export type DrFlowAction =
  | { type: "pick"; choice: DrChoice }
  | { type: "back" }
  | { type: "confirm" }
  | { type: "dismiss" } // Esc or any attempt to close the screen
  | { type: "sent_failed" };

export interface DrDecisionBody {
  choice: DrChoice;
  confirmed: true;
}

export const DR_FLOW_START: DrFlow = { step: "choose" };

/** Returns the next flow and, only on the second confirm, the body to send. Every other action sends nothing. */
export function stepFlow(flow: DrFlow, action: DrFlowAction): { flow: DrFlow; send: DrDecisionBody | null } {
  switch (action.type) {
    case "pick":
      return flow.step === "choose" ? { flow: { step: "confirm", choice: action.choice }, send: null } : { flow, send: null };
    case "back":
      return flow.step === "confirm" || flow.step === "failed" ? { flow: { step: "choose" }, send: null } : { flow, send: null };
    case "confirm":
      if (flow.step === "confirm" || flow.step === "failed") {
        return { flow: { step: "sending", choice: flow.choice }, send: { choice: flow.choice, confirmed: true } };
      }
      return { flow, send: null };
    case "sent_failed":
      return flow.step === "sending" ? { flow: { step: "failed", choice: flow.choice }, send: null } : { flow, send: null };
    case "dismiss":
      return { flow, send: null };
  }
}
