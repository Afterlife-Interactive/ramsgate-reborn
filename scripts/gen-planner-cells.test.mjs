import { build, readPlanner } from "./gen-planner-cells.mjs";
import fs from "node:fs"; import assert from "node:assert";
const r = build(fs.readFileSync(new URL("./fixtures/cells.sample.jsonl", import.meta.url), "utf8"),
  { WP_DP_BULLSEYE: "Quillshot's Stingers", WP_BOW_SALT: "Bow Salt", WP_AC_BULLSEYE: "X" });
assert.equal(r.count, 1);
assert.ok(r.gear.includes('  ["weapon","Quillshot\'s Stingers","Power, Utility",""]'));
assert.ok(!JSON.stringify(r).includes("Bow"));
const row = (id, ...c) => JSON.stringify({ itemId: id, cellSlots: c.map((n, i) => ({ slotIndex: i, cellTypeName: n })) });
const r2 = build(row("WP_DP_BOWMAN", "power") + "\n" + row("WP_BOW_X", "power"), { WP_DP_BOWMAN: "Longbow Stingers", WP_BOW_X: "Plain" });
assert.equal(r2.count, 0);

// Planner filter: only families the other weapon types already list; legendary family carries over; "any" is Prismatic.
const names = { WP_EB_FULGAR: "Thundering Blade", WP_DP_FULGAR: "Thundering Guns", WP_EB_FUNGUY: "Poisonous Thorn",
  WP_DP_FUNGUY: "Tainted Needles", WP_DP_HP05_NINJA_00: "Sharp Shots", WP_DP_OLD: "Old Guns" };
const planner = readPlanner('export const GEAR = [["weapon","Thundering Blade","Power, Defence",""],\n  ["weapon","Poisonous Thorn","Prismatic, Prismatic",""],\n  ["weapon","Old Guns","Power",""]];\n' +
  'export const LEGENDARY_WEAPONS: string[] = ["Poisonous Thorn"];');
const jl = [row("WP_DP_FULGAR", "technique", "defence"), row("WP_DP_FUNGUY", "any", "any"), row("WP_DP_HP05_NINJA_00", "technique", "mobility"), row("WP_DP_OLD", "power")].join("\n");
const r3 = build(jl, names, planner);
assert.deepEqual(r3.rows.map((x) => x.name), ["Tainted Needles", "Thundering Guns"]);
assert.ok(r3.gear.includes('  ["weapon","Tainted Needles","Prismatic, Prismatic",""]'));
assert.ok(r3.gear.includes('  ["weapon","Thundering Guns","Technique, Defence",""]'));
assert.deepEqual(r3.legendary, ["Tainted Needles"]);
console.log("ok");
