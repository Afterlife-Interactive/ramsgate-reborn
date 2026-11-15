// Turns live_cell_slots_1_12.jsonl (CatalogExporter, EXPORT_CELLS=1) into build planner rows for
// weapon types the planner does not have yet (repeaters WP_DP_* only; bows are not finished and are always filtered out).
// Only repeaters of a family the planner already lists for the other weapon types are added (behemoth, Recruit and
// legendary weapons, same as the other types); hunt pass and event repeaters are left out like their sword/axe twins.
// A repeater is marked legendary when its family is legendary in the planner. Weapon perks are not in the export, so
// repeater rows carry no perk (their cell slots still count).
// Usage: node scripts/gen-planner-cells.mjs <live_cell_slots_1_12.jsonl> <grant_catalog.json> [--apply]
// Without --apply it prints the rows; with --apply it adds them to src/lib/combinerData.ts (rows already there are skipped).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TYPES = [["WP_DP_", "Repeaters"]];
const BOW_RE = /(^|[^a-z])(long|short|cross)?bows?([^a-z]|$)/i;
const isBow = (id, name) => BOW_RE.test(id ?? "") || BOW_RE.test(name ?? "");
const CAT = { any: "Prismatic", prismatic: "Prismatic", defense: "Defence", defence: "Defence", power: "Power", technique: "Technique", mobility: "Mobility", utility: "Utility" };
const family = (id) => id.replace(/^WP_[A-Z]+_/, "");

/**
 * planner (optional): { weapons: string[] names already in the planner, legendary: string[] } -> family filter + legendary.
 * Without it every repeater with a name and known slots is returned (used by the unit test).
 */
export function build(jsonl, names, planner) {
  let fams = null, legFams = null, have = new Set();
  if (planner) {
    const ids = {};
    for (const [id, n] of Object.entries(names)) (ids[n] ??= []).push(id);
    fams = new Set(); legFams = new Set(); have = new Set(planner.weapons);
    const leg = new Set(planner.legendary ?? []);
    for (const n of planner.weapons) for (const id of ids[n] ?? []) {
      if (!/^WP_[A-Z]+_/.test(id) || id.startsWith("WP_DP_")) continue;
      fams.add(family(id)); if (leg.has(n)) legFams.add(family(id));
    }
  }
  const seen = new Map();
  for (const ln of jsonl.split(/\r?\n/)) {
    if (!ln.trim()) continue;
    let o; try { o = JSON.parse(ln); } catch { continue; }
    const t = TYPES.find(([p]) => o.itemId?.startsWith(p));
    const name = names[o.itemId];
    if (!t || isBow(o.itemId, name) || !name || seen.has(o.itemId) || have.has(name)) continue;
    if (fams && !fams.has(family(o.itemId))) continue;
    const slots = (o.cellSlots ?? []).slice().sort((a, b) => a.slotIndex - b.slotIndex)
      .map((s) => CAT[String(s.cellTypeName).toLowerCase().replace(/^ecelltype::/, "")] ?? null);
    if (!slots.length || slots.includes(null)) continue; // unknown category: skip, never guess
    seen.set(o.itemId, { name, type: t[1], slots: slots.join(", "), legendary: !!legFams?.has(family(o.itemId)) });
  }
  const rows = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    rows,
    gear: rows.map((r) => `  ["weapon",${JSON.stringify(r.name)},${JSON.stringify(r.slots)},""]`),
    types: rows.map((r) => `${JSON.stringify(r.name)}:${JSON.stringify(r.type)}`),
    legendary: rows.filter((r) => r.legendary).map((r) => r.name),
    count: rows.length,
  };
}

export function loadNames(file) {
  const j = JSON.parse(fs.readFileSync(file, "utf8")); const m = {};
  const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") { if (v.id && v.name) m[v.id] = v.name; Object.values(v).forEach(walk); } };
  walk(j); return m;
}

/** Weapon names and legendary list already in combinerData.ts. */
export function readPlanner(src) {
  const weapons = [...src.matchAll(/\["weapon",("(?:[^"\\]|\\.)*"),/g)].map((m) => JSON.parse(m[1]));
  const lm = src.match(/export const LEGENDARY_WEAPONS[^=]*=\s*(\[[^\]]*\])/);
  return { weapons, legendary: lm ? JSON.parse(lm[1]) : [] };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [jl, cat] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!jl || !cat) { console.error("usage: node scripts/gen-planner-cells.mjs <jsonl> <grant_catalog.json> [--apply]"); process.exit(1); }
  const f = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/lib/combinerData.ts");
  let s = fs.readFileSync(f, "utf8");
  const r = build(fs.readFileSync(jl, "utf8"), loadNames(cat), readPlanner(s));
  if (!process.argv.includes("--apply")) {
    console.log(r.gear.join(",\n")); console.log(r.types.join(",")); console.log("legendary: " + r.legendary.join(", "));
    console.error(r.count + " weapons");
  } else if (r.count) {
    // After the last weapon row, so search ties keep picking the same pieces as before.
    const lines = s.split("\n");
    const last = lines.reduce((k, l, i) => (/^\s*\["weapon",/.test(l) ? i : k), -1);
    if (last < 0 || !lines[last].trimEnd().endsWith(",")) { console.error("no weapon rows in combinerData.ts"); process.exit(1); }
    lines.splice(last + 1, 0, ...r.gear.map((g) => g + ","));
    s = lines.join("\n");
    s = s.replace(/(export const WEAPON_TYPES[^{]*\{)/, `$1${r.types.join(",")},`);
    if (r.legendary.length) s = s.replace(/(export const LEGENDARY_WEAPONS[^=]*=\s*\[)/, `$1${r.legendary.map((n) => JSON.stringify(n)).join(",")},`);
    fs.writeFileSync(f, s); console.error("applied " + r.count + " weapons, " + r.legendary.length + " legendary");
  } else console.error("nothing to add");
}
