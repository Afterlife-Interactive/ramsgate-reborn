import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { viewFor, exhaustedView, DR_TEXT } from "./drChoice.ts";
import { DR_PLAY_HOLD_TEXT, DR_PLAY_HOLD_LABEL, playHoldFor } from "./drPlayGuard.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

test("Play is held while the transfer is queued, being fetched or not ready", () => {
  assert.equal(playHoldFor(viewFor({ state: "dr_not_copied_yet" }), null), "pending");
  assert.equal(playHoldFor("loading", "fetching"), "pending");
  assert.equal(playHoldFor("loading", "wait"), "pending");
});

test("Play is held when the check did not succeed", () => {
  assert.equal(playHoldFor(viewFor({ state: "dr_try_again_later" }), null), "unreadable");
  assert.equal(playHoldFor(viewFor(null), null), "unreadable");
});

test("ready, start fresh, moved, ended and no Dauntless Revived link are never held", () => {
  for (const state of ["dr_no_dr_account", "dr_already_declined", "dr_already_transferred", "dr_has_progress", "dr_transfers_ended", "dr_choice_open"]) {
    assert.equal(playHoldFor(viewFor({ state }), "none"), null, state);
  }
  assert.equal(playHoldFor("loading", null), null);
  assert.equal(playHoldFor("loading", "ported"), null);
  assert.equal(playHoldFor("loading", "none"), null);
});

test("the hold text says to wait for the ready message", () => {
  assert.match(DR_PLAY_HOLD_TEXT.pending, /Wait for "Your progress is ready" before pressing Play/);
});

test("no text in the launcher tells a waiting player they can play", () => {
  const files = ["../lib/drChoice.ts", "../lib/drQueue.ts", "../screens/dashboard/DrQueuePanel.tsx", "../screens/dashboard/HomeTab.tsx", "../screens/dashboard/DrChoiceScreen.tsx"];
  for (const f of files) {
    const t = read(f);
    assert.doesNotMatch(t, /play while (you|it)/i, f);
    assert.doesNotMatch(t, /keep playing while/i, f);
    assert.doesNotMatch(t, /play while waiting/i, f);
  }
});

test("Home turns Play off by the hold and shows why", () => {
  const home = read("../screens/dashboard/HomeTab.tsx");
  assert.match(home, /playHold === null/);
  assert.match(home, /DR_PLAY_HOLD_LABEL/);
});

test("a failed check holds Play only while the re-checks run, then releases it with Retry and Start fresh", () => {
  const v = exhaustedView();
  assert.equal(playHoldFor(v, null), null);
  assert.ok(v.kind === "notice" && v.retry && v.exhausted);
  assert.match(DR_TEXT.tryAgainExhausted, /Start fresh/);
  assert.equal(DR_TEXT.tryAgainButton, "Retry");
  assert.match(DR_PLAY_HOLD_TEXT.unreadable, /Checking/);
});

test("a held Play button shows the hold label, not a spinner with Starting", () => {
  assert.equal(DR_PLAY_HOLD_LABEL.pending, "Waiting for your transfer");
  const home = read("../screens/dashboard/HomeTab.tsx");
  assert.match(home, /DR_PLAY_HOLD_LABEL\[playHold\]/);
  assert.match(home, /!canPlay && playHold === null/);
  assert.match(home, /drSkip\(\)/);
});
