// The line for players whose Dauntless Revived copy is not here yet.
// Pure logic and every string, so the panel stays thin and the rules can be tested without a window.
import { DR_TEXT, viewFor, type DrChoiceView } from "./drChoice.ts";

/** What the three queue calls answer. Every field but `state` is optional. */
export interface DrQueueAnswer {
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

/** Fallbacks for when the server sends no text. Same meaning as the server's own wording. */
export const QUEUE_TEXT = {
  heading: "Your Dauntless Revived account is in line",
  pullingHeading: "Your account is being copied",
  waiting: "Your place is kept while you are away, so you can close the launcher and check back later.",
  pulling: "Your Dauntless Revived account is being copied right now. This should only take a few minutes.",
  startFresh:
    "This is a long wait. You can start fresh on Ramsgate Reborn right now and leave your Dauntless Revived progress behind for good, or stay in line.",
  full: "The line is full right now. Please try again a little later.",
  expired:
    "We haven't heard from your launcher for a long while, so you were taken out of the line. You can join again, but you will start at the back.",
  left: "You left the line. You can join again later.",
  notFound: "We couldn't find a Dauntless Revived character to copy on this account, so there is nothing to move.",
  playLine:
    "Do not play until your transfer is done. Waiting is safe, playing first can cancel your transfer.",
  etaLead: "Estimated wait",
  etaNote: "This is a guess based on how fast copies are finishing, not a promise.",
  noUpdate: "We couldn't update your place just now. Your place is kept, and we'll try again shortly.",
  joinButton: "Join the line",
  joinAgainButton: "Join again",
  leaveButton: "Leave the line",
  startFreshButton: "Start fresh",
  tryAgainButton: DR_TEXT.tryAgainButton,
  working: "One moment…",
} as const;

// ---------- waiting time, in words ----------

function unitOf(minutes: number): { n: number; unit: "minute" | "hour" | "day" } {
  if (minutes < 60) return { n: Math.max(1, Math.round(minutes)), unit: "minute" };
  if (minutes < 48 * 60) return { n: Math.max(1, Math.round(minutes / 60)), unit: "hour" };
  return { n: Math.max(1, Math.round(minutes / 1440)), unit: "day" };
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** The wait as a range in plain words, e.g. "about 4 to 6 hours". Never a single promised time. */
export function formatEtaRange(lowMinutes: number, highMinutes: number): string {
  const lo = Math.max(0, Number.isFinite(lowMinutes) ? lowMinutes : 0);
  const hi = Math.max(lo, Number.isFinite(highMinutes) ? highMinutes : lo);
  if (hi < 1) return "less than a minute";
  if (lo < 1) {
    const b = unitOf(hi);
    return `up to ${plural(b.n, b.unit)}`;
  }
  const a = unitOf(lo);
  const b = unitOf(hi);
  if (a.unit === b.unit) {
    if (a.n === b.n) return `about ${plural(b.n, b.unit)}`;
    return `about ${a.n} to ${plural(b.n, b.unit)}`;
  }
  return `about ${plural(a.n, a.unit)} to ${plural(b.n, b.unit)}`;
}

const count = (n: number) => n.toLocaleString("en-US");

// ---------- state mapping ----------

export type DrQueueView =
  | {
      kind: "waiting" | "pulling";
      positionLine: string | null;
      etaLine: string | null;
      text: string;
      /** The one plain line about playing while waiting. Left out when the text already says it. */
      playLine: string | null;
      longWait: boolean;
      startFreshText: string | null;
      retryAfterSeconds: number | null;
    }
  /** The copy is here: the existing choice screen opens. */
  | { kind: "ready" }
  | { kind: "not_in_line"; text: string }
  | { kind: "expired"; text: string }
  | { kind: "left"; text: string }
  | { kind: "full"; text: string }
  | { kind: "not_found"; text: string }
  | { kind: "ended"; text: string }
  | { kind: "decided"; state: string; text: string }
  | { kind: "try_later"; text: string }
  | { kind: "none" };

function clean(text: string | null | undefined): string | null {
  const t = typeof text === "string" ? text.trim() : "";
  return t.length > 0 && t.length <= 600 ? t : null;
}

/** True for the server's waiting text that starts by repeating the place in line. */
export const repeatsPlace = (text: string): boolean => /^You['’]re number [\d,]+ of [\d,]+ in line/i.test(text);

function whole(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/** Maps a server answer to what the launcher shows. Shown by `state`, never by the text. Unknown states count as "try again later". */
export function queueViewFor(answer: DrQueueAnswer | null | undefined): DrQueueView {
  const state = answer?.state ?? "";
  const own = clean(answer?.text);
  switch (state) {
    case "queue_waiting":
    case "queue_pulling": {
      const pulling = state === "queue_pulling";
      const position = whole(answer?.position);
      const total = whole(answer?.waitingTotal);
      const low = whole(answer?.etaLowMinutes);
      const high = whole(answer?.etaHighMinutes);
      const positionLine =
        position !== null && total !== null
          ? `You're number ${count(position)} of ${count(Math.max(total, position))} in line.`
          : position !== null
          ? `You're number ${count(position)} in line.`
          : null;
      let range: string | null = null;
      if (!pulling) {
        if (low !== null && high !== null) range = formatEtaRange(low, high);
        else range = clean(answer?.etaText);
      }
      // The server's waiting text repeats the place, the wait and the play rule that the panel already shows as lines of their own
      // (and its wait wording can read "about about"). When it does, the plain body is shown instead.
      const own2 = own !== null && !/play(ing)? while|keep playing|can play/i.test(own) ? own : null;
      const text = pulling ? own2 ?? QUEUE_TEXT.pulling : own2 !== null && !repeatsPlace(own2) ? own2 : QUEUE_TEXT.waiting;
      const longWait = !pulling && answer?.longWait === true;
      return {
        kind: pulling ? "pulling" : "waiting",
        positionLine: pulling ? null : positionLine,
        etaLine: range ? `${QUEUE_TEXT.etaLead}: ${range}. ${QUEUE_TEXT.etaNote}` : null,
        text,
        playLine: QUEUE_TEXT.playLine,
        longWait,
        startFreshText: longWait ? clean(answer?.startFreshText) ?? QUEUE_TEXT.startFresh : null,
        retryAfterSeconds: whole(answer?.retryAfterSeconds),
      };
    }
    case "dr_choice_open":
      return { kind: "ready" };
    case "dr_not_copied_yet": {
      const v = viewFor({ state, text: answer?.text });
      return { kind: "not_in_line", text: v.kind === "notice" ? v.text : DR_TEXT.notCopiedYet };
    }
    case "queue_expired":
      return { kind: "expired", text: own ?? QUEUE_TEXT.expired };
    case "queue_left":
      return { kind: "left", text: own ?? QUEUE_TEXT.left };
    case "queue_full":
      return { kind: "full", text: own ?? QUEUE_TEXT.full };
    case "queue_not_found":
      return { kind: "not_found", text: own ?? QUEUE_TEXT.notFound };
    case "dr_transfers_ended":
      return { kind: "ended", text: own ?? DR_TEXT.transfersEnded };
    case "dr_already_declined":
    case "dr_already_transferred":
    case "dr_has_progress": {
      const v: DrChoiceView = viewFor({ state, text: answer?.text });
      return { kind: "decided", state, text: v.kind === "notice" ? v.text : DR_TEXT.alreadyDeclined };
    }
    case "dr_no_dr_account":
      return { kind: "none" };
    default:
      return { kind: "try_later", text: state === "dr_try_again_later" && own ? own : DR_TEXT.tryAgainLater };
  }
}

export const isInLine = (v: DrQueueView): v is Extract<DrQueueView, { kind: "waiting" | "pulling" }> =>
  v.kind === "waiting" || v.kind === "pulling";

/** Which buttons a view offers. Nothing is ever sent without the player pressing one of these. */
export function buttonsFor(v: DrQueueView): { join: string | null; leave: boolean; startFresh: boolean; retry: boolean } {
  switch (v.kind) {
    case "waiting":
      return { join: null, leave: true, startFresh: v.longWait, retry: false };
    case "pulling":
      return { join: null, leave: true, startFresh: false, retry: false };
    case "not_in_line":
    case "left":
      return { join: QUEUE_TEXT.joinButton, leave: false, startFresh: false, retry: false };
    case "expired":
      return { join: QUEUE_TEXT.joinAgainButton, leave: false, startFresh: false, retry: false };
    case "full":
      return { join: QUEUE_TEXT.tryAgainButton, leave: false, startFresh: false, retry: false };
    case "try_later":
      return { join: null, leave: false, startFresh: false, retry: true };
    default:
      return { join: null, leave: false, startFresh: false, retry: false };
  }
}

// ---------- heartbeat ----------

export const HEARTBEAT_MIN_SECONDS = 60;
export const HEARTBEAT_DEFAULT_SECONDS = 120;
export const HEARTBEAT_MAX_SECONDS = 600;
/** After the window has been hidden this long the heartbeat stops. The place is kept for hours; it asks again when the window comes back. */
export const HIDDEN_STOP_MS = 30 * 60 * 1000;

export interface HeartbeatInput {
  /** True while the player is in line (waiting or being copied). */
  inLine: boolean;
  retryAfterSeconds: number | null;
  /** Failed checks in a row; each one doubles the wait (up to 8 times the base). */
  failures: number;
  /** How long the window has been hidden, or null while it is visible. */
  hiddenForMs: number | null;
  /** The player pressed Leave, or the screen is gone. */
  left: boolean;
}

/** When to ask the server for the place next. Never faster than every 60 seconds, never faster than the server asks, no tight loop. */
export function heartbeatPlan(input: HeartbeatInput): { run: boolean; delayMs: number } {
  if (input.left || !input.inLine) return { run: false, delayMs: 0 };
  if (input.hiddenForMs !== null && input.hiddenForMs >= HIDDEN_STOP_MS) return { run: false, delayMs: 0 };
  const server = input.retryAfterSeconds && input.retryAfterSeconds > 0 ? input.retryAfterSeconds : HEARTBEAT_DEFAULT_SECONDS;
  const base = Math.min(HEARTBEAT_MAX_SECONDS, Math.max(HEARTBEAT_MIN_SECONDS, server));
  const backoff = 2 ** Math.min(3, Math.max(0, Math.floor(input.failures)));
  return { run: true, delayMs: Math.min(HEARTBEAT_MAX_SECONDS, base * backoff) * 1000 };
}
