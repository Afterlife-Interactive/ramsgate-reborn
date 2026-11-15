// Run with: node --test src/ui/
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { nextThemeIndex } from "./themePickerKeys.ts";

test("arrows move through a two-column list", () => {
  assert.equal(nextThemeIndex(0, "ArrowRight", 14, 2), 1);
  assert.equal(nextThemeIndex(1, "ArrowLeft", 14, 2), 0);
  assert.equal(nextThemeIndex(0, "ArrowDown", 14, 2), 2);
  assert.equal(nextThemeIndex(5, "ArrowUp", 14, 2), 3);
  assert.equal(nextThemeIndex(4, "Home", 14, 2), 0);
  assert.equal(nextThemeIndex(4, "End", 14, 2), 13);
});

test("moves stop at the edges", () => {
  assert.equal(nextThemeIndex(0, "ArrowLeft", 14, 2), 0);
  assert.equal(nextThemeIndex(1, "ArrowUp", 14, 2), 1);
  assert.equal(nextThemeIndex(13, "ArrowRight", 14, 2), 13);
  assert.equal(nextThemeIndex(12, "ArrowDown", 14, 2), 12);
});

test("other keys and an empty list are left alone", () => {
  assert.equal(nextThemeIndex(3, "Enter", 14, 2), null);
  assert.equal(nextThemeIndex(3, "a", 14, 2), null);
  assert.equal(nextThemeIndex(0, "ArrowDown", 0, 2), null);
});

test("the first-run picker has one Continue button, a default and keyboard handling", () => {
  const src = readFileSync("src/theme/ThemeContext.tsx", "utf8");
  const picker = src.slice(src.indexOf("export function FirstThemePicker"), src.indexOf("export function useTheme"));
  assert.equal(picker.match(/>\s*Continue\s*</g)?.length, 1);
  assert.match(picker, /role="dialog"/);
  assert.match(picker, /role="radiogroup"/);
  assert.match(picker, /nextThemeIndex/);
  assert.match(picker, /DEFAULT_THEME/);
  // Player-facing text stays plain: no emoji in the picker.
  assert.doesNotMatch(picker, /\p{Extended_Pictographic}/u);
});
