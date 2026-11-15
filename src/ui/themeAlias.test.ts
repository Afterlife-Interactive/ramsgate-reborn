// Run with: node --test src/ui/
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renamedThemeId } from "./themeAlias.ts";

test("a saved shavyt theme loads as sahvyt, everything else is left alone", () => {
  assert.equal(renamedThemeId("shavyt"), "sahvyt");
  for (const id of [null, "sahvyt", "nightshade", "reza", "constructor", "toString", "__proto__", ""]) {
    assert.equal(renamedThemeId(id), undefined, String(id));
  }
});

// Behemoth names as the 1.12 game spells them (Archon/Content/Localization/Game/en/Game.locres).
const GAME_NAMES = new Set(["Agarus", "Alyra", "Boreus", "Charrogg", "Chronovore", "Drask", "Embermane", "Fenroar",
  "Frostwing", "Gnasher", "Hellion", "Kharabak", "Koshai", "Malkarion", "Nayzaga", "Pangar", "Phaelanx", "Quillshot",
  "Rezakiri", "Riftstalker", "Sahvyt", "Shrike", "Shrowd", "Skarn", "Skraev", "Stormclaw", "Thrax", "Torgadoro", "Urska",
  "Valomyr"]);

test("every theme is named after a behemoth, spelled as in the game", () => {
  const source = readFileSync(new URL("../theme/ThemeContext.tsx", import.meta.url), "utf8");
  const names = [...source.matchAll(/\{ id: "[a-z]+", name: "([^"]+)"/g)].map((m) => m[1]);
  assert.equal(names.length, 14);
  for (const name of names) assert.ok(GAME_NAMES.has(name), `${name} is not a 1.12 behemoth name`);
});
