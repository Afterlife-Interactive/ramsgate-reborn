// RR-38: Offline rates sliders. Run with: node --test src/offline/  (Node 22.6+ strips the types; no packages needed)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import {
  OFFICIAL_RATES,
  PRESETS,
  RATE_FIELDS,
  RATE_LIMITS,
  clampRates,
  clampValue,
  formatRate,
  presetOf,
  validateRates,
  type NumericRateKey,
} from "./rates.ts";

const Here = path.dirname(url.fileURLToPath(import.meta.url));
const Repo = path.resolve(Here, "..", "..", "..");

// Parses `key: { min: N, max: N[, integer: true] }` lines out of a TypeScript or Rust source block.
function limitsFrom(src: string, startMarker: string, endMarker: string): Record<string, { min: number; max: number; integer: boolean }> {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `${startMarker} not found`);
  const block = src.slice(start, src.indexOf(endMarker, start));
  const out: Record<string, { min: number; max: number; integer: boolean }> = {};
  for (const m of block.matchAll(/(\w+):\s*\{\s*min:\s*([\d.]+),\s*max:\s*([\d.]+)(,\s*integer:\s*true)?\s*\}/g)) {
    out[m[1]] = { min: Number(m[2]), max: Number(m[3]), integer: !!m[4] };
  }
  return out;
}

test("clamping keeps every value in range and rounds integers", () => {
  assert.equal(clampValue("xp", 50), 10);
  assert.equal(clampValue("xp", 0), 0.5);
  assert.equal(clampValue("coinChance", -1), 0);
  assert.equal(clampValue("coinsPerRun", 3.6), 4);
  assert.equal(clampValue("ramsPerGrant", 123456), 100000);
  assert.equal(clampValue("materials", 2.345), 2.35);
  assert.equal(clampValue("bountyTokensPerDay", Number.NaN), OFFICIAL_RATES.bountyTokensPerDay);
  const r = clampRates({ xp: "5" as unknown as number, coinsFromAllEscalations: "yes" as unknown as boolean, materials: Infinity });
  assert.equal(r.xp, OFFICIAL_RATES.xp);
  assert.equal(r.coinsFromAllEscalations, false);
  assert.equal(r.materials, OFFICIAL_RATES.materials);
});

test("validation explains bad values", () => {
  assert.deepEqual(validateRates({ ...OFFICIAL_RATES }), {});
  const e = validateRates({ ...OFFICIAL_RATES, xp: 11, coinsPerRun: 1.5, coinChance: Number.NaN });
  assert.match(e.xp ?? "", /Between 0.5 and 10/);
  assert.match(e.coinsPerRun ?? "", /Whole numbers/);
  assert.match(e.coinChance ?? "", /number/);
});

test("presets are inside the limits and recognised; anything else is Custom", () => {
  for (const [id, p] of Object.entries(PRESETS)) {
    assert.deepEqual(clampRates(p), p, id);
    assert.equal(presetOf({ ...p }), id);
  }
  assert.deepEqual(PRESETS["1x"], OFFICIAL_RATES);
  assert.equal(PRESETS["5x"].coinChance, 1);
  assert.equal(PRESETS["2x"].ramsPerGrant, 10000);
  assert.equal(presetOf({ ...OFFICIAL_RATES, xp: 3 }), "custom");
});

test("every slider is labelled experimental until its in-game test passes", () => {
  assert.equal(RATE_FIELDS.length, Object.keys(RATE_LIMITS).length);
  for (const f of RATE_FIELDS) {
    assert.equal(f.experimental, true, f.key);
    const l = RATE_LIMITS[f.key];
    assert.ok(f.step > 0 && f.step <= l.max - l.min, f.key);
  }
  // No bounty reward XP slider in v1 (owner decision) and no cell fusion slider before the DLL side exists.
  assert.ok(!RATE_FIELDS.some((f) => /bountyReward|cellFusion/i.test(f.key)));
});

test("formatting", () => {
  const xp = RATE_FIELDS.find((f) => f.key === "xp")!;
  const chance = RATE_FIELDS.find((f) => f.key === "coinChance")!;
  const rams = RATE_FIELDS.find((f) => f.key === "ramsPerGrant")!;
  assert.equal(formatRate(xp, 1), "1x");
  assert.equal(formatRate(xp, 2.5), "2.5x");
  assert.equal(formatRate(xp, 10), "10x");
  assert.equal(formatRate(chance, 0.25), "25%");
  assert.equal(formatRate(rams, 5000), "5,000");
});
