// Run with: node --test src/ui/  (reads the screen sources; no window needed)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const choice = read("../screens/dashboard/DrChoiceScreen.tsx");
const home = read("../screens/dashboard/HomeTab.tsx");

test("the choice card scrolls its text and keeps both buttons in view (960x600)", () => {
  // The overlay no longer scrolls as a whole; the card is capped to the area and its text scrolls inside.
  assert.match(choice, /overflow-hidden bg-black\/70/);
  assert.match(choice, /grid-rows-\[minmax\(0,1fr\)\]/);
  assert.match(choice, /flex max-h-full w-full max-w-\[520px\] flex-col/);
  // Two scroll areas (step 1 and step 2), each followed by a button row that does not shrink and does not scroll.
  assert.equal((choice.match(/min-h-0 overflow-y-auto/g) ?? []).length, 2);
  assert.equal((choice.match(/mt-5 flex shrink-0 flex-wrap gap-3/g) ?? []).length, 2);
});

test("the double confirm, no pre-selection and the inert Esc are unchanged by the layout", () => {
  assert.match(choice, /e\.key === "Escape"/);
  assert.match(choice, /dispatch\(\{ type: "dismiss" \}\)/);
  assert.match(choice, /headingRef\.current\?\.focus\(\)/);
  assert.ok(!/autoFocus/.test(choice));
  assert.match(choice, /type: "confirm"/);
});

test("the line panel sits beside the headline, not under it", () => {
  assert.match(home, /className="relative flex min-h-full flex-col justify-between/);
  assert.match(home, /absolute right-12 top-3 z-10 w-\[320px\] rounded-2xl bg-black\/70/);
  const wrapper = home.indexOf("absolute right-12 top-3 z-10 w-[320px] rounded-2xl");
  assert.ok(wrapper > 0 && home.indexOf("<DrQueuePanel", wrapper) > wrapper);
});
