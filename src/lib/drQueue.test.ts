// Run with: node --test src/lib/  (Node 22.6+ strips the types; no packages needed)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  HEARTBEAT_MAX_SECONDS,
  HIDDEN_STOP_MS,
  QUEUE_TEXT,
  buttonsFor,
  formatEtaRange,
  heartbeatPlan,
  isInLine,
  queueViewFor,
  repeatsPlace,
} from "./drQueue.ts";
import { DR_FLOW_START, DR_TEXT, stepFlow } from "./drChoice.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

const waiting = {
  state: "queue_waiting",
  queueState: "waiting",
  position: 300,
  waitingTotal: 1200,
  etaLowMinutes: 240,
  etaHighMinutes: 480,
  etaText: "about 4 to 8 hours",
  longWait: false,
  retryAfterSeconds: 120,
  text: "You're number 300 of 1200 in line.",
};

test("every state maps to the right view", () => {
  const kinds: Array<[string, string]> = [
    ["queue_waiting", "waiting"],
    ["queue_pulling", "pulling"],
    ["dr_choice_open", "ready"],
    ["queue_expired", "expired"],
    ["queue_left", "left"],
    ["queue_full", "full"],
    ["queue_not_found", "not_found"],
    ["dr_transfers_ended", "ended"],
    ["dr_not_copied_yet", "not_in_line"],
    ["dr_already_declined", "decided"],
    ["dr_already_transferred", "decided"],
    ["dr_has_progress", "decided"],
    ["dr_no_dr_account", "none"],
    ["dr_try_again_later", "try_later"],
    ["something_new", "try_later"],
  ];
  for (const [state, kind] of kinds) assert.equal(queueViewFor({ state }).kind, kind, state);
  assert.equal(queueViewFor(null).kind, "try_later");
});

test("waiting shows position, how many wait and the wait as a range", () => {
  const v = queueViewFor(waiting);
  assert.ok(isInLine(v) && v.kind === "waiting");
  if (v.kind !== "waiting") return;
  assert.equal(v.positionLine, "You're number 300 of 1,200 in line.");
  assert.match(v.etaLine ?? "", /^Estimated wait: about 4 to 8 hours\./);
  assert.equal(v.retryAfterSeconds, 120);
  assert.equal(v.longWait, false);
  assert.equal(v.startFreshText, null);
});

test("pulling shows no position and no wait", () => {
  const v = queueViewFor({ state: "queue_pulling", position: 1, waitingTotal: 5, etaLowMinutes: 1, etaHighMinutes: 2 });
  assert.equal(v.kind, "pulling");
  if (v.kind !== "pulling") return;
  assert.equal(v.etaLine, null);
  assert.equal(v.text, QUEUE_TEXT.pulling);
});

test("the server's text is shown when sent, the fallback when not", () => {
  const sent = queueViewFor({ ...waiting, text: "Server words." });
  assert.ok(sent.kind === "waiting" && sent.text === "Server words.");
  const none = queueViewFor({ ...waiting, text: undefined });
  assert.ok(none.kind === "waiting" && none.text === QUEUE_TEXT.waiting);
  assert.equal(queueViewFor({ state: "queue_expired", text: "Mine." }).kind === "expired" && (queueViewFor({ state: "queue_expired", text: "Mine." }) as { text: string }).text, "Mine.");
  assert.equal((queueViewFor({ state: "queue_expired" }) as { text: string }).text, QUEUE_TEXT.expired);
  assert.equal((queueViewFor({ state: "queue_full" }) as { text: string }).text, QUEUE_TEXT.full);
  assert.equal((queueViewFor({ state: "queue_left" }) as { text: string }).text, QUEUE_TEXT.left);
  assert.equal((queueViewFor({ state: "queue_not_found" }) as { text: string }).text, QUEUE_TEXT.notFound);
  assert.equal((queueViewFor({ state: "dr_transfers_ended" }) as { text: string }).text, DR_TEXT.transfersEnded);
  assert.equal((queueViewFor({ state: "dr_has_progress" }) as { text: string }).text, DR_TEXT.hasProgress);
});

test("the play-while-waiting line is on screen unless the server text already says it", () => {
  const v = queueViewFor({ ...waiting, text: undefined });
  assert.ok(v.kind === "waiting" && v.playLine === QUEUE_TEXT.playLine);
  assert.equal(
    QUEUE_TEXT.playLine,
    "You can play while you wait. Moving your progress only works until you start playing for real: finishing a hunt, earning XP, levels or currency, or getting items.",
  );
  const withRule = queueViewFor({ ...waiting, text: "... once you start playing for real (finishing a hunt) you lose the chance." });
  assert.ok(withRule.kind === "waiting" && withRule.playLine === null);
});

