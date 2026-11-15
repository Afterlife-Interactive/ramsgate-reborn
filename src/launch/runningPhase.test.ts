// RR-81: running-phase poll. Run with: node --test src/launch/  (Node 22.6+ strips the types; no packages needed)
import { test } from "node:test";
import assert from "node:assert/strict";
import { stillRunning, RUNNING_POLL_MS, type LaunchedGameState } from "./runningPhase.ts";

const state = (s: LaunchedGameState) => () => Promise.resolve(s);
const scanMustNotRun = () => Promise.reject(new Error("the process scan must not run"));

test("the game the launcher started is running", async () => {
  assert.equal(await stillRunning(state("running"), scanMustNotRun), true);
});

test("the game the launcher started has exited, even if the process scan would still see a Dauntless process", async () => {
  assert.equal(await stillRunning(state("exited"), () => Promise.resolve(true)), false);
  assert.equal(await stillRunning(state("exited"), scanMustNotRun), false);
});

test("nothing launched this run falls back to the process scan", async () => {
  assert.equal(await stillRunning(state("none"), () => Promise.resolve(true)), true);
  assert.equal(await stillRunning(state("none"), () => Promise.resolve(false)), false);
});

test("a failing scan is passed on so the caller keeps the phase and retries", async () => {
  await assert.rejects(stillRunning(state("none"), scanMustNotRun));
});

test("polls often enough that Play comes back within a few seconds", () => {
  assert.ok(RUNNING_POLL_MS > 0 && RUNNING_POLL_MS <= 5_000);
});
