import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RECLAIM_TEXT, RECLAIM_SUCCESS, reclaimMessage } from "./drReclaim.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

test("every answer has a plain line and unknown ones give the retry line", () => {
  for (const o of ["started", "reclaimed", "will_apply", "already_done", "nothing", "not_eligible", "has_progress", "in_game", "wait", "fetching", "not_ready", "no_match", "transfers_ended", "declined", "try_later", "no_key"]) {
    assert.notEqual(reclaimMessage(o), RECLAIM_TEXT.failed, o);
  }
  assert.equal(reclaimMessage(null), RECLAIM_TEXT.failed);
  assert.equal(reclaimMessage("button"), RECLAIM_TEXT.failed);
  assert.match(RECLAIM_TEXT.in_game, /Close the game first/);
  assert.match(RECLAIM_TEXT.has_progress, /ticket/);
});

test("no dashes in the player text", () => {
  for (const t of Object.values(RECLAIM_TEXT)) assert.doesNotMatch(t, /[\u2013\u2014]/);
});

test("the button is in flight only once, and sits on Home and Library", () => {
  const b = read("../screens/dashboard/DrReclaimButton.tsx");
  assert.match(b, /disabled=\{busy\}/);
  assert.match(b, /flight\.current/);
  assert.match(read("../screens/dashboard/HomeTab.tsx"), /DrReclaimButton/);
  assert.match(read("../screens/dashboard/LibraryTab.tsx"), /DrReclaimButton/);
});

test("success answers are exactly the ones that mean the progress is in", () => {
  assert.deepEqual([...RECLAIM_SUCCESS].sort(), ["already_done", "nothing", "reclaimed", "started", "will_apply"]);
  assert.match(RECLAIM_TEXT.reclaimed, /start the game now/);
  assert.match(RECLAIM_TEXT.not_eligible, /Make a ticket/);
  assert.match(RECLAIM_TEXT.no_match, /Documents\\Dauntless Revived\\Account Keys/);
});