test("the server's long waiting text that repeats the place is not shown on top of the place, wait and play lines", () => {
  const server =
    "You're number 7 of 41 in line to bring your Dauntless Revived account over, about about 5 to 10 minutes to go. Your place is kept while you are away, so you can close the launcher and check back later. You can look around Ramsgate Reborn meanwhile, but once you start playing for real (finishing a hunt, earning XP, levels or currency, or getting items) you lose the chance to move your account.";
  const v = queueViewFor({ ...waiting, position: 7, waitingTotal: 41, text: server });
  assert.ok(v.kind === "waiting");
  if (v.kind !== "waiting") return;
  assert.equal(v.text, QUEUE_TEXT.waiting);
  assert.equal(v.playLine, QUEUE_TEXT.playLine);
  assert.ok(!/about about/.test(`${v.positionLine} ${v.etaLine} ${v.text} ${v.playLine}`));
  // other server words still win, and the pulling text is always the server's when sent
  assert.equal((queueViewFor({ ...waiting, text: "Server words." }) as { text: string }).text, "Server words.");
  assert.equal((queueViewFor({ state: "queue_pulling", text: "Copying now." }) as { text: string }).text, "Copying now.");
  assert.equal(repeatsPlace("You’re number 3 of 9 in line to bring"), true);
  assert.equal(repeatsPlace("Your place is kept."), false);
});

test("wait ranges read in plain words", () => {
  assert.equal(formatEtaRange(0, 0), "less than a minute");
  assert.equal(formatEtaRange(0.2, 0.6), "less than a minute");
  assert.equal(formatEtaRange(0, 5), "up to 5 minutes");
  assert.equal(formatEtaRange(1, 1), "about 1 minute");
  assert.equal(formatEtaRange(5, 5), "about 5 minutes");
  assert.equal(formatEtaRange(5, 10), "about 5 to 10 minutes");
  assert.equal(formatEtaRange(1, 2), "about 1 to 2 minutes");
  assert.equal(formatEtaRange(60, 60), "about 1 hour");
  assert.equal(formatEtaRange(60, 120), "about 1 to 2 hours");
  assert.equal(formatEtaRange(240, 360), "about 4 to 6 hours");
  assert.equal(formatEtaRange(240, 480), "about 4 to 8 hours");
  assert.equal(formatEtaRange(240, 250), "about 4 hours");
  assert.equal(formatEtaRange(30, 120), "about 30 minutes to 2 hours");
  assert.equal(formatEtaRange(45, 60), "about 45 minutes to 1 hour");
  assert.equal(formatEtaRange(2000, 2800), "about 33 to 47 hours");
  assert.equal(formatEtaRange(2000, 5000), "about 33 hours to 3 days");
  assert.equal(formatEtaRange(4320, 5760), "about 3 to 4 days");
  assert.equal(formatEtaRange(10, 5), "about 10 minutes");
  assert.equal(formatEtaRange(NaN, NaN), "less than a minute");
});

test("a range from the server minutes is used, its etaText only when minutes are missing", () => {
  const v = queueViewFor({ state: "queue_waiting", position: 2, waitingTotal: 3, etaText: "about 9 to 10 hours" });
  assert.ok(v.kind === "waiting" && /about 9 to 10 hours/.test(v.etaLine ?? ""));
  const none = queueViewFor({ state: "queue_waiting", position: 2, waitingTotal: 3 });
  assert.ok(none.kind === "waiting" && none.etaLine === null);
});

test("the long wait line and the Start fresh option appear only when longWait is true", () => {
  const long = queueViewFor({ ...waiting, longWait: true, startFreshText: "Long wait, from the server." });
  assert.ok(long.kind === "waiting" && long.longWait && long.startFreshText === "Long wait, from the server.");
  assert.equal(buttonsFor(long).startFresh, true);
  const fallback = queueViewFor({ ...waiting, longWait: true });
  assert.ok(fallback.kind === "waiting" && fallback.startFreshText === QUEUE_TEXT.startFresh);
  const short = queueViewFor({ ...waiting, longWait: false, startFreshText: "should not show" });
  assert.ok(short.kind === "waiting" && short.startFreshText === null);
  assert.equal(buttonsFor(short).startFresh, false);
  assert.equal(buttonsFor(queueViewFor({ state: "queue_pulling", longWait: true })).startFresh, false);
});

test("Start fresh is the existing decline: nothing is sent until the second confirm", () => {
  let r = stepFlow(DR_FLOW_START, { type: "pick", choice: "decline" });
  assert.equal(r.send, null);
  assert.deepEqual(r.flow, { step: "confirm", choice: "decline" });
  r = stepFlow(r.flow, { type: "back" });
  assert.equal(r.send, null);
  r = stepFlow(stepFlow(DR_FLOW_START, { type: "pick", choice: "decline" }).flow, { type: "confirm" });
  assert.deepEqual(r.send, { choice: "decline", confirmed: true });
});

test("leave is one click and never needs a confirm", () => {
  const v = queueViewFor(waiting);
  assert.equal(buttonsFor(v).leave, true);
  assert.equal(buttonsFor(queueViewFor({ state: "queue_pulling" })).leave, true);
  const panel = read("../screens/dashboard/DrQueuePanel.tsx");
  assert.match(panel, /const onLeave = \(\) => \{[^}]*drQueueLeave\(\)/s);
  // The leave handler has no confirm step of its own.
  assert.doesNotMatch(panel.slice(panel.indexOf("const onLeave"), panel.indexOf("};", panel.indexOf("const onLeave"))), /confirm/i);
  assert.equal(buttonsFor(queueViewFor({ state: "queue_left" })).leave, false);
});

