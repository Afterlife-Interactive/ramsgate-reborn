import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homePrimary, isDrGateMessage, DR_GATE_TEXT, DR_GATE_TEXT_START, START_FRESH_CONFIRM, type GameState } from "./drHomeState.ts";
import { viewFor, exhaustedView, type DrChoiceView } from "./drChoice.ts";
import { reclaimMessage, RECLAIM_TEXT } from "./drReclaim.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

const GAMES: GameState[] = ["missing", "wrong_folder", "downloading", "needs_repair", "ready"];
const CHOICES: Array<[string, DrChoiceView | "loading"]> = [
  ["loading", "loading"],
  ["no_dr_account", viewFor({ state: "dr_no_dr_account" })],
  ["choice_open", viewFor({ state: "dr_choice_open" })],
  ["not_copied_yet", viewFor({ state: "dr_not_copied_yet" })],
  ["transfers_ended", viewFor({ state: "dr_transfers_ended" })],
  ["already_declined", viewFor({ state: "dr_already_declined" })],
  ["already_transferred", viewFor({ state: "dr_already_transferred" })],
  ["has_progress", viewFor({ state: "dr_has_progress" })],
  ["try_again_later", viewFor({ state: "dr_try_again_later" })],
  ["exhausted", exhaustedView()],
];
const CLAIMS = [null, "none", "checking", "ported", "fetching", "wait", "not_found", "no_match", "has_progress", "in_game", "not_ready", "error"];

test("game problems always win: no DR message with a missing, wrong, downloading or broken game", () => {
  const want: Record<string, string> = { missing: "locate", wrong_folder: "wrong_folder", downloading: "download", needs_repair: "repair" };
  for (const game of GAMES.filter((g) => g !== "ready")) {
    for (const [, choice] of CHOICES) for (const claim of CLAIMS) for (const gate of [false, true]) {
      assert.equal(homePrimary({ game, choice, claimState: claim, gate }), want[game]);
    }
  }
});

test("with the game ready, every DR state gives exactly one primary", () => {
  const seen = new Set<string>();
  for (const [name, choice] of CHOICES) for (const claim of CLAIMS) {
    const p = homePrimary({ game: "ready", choice, claimState: claim, gate: false });
    seen.add(p);
    if (name === "choice_open") assert.equal(p, "dr_screen");
    if (name === "not_copied_yet") assert.equal(p, "dr_queue");
    // a choice-check notice is never shown together with a claim message (except after a finished transfer)
    if (["has_progress", "exhausted", "try_again_later", "transfers_ended", "already_declined"].includes(name)) assert.equal(p, "dr_notice");
  }
  assert.ok(seen.has("play") && seen.has("dr_claim") && seen.has("dr_claim_fetching") && seen.has("dr_notice"));
});

test("no DR link and nothing pending is Play", () => {
  assert.equal(homePrimary({ game: "ready", choice: viewFor({ state: "dr_no_dr_account" }), claimState: null, gate: false }), "play");
  assert.equal(homePrimary({ game: "ready", choice: viewFor({ state: "dr_no_dr_account" }), claimState: "none", gate: false }), "play");
  assert.equal(homePrimary({ game: "ready", choice: viewFor({ state: "dr_already_declined" }), claimState: "none", gate: false }), "dr_notice");
});

test("the server's 409 gate shows one message with Start fresh and holds the screen", () => {
  const p = homePrimary({ game: "ready", choice: viewFor({ state: "dr_no_dr_account" }), claimState: null, gate: true });
  assert.equal(p, "dr_gate");
  assert.equal(DR_GATE_TEXT, "Your Dauntless Revived transfer is still being prepared. Please wait until the launcher says it is ready; playing now can cancel it.");
  assert.equal(isDrGateMessage(DR_GATE_TEXT), true);
  assert.equal(isDrGateMessage("Please update the launcher."), false);
  assert.equal(START_FRESH_CONFIRM, "This skips your transfer for good. Start fresh?");
  assert.ok(read("../../src-tauri/src/commands/auth.rs").includes(`"${DR_GATE_TEXT_START}"`));
  assert.ok(read("../../src-tauri/src/commands/auth.rs").includes(`"${DR_GATE_TEXT}"`));
  assert.ok(read("../../src-tauri/src/commands/auth.rs").includes('"DR_TRANSFER_IN_PROGRESS"'));
});

test("a 404 on the re-pull route is 'not available', never 'could not reach the server'", () => {
  assert.equal(reclaimMessage("unavailable"), RECLAIM_TEXT.unavailable);
  assert.notEqual(RECLAIM_TEXT.unavailable, RECLAIM_TEXT.failed);
  const b = read("../screens/dashboard/DrReclaimButton.tsx");
  assert.match(b, /setGone\(true\)/);
});

test("Home wiring: one primary, Start fresh asks first, hold label instead of a spinner", () => {
  const home = read("../screens/dashboard/HomeTab.tsx");
  assert.match(home, /homePrimary\(/);
  assert.match(home, /primary === "dr_claim"/);
  assert.match(home, /StartFreshButton/);
  assert.match(read("../screens/dashboard/StartFreshButton.tsx"), /START_FRESH_CONFIRM/);
});

test("the game download button is the only action for a wrong exe (no verify or repair wording)", () => {
  assert.doesNotMatch(read("../../src-tauri/src/commands/auth.rs").split("#[cfg(test)]")[0], /verify or repair/i);
});
