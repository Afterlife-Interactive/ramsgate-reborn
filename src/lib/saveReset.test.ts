import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RESET_TEXT, RESET_WORD, RESET_DONE, resetGate, resetMessage, transferPending } from "./saveReset.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const base = { available: true, gameRunning: false, transferPending: false, typed: "RESET", busy: false };

test("the confirm button matrix: only the exact word, game closed, no pending transfer, nothing in flight", () => {
  assert.equal(resetGate(base).enabled, true);
  for (const typed of ["", "reset", "Reset", "RESE", "RESET NOW", "YES"]) assert.equal(resetGate({ ...base, typed }).enabled, false, typed);
  assert.equal(resetGate({ ...base, typed: " RESET " }).enabled, true);
  assert.deepEqual(resetGate({ ...base, gameRunning: true }), { visible: true, enabled: false, blocked: "game" });
  assert.deepEqual(resetGate({ ...base, transferPending: true }), { visible: true, enabled: false, blocked: "transfer" });
  assert.deepEqual(resetGate({ ...base, gameRunning: true, transferPending: true }), { visible: true, enabled: false, blocked: "game" });
  assert.equal(resetGate({ ...base, busy: true }).enabled, false);
  assert.deepEqual(resetGate({ ...base, available: false }), { visible: false, enabled: false, blocked: null });
});

test("a pending Dauntless Revived transfer is the open choice or a copy still waiting; nothing else holds the reset", () => {
  assert.equal(transferPending("dr_choice_open"), true);
  assert.equal(transferPending("dr_not_copied_yet"), true);
  for (const s of ["dr_no_dr_account", "dr_already_declined", "dr_already_transferred", "dr_has_progress", "dr_transfers_ended", "dr_try_again_later", "", null, undefined]) assert.equal(transferPending(s as string), false, String(s));
});

test("every answer has a plain line; unknown ones say nothing was changed", () => {
  for (const o of ["reset", "already_fresh", "confirm_required", "not_allowed", "in_game", "cooldown", "wait", "unavailable", "error", "unknown"]) {
    assert.notEqual(resetMessage(o), RESET_TEXT.failed, o);
  }
  assert.equal(resetMessage(null), RESET_TEXT.failed);
  assert.equal(resetMessage("weird"), RESET_TEXT.failed);
  assert.equal(resetMessage("unknown"), RESET_TEXT.error);
  assert.match(RESET_TEXT.error, /Nothing was changed/);
  assert.match(RESET_TEXT.in_game, /Close the game first/);
});

test("cooldown shows the wait in hours; not_allowed shows the server sentence when it is plain", () => {
  assert.match(resetMessage("cooldown", null, 86000), /About 24 hours left/);
  assert.match(resetMessage("cooldown", null, 3000), /About 1 hour left/);
  assert.equal(resetMessage("cooldown"), RESET_TEXT.cooldown);
  assert.equal(resetMessage("not_allowed", "Finish or skip your Dauntless Revived transfer first, then you can reset your save."), "Finish or skip your Dauntless Revived transfer first, then you can reset your save.");
  assert.equal(resetMessage("not_allowed", "x".repeat(301)), RESET_TEXT.not_allowed);
  assert.equal(resetMessage("not_allowed", "bad — text"), RESET_TEXT.not_allowed);
  assert.equal(resetMessage("not_allowed"), RESET_TEXT.not_allowed);
});

test("success answers are exactly reset and already_fresh", () => {
  assert.deepEqual([...RESET_DONE].sort(), ["already_fresh", "reset"]);
  assert.equal(RESET_WORD, "RESET");
});

test("no dashes in the player text, and the warning says what goes and what stays", () => {
  for (const t of Object.values(RESET_TEXT)) assert.doesNotMatch(t, /[–—]/);
  assert.match(RESET_TEXT.deleted, /progress/); assert.match(RESET_TEXT.backup, /30 days/);
  assert.match(RESET_TEXT.kept, /friends/); assert.match(RESET_TEXT.closeGame, /game/);
});

test("the card is on the Account tab only, not Home or near Play; one request at a time; it polls and stops", () => {
  assert.match(read("../screens/dashboard/AccountTab.tsx"), /ResetSaveCard/);
  assert.doesNotMatch(read("../screens/dashboard/HomeTab.tsx"), /ResetSaveCard|resetSave/);
  assert.doesNotMatch(read("../screens/dashboard/LibraryTab.tsx"), /ResetSaveCard|resetSave/);
  const c = read("../screens/dashboard/ResetSaveCard.tsx");
  assert.match(c, /flight\.current/);
  assert.match(c, /clearInterval\(timer\)/);
  assert.match(c, /resetSave\(""\)/); // the probe sends no word
  assert.match(c, /resetSave\(RESET_WORD\)/);
  assert.match(c, /if \(!gate\.visible\) return null/); // a 404 hides the card
});

test("the api call sends the confirm word and nothing else", () => {
  const api = read("../api/tauri.ts");
  assert.match(api, /invoke<ResetSaveResult>\("native_reset_save", \{ confirm \}\)/);
});

test("the warning is the exact first line of the open card, above the delete and keep lists", () => {
  assert.equal(RESET_TEXT.warning, "This deletes ALL your Ramsgate Reborn progress, gear and currency. It cannot be undone from the launcher.");
  const c = read("../screens/dashboard/ResetSaveCard.tsx");
  const at = (t: string) => c.indexOf(t);
  assert.ok(at("RESET_TEXT.warning") > 0);
  assert.ok(at("RESET_TEXT.warning") < at("RESET_TEXT.intro"));
  assert.ok(at("RESET_TEXT.warning") < at("RESET_TEXT.deletedTitle"));
  assert.ok(at("RESET_TEXT.backup") > at("RESET_TEXT.warning") && at("RESET_TEXT.kept}") > at("RESET_TEXT.warning"));
});