test("expired offers Join again, a left or empty line offers Join, full offers a manual retry", () => {
  assert.equal(buttonsFor(queueViewFor({ state: "queue_expired" })).join, "Join again");
  assert.equal(buttonsFor(queueViewFor({ state: "queue_left" })).join, "Join the line");
  assert.equal(buttonsFor(queueViewFor({ state: "dr_not_copied_yet" })).join, "Join the line");
  assert.equal(buttonsFor(queueViewFor({ state: "queue_full" })).join, "Check again");
  assert.equal(buttonsFor(queueViewFor({ state: "dr_try_again_later" })).retry, true);
  for (const state of ["queue_not_found", "dr_transfers_ended", "dr_already_declined", "dr_has_progress", "dr_choice_open"]) {
    const b = buttonsFor(queueViewFor({ state }));
    assert.deepEqual(b, { join: null, leave: false, startFresh: false, retry: false }, state);
  }
});

test("ready opens the existing choice screen and nothing is chosen for the player", () => {
  assert.deepEqual(queueViewFor({ state: "dr_choice_open", queueState: "ready" }), { kind: "ready" });
  const panel = read("../screens/dashboard/DrQueuePanel.tsx");
  // The choice call exists only behind the confirm step, and only for the decline path.
  assert.equal(panel.match(/drChoiceDecide\(/g)?.length, 1);
  assert.match(panel, /drChoiceDecide\(send\.choice\)/);
  assert.doesNotMatch(panel, /choice: "transfer"/);
  // Joining is only ever started by a button.
  assert.equal(panel.match(/drQueueJoin\(\)/g)?.length, 1);
  assert.match(panel, /const onJoin = \(\) => run\(\(\) => drQueueJoin\(\)\)/);
  assert.match(panel, /onClick=\{onJoin\}/);
  // The heartbeat is the status call, never join or leave.
  assert.match(panel, /drQueueStatus\(\)\.then\(showAnswer/);
});

test("heartbeat: server value, a 60 second minimum, a cap, backoff on failure", () => {
  const base = { inLine: true, retryAfterSeconds: 120, failures: 0, hiddenForMs: null, left: false };
  assert.deepEqual(heartbeatPlan(base), { run: true, delayMs: 120_000 });
  assert.equal(heartbeatPlan({ ...base, retryAfterSeconds: null }).delayMs, 120_000);
  assert.equal(heartbeatPlan({ ...base, retryAfterSeconds: 0 }).delayMs, 120_000);
  assert.equal(heartbeatPlan({ ...base, retryAfterSeconds: 5 }).delayMs, 60_000);
  assert.equal(heartbeatPlan({ ...base, retryAfterSeconds: 300 }).delayMs, 300_000);
  assert.equal(heartbeatPlan({ ...base, retryAfterSeconds: 99999 }).delayMs, HEARTBEAT_MAX_SECONDS * 1000);
  assert.equal(heartbeatPlan({ ...base, failures: 1 }).delayMs, 240_000);
  assert.equal(heartbeatPlan({ ...base, failures: 2 }).delayMs, 480_000);
  assert.equal(heartbeatPlan({ ...base, failures: 9 }).delayMs, 600_000);
  for (let f = 0; f < 12; f++) {
    for (const s of [null, 1, 30, 60, 120, 600, 5000]) {
      const d = heartbeatPlan({ ...base, retryAfterSeconds: s, failures: f }).delayMs;
      assert.ok(d >= 60_000 && d <= 600_000, `${s}/${f}: ${d}`);
    }
  }
});

test("heartbeat stops when left, not in line, or hidden for long, and runs while briefly hidden", () => {
  const base = { inLine: true, retryAfterSeconds: 120, failures: 0, hiddenForMs: null, left: false };
  assert.equal(heartbeatPlan({ ...base, left: true }).run, false);
  assert.equal(heartbeatPlan({ ...base, inLine: false }).run, false);
  assert.equal(heartbeatPlan({ ...base, hiddenForMs: HIDDEN_STOP_MS }).run, false);
  assert.equal(heartbeatPlan({ ...base, hiddenForMs: HIDDEN_STOP_MS - 1 }).run, true);
  assert.equal(heartbeatPlan({ ...base, hiddenForMs: 0 }).run, true);
});

test("the home tab shows the panel only for the not-copied-yet state", () => {
  const home = read("../screens/dashboard/HomeTab.tsx");
  assert.match(home, /<DrQueuePanel/);
  assert.match(home, /drChoice\.state === "dr_not_copied_yet"/);
});

test("queue texts keep to plain words", () => {
  const all = JSON.stringify(QUEUE_TEXT);
  for (const bad of [/queue_/, /\bAPI\b/, /\bbackend\b/i, /\bheartbeat\b/i, /\bserver error\b/i]) assert.doesNotMatch(all, bad);
});
