// Build planner (Combiner) data and search. Run with: node --test src/lib/  (Node 22.6+ strips the types; no packages needed)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { GEAR, LEGENDARY_WEAPONS, PERKS } from "./combinerData.ts";
import { categoryLabel, combine, MAX_TARGETS, perkCategory, perkList, WEAPONS } from "./combiner.ts";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const Launcher = path.resolve(here, "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(Launcher, rel), "utf8");
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

const ADDED_112 = ["Aegis", "Assassin's Frenzy", "Cascade", "Galvanized", "Invigorated", "Omnisurge", "Pulse", "Relentless", "Rushdown", "Tactician"];

test("the planner is 1.12 only and lists the 66 cells", () => {
  const list = perkList();
  assert.equal(list.length, 66);
  for (const p of ["Iceborne", "Discipline"]) assert.ok(!list.includes(p), `${p} removed`);
  for (const p of [...ADDED_112, "Strategist", "Engineer", "Mender"]) assert.ok(list.includes(p), `${p} in 1.12`);
  assert.ok(!list.includes("Wild Frenzy"));
  assert.ok(!list.includes("Focus / Omnisurge"));
  assert.deepEqual([...list].sort((a, b) => a.localeCompare(b)), list, "sorted");
  assert.ok(PERKS.every((r) => r.length === 2));
});

test("no duplicate perks, gear rows or totals", () => {
  const names = PERKS.map(([n]) => n.toLowerCase());
  assert.equal(new Set(names).size, names.length);
  assert.equal(new Set(perkList()).size, perkList().length);
  const gear = GEAR.map(([part, name]) => `${part}|${name}`);
  assert.equal(new Set(gear).size, gear.length);
  {
    const version = "1.12";
    const r = combine([{ perk: "Tough", level: 6 }, { perk: "Berserker", level: 6 }], { filler: "Rage", power: 3, weapon: "" });
    assert.ok(r.builds.length > 0);
    for (const b of r.builds) {
      const keys = b.totals.map((t) => t.perk.toLowerCase());
      assert.equal(new Set(keys).size, keys.length, "totals unique");
      const parts = b.pieces.map((p) => p.part);
      assert.equal(new Set(parts).size, parts.length, "one piece per part");
    }
  }
});

test("the categories settled from game data", () => {
  const expect: Record<string, string> = {
    Adrenaline: "mobility", Berserker: "power", Bladestorm: "power", "Evasive Fury": "mobility",
    Molten: "utility", Vampiric: "defence", "Weighted Strikes": "power", "Stunning Vigour": "defence",
    Strategist: "defence", Engineer: "utility", Mender: "utility", Omnisurge: "utility",
  };
  for (const [p, c] of Object.entries(expect)) assert.equal(perkCategory(p), c, p);
  assert.equal(perkCategory("Wild Frenzy"), undefined);
  assert.equal(new Set(PERKS.map(([, c]) => c)).size, 5);
  assert.deepEqual([...new Set(PERKS.map(([, c]) => c.toLowerCase()))].sort(), ["defence", "mobility", "power", "technique", "utility"]);
});

test("a target with no cell is ignored", () => {
  const only = combine([{ perk: "Tough", level: 6 }], { filler: "", power: 3, weapon: "" });
  const withBad = combine([{ perk: "Tough", level: 6 }, { perk: "Wild Frenzy", level: 6 }], { filler: "", power: 3, weapon: "" });
  assert.deepEqual(withBad, only);
  const r = combine([{ perk: "Aegis", level: 3 }], { filler: "", power: 3, weapon: "" });
  assert.ok(r.builds[0].totals.some((t) => t.perk === "Aegis" && t.value >= 3));
});

test("the Broadsides Lantern and its toggle are gone", () => {
  assert.ok(!GEAR.some(([, name]) => /broadside/i.test(name)));
  for (const f of ["src/lib/combiner.ts", "src/lib/combinerData.ts", "src/screens/dashboard/BuildPlannerTab.tsx"]) {
    assert.doesNotMatch(read(f), /broadside/i, f);
  }
  const r = combine([{ perk: "Tough", level: 6 }, { perk: "Berserker", level: 6 }, { perk: "Sharpened", level: 3 }], {
    filler: "Rage", power: 3, weapon: "",
  });
  const lanterns = new Set(r.builds.flatMap((b) => b.pieces.filter((p) => p.part === "lantern").map((p) => p.name)));
  assert.deepEqual([...lanterns], ["Drask's Eye"]);
});

test("results equal the old planner with Broadsides off", () => {
  const fx = JSON.parse(fs.readFileSync(path.join(here, "combiner.offstate.fixture.json"), "utf8"));
  assert.equal(fx.cases.length, 8);
  for (const c of fx.cases) {
    // Cases that target a removed cell (Iceborne, Discipline) no longer apply.
    if (!c.targets.every((t: { perk: string }) => perkList().includes(t.perk))) continue;
    // Through JSON like the fixture, so an unset description compares equal.
    const r = JSON.parse(JSON.stringify(combine(c.targets, { filler: c.filler, power: c.power, weapon: c.weapon })));
    const label = c.targets.map((t: { perk: string }) => t.perk).join("+");
    // Repeaters came later and only add options: the best builds stay the same, the count of matches can only grow.
    assert.deepEqual(r.builds, c.result.builds, label);
    assert.equal(r.stoppedEarly, c.result.stoppedEarly, label);
    assert.ok(r.found >= c.result.found, label);
  }
});

test("the planner keeps its storage key, ignores an old saved version and has no network code", () => {
  const tab = strip(read("src/screens/dashboard/BuildPlannerTab.tsx"));
  assert.match(tab, /const STORE_KEY = "rr-planner";/);
  assert.equal((tab.match(/localStorage\.(get|set)Item\(/g) ?? []).length, 2);
  assert.match(tab, /JSON\.stringify\(\{ targets, filler, power, weapon, \.\.\.next \}\)/);
  assert.doesNotMatch(tab, /Game version|1\.4\.4/);
  assert.doesNotMatch(tab, /\.version/);
  assert.match(tab, /list\.includes\(t\.perk\)/);
  for (const f of ["src/lib/combiner.ts", "src/lib/combinerData.ts", "src/screens/dashboard/BuildPlannerTab.tsx"]) {
    assert.doesNotMatch(strip(read(f)), /\bfetch\(|XMLHttpRequest|WebSocket|https?:\/\/|invoke\(/, f);
  }
});

test("categories show their in-game names", () => {
  assert.deepEqual(["power", "technique", "defence", "mobility", "utility"].map(categoryLabel), ["Brutality", "Finesse", "Fortitude", "Alacrity", "Insight"]);
  assert.match(strip(read("src/screens/dashboard/BuildPlannerTab.tsx")), /categoryLabel\(s\.category\)/);
});

test("the planner allows six target perks and searches six quickly", () => {
  assert.equal(MAX_TARGETS, 6);
  const tab = strip(read("src/screens/dashboard/BuildPlannerTab.tsx"));
  assert.match(tab, /targets\.length < MAX_TARGETS/);
  assert.doesNotMatch(tab, /targets\.length < 5/);
  const six = ["Berserker", "Tough", "Sharpened", "Cunning", "Zeal", "Acidic"].map((perk) => ({ perk, level: 3 }));
  const t0 = Date.now();
  const r = combine(six, { filler: "Rage", power: 3, weapon: "" });
  assert.ok(Date.now() - t0 < 20_000, "six targets finish in reasonable time");
  for (const b of r.builds) assert.equal(new Set(b.totals.map((x) => x.perk)).size, b.totals.length);
});

test("legendary weapons are marked from the catalogue's legendary list and the list shows the label", () => {
  const names = new Set(WEAPONS.map((w) => w.name));
  assert.equal(LEGENDARY_WEAPONS.length, 28);
  for (const n of LEGENDARY_WEAPONS) assert.ok(names.has(n), `${n} is a planner weapon`);
  assert.equal(WEAPONS.filter((w) => w.legendary).length, LEGENDARY_WEAPONS.length);
  assert.ok(WEAPONS.find((w) => w.name === "Voidbane")?.legendary);
  assert.ok(!WEAPONS.find((w) => w.name === "Raging Blade")?.legendary);
  assert.match(strip(read("src/screens/dashboard/BuildPlannerTab.tsx")), /\(Legendary\)/);
});

test("repeaters are in the weapon list with their live cell slots, after Aether Strikers, and no bows", () => {
  const rep = WEAPONS.filter((w) => w.type === "Repeaters");
  assert.equal(rep.length, 23);
  assert.ok(!WEAPONS.some((w) => /\bbows?\b/i.test(w.name) || /bow/i.test(w.type)), "no bows");
  const types = WEAPONS.map((w) => w.type);
  assert.ok(types.lastIndexOf("Aether Strikers") < types.indexOf("Repeaters"), "repeaters after Aether Strikers");
  assert.ok(!types.includes("Unclassified"), "every weapon has a type");
  assert.deepEqual(rep.map((w) => w.name), [...rep.map((w) => w.name)].sort((a, b) => a.localeCompare(b)), "A to Z");
  const slots = (n: string) => GEAR.find(([p, name]) => p === "weapon" && name === n)?.[2];
  // From live_cell_slots_1_12.jsonl (WP_DP_FULGAR, WP_DP_BULLSEYE, WP_DP_LAVAROLLER, WP_DP_FUNGUY).
  assert.equal(slots("Thundering Guns"), "Technique, Defence");
  assert.equal(slots("Quillshot's Stingers"), "Power, Defence");
  assert.equal(slots("Inferno's Roar"), "Power, Power");
  assert.equal(slots("Tainted Needles"), "Prismatic, Prismatic");
  assert.ok(rep.find((w) => w.name === "Tainted Needles")?.legendary);
  assert.ok(!rep.find((w) => w.name === "Thundering Guns")?.legendary);
  for (const w of rep) assert.equal(slots(w.name)!.split(", ").length, 2, `${w.name} has two cell slots`);
});

test("a six-perk search with a repeater picked uses that repeater and its slots", () => {
  const six = ["Berserker", "Tough", "Sharpened", "Cunning", "Zeal", "Acidic"].map((perk) => ({ perk, level: 3 }));
  const r = combine(six, { filler: "Rage", power: 3, weapon: "Thundering Guns" });
  assert.ok(r.builds.length > 0);
  for (const b of r.builds) {
    const w = b.pieces.find((p) => p.part === "weapon");
    assert.equal(w?.name, "Thundering Guns");
    assert.deepEqual(w?.slots.map((s) => s.category), ["technique", "defence"]);
    assert.equal(new Set(b.totals.map((x) => x.perk)).size, b.totals.length);
  }
  const any = combine([{ perk: "Berserker", level: 6 }, { perk: "Tough", level: 6 }], { filler: "", power: 3, weapon: "Inferno's Roar" });
  assert.ok(any.builds[0].pieces.find((p) => p.part === "weapon")?.slots.every((s) => s.category === "power"));
});
