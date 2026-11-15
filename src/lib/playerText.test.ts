import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SUPPORT_URL } from "./support.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const files = [
  "../App.tsx",
  "../auth/AuthContext.tsx",
  "../screens/LoginScreen.tsx",
  "../screens/dashboard/HomeTab.tsx",
  "../screens/dashboard/LibraryTab.tsx",
];

test("player-facing text keeps out the internal wording", () => {
  const banned = [/closed-test/i, /a Revival or/, /Preview build/, /Welcome back/, /Dauntless 1\.12\.0/];
  for (const f of files) {
    const text = read(f);
    for (const re of banned) assert.doesNotMatch(text, re, `${f} still has ${re}`);
  }
});

test("the support link points at the existing support site", () => {
  assert.equal(SUPPORT_URL, "https://support.afterlifeinteractive.com/");
  assert.match(read("../screens/dashboard/AboutTab.tsx"), /https:\/\/support\.afterlifeinteractive\.com\//);
});

test("every error banner, the sign-in screen and the approval screen carry the support link", () => {
  assert.match(read("../components/Banner.tsx"), /SupportLink/);
  assert.match(read("../screens/LoginScreen.tsx"), /<SupportLink/);
  assert.match(read("../App.tsx"), /Need a hand\? <SupportLink/);
  assert.match(read("../screens/dashboard/HomeTab.tsx"), /phase\.message\}\s*<SupportLink/);
});
