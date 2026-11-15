// Run with: node --test src/ui/
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clearLegacyScale, LEGACY_SCALE_KEY } from "./legacyScaleReset.ts";

function mem(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return { m, getItem: (k: string) => m.get(k) ?? null, removeItem: (k: string) => void m.delete(k) };
}

test("a stored scale is removed and reported", () => {
  const s = mem({ [LEGACY_SCALE_KEY]: "150" });
  assert.equal(clearLegacyScale(s), true);
  assert.equal(s.m.size, 0);
});
test("nothing stored, no storage, or throwing storage is a quiet no", () => {
  assert.equal(clearLegacyScale(mem()), false);
  assert.equal(clearLegacyScale(null), false);
  assert.equal(clearLegacyScale({ getItem() { throw new Error("x"); }, removeItem() {} }), false);
});
test("the scale control is gone from Settings and App", () => {
  const settings = readFileSync("src/screens/dashboard/SettingsTab.tsx", "utf8");
  assert.doesNotMatch(settings, /ui-scale|UiScale|UI scale/);
  const app = readFileSync("src/App.tsx", "utf8");
  assert.doesNotMatch(app, /UiScaleProvider/);
  assert.match(app, /<ScaleResetOnStart \/>/);
});
