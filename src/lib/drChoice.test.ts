// Run with: node --test src/lib/  (Node 22.6+ strips the types; no packages needed)
import test from "node:test";
import assert from "node:assert/strict";
import {
  DR_CHOICE_STATES,
  DR_FLOW_START,
  DR_PLAY_ENDS_OPTION,
  DR_TEXT,
  stepFlow,
  viewFor,
  type DrFlow,
  type DrFlowAction,
  type DrDecisionReply,
  CLAIM_CODE_STATE,
  viewForClaimCode,
  showClaimNotice,
} from "./drChoice.ts";

test("every state maps to the right view", () => {
  assert.deepEqual(viewFor({ state: "dr_choice_open" }), { kind: "screen", state: "dr_choice_open", blocksPlay: true });
  assert.deepEqual(viewFor({ state: "dr_no_dr_account" }), { kind: "none", state: "dr_no_dr_account" });
  const notices: Array<[string, string, boolean]> = [
    ["dr_transfers_ended", DR_TEXT.transfersEnded, false],
    ["dr_already_declined", DR_TEXT.alreadyDeclined, false],
    ["dr_already_transferred", DR_TEXT.alreadyTransferred, false],
    ["dr_has_progress", DR_TEXT.hasProgress, false],
    ["dr_try_again_later", DR_TEXT.tryAgainLater, true],
  ];
  for (const [state, text, retry] of notices) {
    const v = viewFor({ state });
    assert.equal(v.kind, "notice", state);
    if (v.kind === "notice") {
      assert.equal(v.text, text);
      assert.equal(v.retry, retry);
      assert.equal(v.blocksPlay, false);
    }
  }
  assert.equal(DR_CHOICE_STATES.length, 8);
});

test("only the open choice blocks Play", () => {
  for (const state of DR_CHOICE_STATES) {
    const v = viewFor({ state });
    const blocks = v.kind === "screen" && v.blocksPlay;
    assert.equal(blocks, state === "dr_choice_open", state);
  }
});

test("not copied yet is a notice that allows play and says playing first ends the option", () => {
  const v = viewFor({ state: "dr_not_copied_yet" });
  assert.equal(v.kind, "notice");
  if (v.kind === "notice") {
    assert.equal(v.blocksPlay, false);
    assert.equal(v.text, DR_PLAY_ENDS_OPTION ? DR_TEXT.notCopiedYet : DR_TEXT.notCopiedYetKeepPlaying);
    assert.ok(v.text.includes("has not been copied over yet"));
    assert.ok(DR_TEXT.notCopiedYet.includes("you lose the chance to move it"));
    assert.ok(DR_TEXT.notCopiedYetKeepPlaying.includes("Moving is only possible until you start playing for real: finishing a hunt, earning XP, levels or currency, or getting items ends it."));
  }
});

test("the server's own text is used when given, the launcher text otherwise", () => {
  const v = viewFor({ state: "dr_transfers_ended", text: "  Transfers are closed.  " });
  assert.ok(v.kind === "notice" && v.text === "Transfers are closed.");
  const w = viewFor({ state: "dr_transfers_ended", text: "" });
  assert.ok(w.kind === "notice" && w.text === DR_TEXT.transfersEnded);
  const x = viewFor({ state: "dr_not_copied_yet", text: "Not ready yet." });
  assert.ok(x.kind === "notice" && x.text === "Not ready yet.", "the server's not-copied text is shown as sent, nothing appended");
});

test("an unknown or missing answer is a retry notice and never blocks play", () => {
  for (const a of [{ state: "something_new" }, null, undefined, { state: "" }]) {
    const v = viewFor(a);
    assert.ok(v.kind === "notice" && v.state === "dr_try_again_later" && v.retry && !v.blocksPlay);
  }
});

test("the screen starts with nothing chosen and nothing sent", () => {
  assert.deepEqual(DR_FLOW_START, { step: "choose" });
});

test("both choices need a second, separate confirm, and nothing is sent before it", () => {
  for (const choice of ["transfer", "decline"] as const) {
    const picked = stepFlow(DR_FLOW_START, { type: "pick", choice });
    assert.equal(picked.send, null);
    assert.deepEqual(picked.flow, { step: "confirm", choice });
    const done = stepFlow(picked.flow, { type: "confirm" });
    assert.deepEqual(done.send, { choice, confirmed: true });
    assert.equal(done.flow.step, "sending");
  }
});

test("confirm cannot be skipped from the first step", () => {
  const r = stepFlow(DR_FLOW_START, { type: "confirm" });
  assert.equal(r.send, null);
  assert.deepEqual(r.flow, DR_FLOW_START);
});

test("going back sends nothing and keeps no choice", () => {
  const picked = stepFlow(DR_FLOW_START, { type: "pick", choice: "decline" });
  const back = stepFlow(picked.flow, { type: "back" });
  assert.equal(back.send, null);
  assert.deepEqual(back.flow, DR_FLOW_START);
});

test("Esc or closing does nothing at every step", () => {
  const flows: DrFlow[] = [
    { step: "choose" },
    { step: "confirm", choice: "transfer" },
    { step: "sending", choice: "decline" },
    { step: "failed", choice: "decline" },
  ];
  for (const f of flows) {
    const r = stepFlow(f, { type: "dismiss" });
    assert.equal(r.send, null);
    assert.deepEqual(r.flow, f);
  }
});

test("no action from any step sends anything except a confirm that follows a pick", () => {
  const flows: DrFlow[] = [
    { step: "choose" },
    { step: "confirm", choice: "transfer" },
    { step: "sending", choice: "transfer" },
    { step: "failed", choice: "transfer" },
  ];
  const actions: DrFlowAction[] = [
    { type: "pick", choice: "transfer" },
    { type: "pick", choice: "decline" },
    { type: "back" },
    { type: "dismiss" },
    { type: "sent_failed" },
    { type: "confirm" },
  ];
  for (const f of flows) {
    for (const a of actions) {
      const r = stepFlow(f, a);
      const allowed = a.type === "confirm" && (f.step === "confirm" || f.step === "failed");
      assert.equal(r.send !== null, allowed, `${f.step} + ${a.type}`);
    }
  }
});

test("a second confirm while sending sends nothing more", () => {
  const sending = stepFlow(stepFlow(DR_FLOW_START, { type: "pick", choice: "transfer" }).flow, { type: "confirm" }).flow;
  assert.equal(stepFlow(sending, { type: "confirm" }).send, null);
});

test("a failed send needs a manual confirm again; it never resends by itself", () => {
  const sending: DrFlow = { step: "sending", choice: "decline" };
  const failed = stepFlow(sending, { type: "sent_failed" });
  assert.equal(failed.send, null);
  assert.equal(failed.flow.step, "failed");
  assert.deepEqual(stepFlow(failed.flow, { type: "confirm" }).send, { choice: "decline", confirmed: true });
});

test("the plain texts have no em dashes", () => {
  const all = JSON.stringify(DR_TEXT);
  assert.ok(!all.includes("—"));
});

test("the old claim route codes show the same notices as the matching states", () => {
  assert.deepEqual(Object.keys(CLAIM_CODE_STATE).sort(), ["declined", "not_copied_yet", "transfers_ended", "try_later"]);
  for (const [code, state] of Object.entries(CLAIM_CODE_STATE)) {
    assert.deepEqual(viewForClaimCode(code), viewFor({ state }), code);
    const v = viewForClaimCode(code);
    assert.ok(v && v.kind === "notice" && !v.blocksPlay, code);
  }
  assert.equal(viewForClaimCode("ported"), null);
});

test("a decision answer and a 400 answer fit the types; a 400 never counts as saved", () => {
  const ok: DrDecisionReply = { ok: true, state: "dr_already_declined", text: "x" };
  assert.equal(viewFor(ok).kind, "notice");
  const bad: DrDecisionReply = { ok: false, state: "", code: "dr_confirmation_required", text: "Please confirm" };
  const v = viewFor(bad);
  assert.ok(v.kind === "notice" && v.state === "dr_try_again_later" && v.retry);
});

test("the decision body the page produces always says confirmed: true and holds no keys", () => {
  const sent = stepFlow({ step: "confirm", choice: "transfer" }, { type: "confirm" }).send;
  assert.deepEqual(sent, { choice: "transfer", confirmed: true });
  assert.strictEqual(sent?.confirmed, true);
  // The keys are added by the native side (dr_claim.rs, test choice_bodies_match_the_backend); the page never holds them.
  assert.ok(!("keys" in (sent ?? {})));
});

test("what ends the option is said in plain words", () => {
  for (const t of [DR_TEXT.endsOption, DR_TEXT.hasProgress, DR_TEXT.notCopiedYet]) {
    assert.ok(/hunt/.test(t) && /XP/.test(t) && /items/.test(t), t);
  }
  assert.equal(DR_TEXT.endsOption, "Moving is only possible until you start playing for real: finishing a hunt, earning XP, levels or currency, or getting items ends it.");
});

test("the old claim notice is hidden whenever the choice notice already says the same thing", () => {
  for (const state of ["dr_not_copied_yet", "dr_transfers_ended", "dr_already_declined", "dr_try_again_later"]) {
    assert.equal(showClaimNotice(viewFor({ state })), false, state);
  }
  assert.equal(showClaimNotice("loading"), false);
  assert.equal(showClaimNotice(viewFor({ state: "dr_no_dr_account" })), true);
  assert.equal(showClaimNotice(viewFor({ state: "dr_choice_open" })), true);
});
