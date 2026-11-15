import { GEAR, LEGENDARY_WEAPONS, PERKS, WEAPON_TYPES } from "./combinerData.ts";

export const PART_LABEL: Record<string, string> = {
  weapon: "Weapon",
  head: "Head armour",
  body: "Torso armour",
  arms: "Arms armour",
  legs: "Legs armour",
  lantern: "Lantern",
};
const PART_ORDER = ["weapon", "head", "body", "arms", "legs", "lantern"];
const WEAPON_ORDER = ["Sword", "Axe", "Hammer", "Chain Blades", "War Pike", "Aether Strikers", "Repeaters", "Unclassified"];

export const PERK_DESC: Record<string, string> = {
  bladestorm: "+40 Part Damage on Hit. +400 Part Damage after dodging through an attack.",
  cunning: "10% critical strike chance, +30% critical strike damage.",
  iceborne:
    "When under 50% health, grants +30% decreased damage taken. While Iceborne is active, grants 8% lifesteal that cannot heal beyond 50% health.",
  sharpened: "+30% Part Damage. After dodging through an attack the next weapon attack’s Part Break Damage is increased by 100%.",
  tough: "Increases Max Health by 500. Increased healing from all sources by 50%.",
  zeal: "+65% Lantern tap ability effectiveness.",
};

/** In-game names of the five cell categories (ids stay power, technique, defence, mobility, utility). */
export const CATEGORY_LABEL: Record<string, string> = {
  power: "Brutality",
  technique: "Finesse",
  defence: "Fortitude",
  mobility: "Alacrity",
  utility: "Insight",
  prismatic: "Prismatic",
};
export const categoryLabel = (id: string) => CATEGORY_LABEL[id] ?? id;

const norm = (s: string) => s.trim().toLowerCase().replace("defense", "defence");

interface Item {
  part: string;
  name: string;
  sl: Record<string, number>;
  pk: Record<string, number>;
}

const PERK_NAME: Record<string, string> = {};
// Cell category by perk (Ramsgate Reborn, 1.12).
const PERK_CAT: Record<string, string> = {};
for (const [name, cat] of PERKS) {
  PERK_NAME[norm(name)] = name;
  PERK_CAT[norm(name)] = norm(cat);
}

const ITEMS: Item[] = GEAR.map(([part, name, slots, perks]) => {
  const sl: Record<string, number> = {};
  for (const s of slots.split(",")) {
    const k = norm(s);
    if (k) sl[k] = (sl[k] ?? 0) + 1;
  }
  const pk: Record<string, number> = {};
  for (const s of perks.split(",")) {
    const m = s.trim().match(/^(.*?)[\s:+x]*(\d+)$/);
    if (m) pk[norm(m[1])] = (pk[norm(m[1])] ?? 0) + Number(m[2]);
  }
  return { part, name, sl, pk };
});

const PERK_LIST: string[] = PERKS.map(([n]) => n).sort((a, b) => a.localeCompare(b));
/** Perks that have a cell, A to Z. */
export const perkList = (): string[] => PERK_LIST;
/** Cell category of a perk (lower case), or undefined when there is no such cell. */
export const perkCategory = (perk: string): string | undefined => PERK_CAT[norm(perk)];
export const weaponType = (name: string) => WEAPON_TYPES[name] ?? "Unclassified";
export const MAX_TARGETS = 6;
const LEGENDARY = new Set(LEGENDARY_WEAPONS);
export const WEAPONS: { name: string; type: string; legendary: boolean }[] = ITEMS.filter((i) => i.part === "weapon")
  .map((i) => ({ name: i.name, type: weaponType(i.name), legendary: LEGENDARY.has(i.name) }))
  .sort((a, b) => WEAPON_ORDER.indexOf(a.type) - WEAPON_ORDER.indexOf(b.type) || a.name.localeCompare(b.name));

export interface TargetInput {
  perk: string;
  level: number;
}
export interface SlotView {
  category: string;
  cell: string | null;
}
export interface PieceView {
  part: string;
  name: string;
  perks: string;
  slots: SlotView[];
}
export interface BuildView {
  cost: number;
  pieces: PieceView[];
  totals: { perk: string; value: number; desc?: string }[];
}
export interface CombineResult {
  builds: BuildView[];
  found: number;
  stoppedEarly: boolean;
}

const LIMIT = 1_500_000;

export function combine(
  targetsIn: TargetInput[],
  opts: { filler: string; power: number; weapon: string },
): CombineResult {
  const pow = Math.max(1, Math.min(3, opts.power || 3));
  const tg: Record<string, number> = {};
  for (const t of targetsIn) {
    const k = norm(t.perk);
    if (PERK_CAT[k]) tg[k] = Math.max(1, Math.min(6, t.level));
  }
  const fk = norm(opts.filler);
  let items = ITEMS;
  if (opts.weapon) items = items.filter((i) => i.part !== "weapon" || i.name === opts.weapon);
  const rel: Record<string, true> = {};
  for (const k of Object.keys(tg)) rel[k] = true;
  if (fk) rel[fk] = true;
  // Pieces with the same slots and the same useful perks are interchangeable; keep one.
  const seen = new Set<string>();
  items = items.filter((it) => {
    const ks = Object.keys(it.sl).sort().map((k) => k + it.sl[k]).join(",");
    const ps = Object.keys(it.pk).filter((k) => rel[k] && it.pk[k]).sort().map((k) => k + it.pk[k]).join(",");
    const sg = `${it.part}|${ks}|${ps}`;
    if (seen.has(sg)) return false;
    seen.add(sg);
    return true;
  });
  const groups = PART_ORDER.map((p) => items.filter((i) => i.part === p)).filter((g) => g.length);

  interface Res {
    cost: number;
    pick: Item[];
    cells: Record<string, number>;
    fill: number;
    ts: number;
    pk: Record<string, number>;
  }
  const res: Res[] = [];
  let count = 0;
  const evalc = (pick: Item[], sl: Record<string, number>, pk: Record<string, number>) => {
    const used: Record<string, number> = {};
    const cells: Record<string, number> = {};
    for (const k of Object.keys(tg)) {
      const n = Math.ceil(Math.max(0, tg[k] - (pk[k] ?? 0)) / pow);
      cells[k] = n;
      used[PERK_CAT[k]] = (used[PERK_CAT[k]] ?? 0) + n;
    }
    const wild = sl.prismatic ?? 0;
    let def = 0;
    for (const c of Object.keys(used)) {
      const o = used[c] - (sl[c] ?? 0);
      if (o > 0) def += o;
    }
    if (def > wild) return;
    const spare: Record<string, number> = {};
    for (const s of Object.keys(sl)) if (s !== "prismatic") spare[s] = Math.max(0, sl[s] - (used[s] ?? 0));
    const pr = wild - def;
    if (pr > 0) spare.prismatic = pr;
    let fill = 0;
    if (fk && PERK_CAT[fk] && !(fk in tg)) {
      fill = Math.min(((spare[PERK_CAT[fk]] ?? 0) + Math.max(0, pr)) * pow, Math.max(0, 6 - (pk[fk] ?? 0)));
    }
    let ts = 0;
    for (const z of Object.keys(spare)) ts += spare[z];
    let cost = 0;
    for (const k of Object.keys(cells)) cost += cells[k];
    res.push({ cost, pick, cells, fill, ts, pk });
  };
  const rec = (i: number, pick: Item[], sl: Record<string, number>, pk: Record<string, number>) => {
    if (count > LIMIT) return;
    if (i === groups.length) {
      count++;
      evalc(pick, sl, pk);
      return;
    }
    for (const it of groups[i]) {
      const s2 = { ...sl };
      const p2 = { ...pk };
      for (const k of Object.keys(it.sl)) s2[k] = (s2[k] ?? 0) + it.sl[k];
      for (const q of Object.keys(it.pk)) p2[q] = (p2[q] ?? 0) + it.pk[q];
      rec(i + 1, [...pick, it], s2, p2);
    }
  };
  rec(0, [], {}, {});
  res.sort((a, b) => a.cost - b.cost || b.fill - a.fill || b.ts - a.ts);

  const tc = (k: string) => (PERK_NAME[k] ?? k).replace(/(^|\s)(\S)/g, (_m, a, b) => a + b.toUpperCase());
  const builds: BuildView[] = res.slice(0, 10).map((r) => {
    const pieces = r.pick.map((p) => ({
      p,
      sl: Object.keys(p.sl).flatMap((c) => Array.from({ length: p.sl[c] }, () => ({ c, cell: null as string | null }))),
    }));
    pieces.sort((a, b) => PART_ORDER.indexOf(a.p.part) - PART_ORDER.indexOf(b.p.part));
    const all = pieces.flatMap((x) => x.sl);
    const pend: string[] = [];
    for (const k of Object.keys(r.cells)) {
      for (let i = 0; i < r.cells[k]; i++) {
        const s = all.find((x) => !x.cell && x.c === PERK_CAT[k]);
        if (s) s.cell = k;
        else pend.push(k);
      }
    }
    for (const k of pend) {
      const s = all.find((x) => !x.cell && x.c === "prismatic");
      if (s) s.cell = k;
    }
    let fneed = fk && PERK_CAT[fk] && !(fk in tg) ? Math.ceil(Math.max(0, 6 - (r.pk[fk] ?? 0)) / pow) : 0;
    for (const x of all) {
      if (!x.cell && fneed > 0 && (x.c === PERK_CAT[fk] || x.c === "prismatic")) {
        x.cell = fk;
        fneed--;
      }
    }
    const tot: Record<string, number> = {};
    for (const k of Object.keys(r.pk)) if (r.pk[k]) tot[k] = r.pk[k];
    for (const x of all) if (x.cell) tot[x.cell] = (tot[x.cell] ?? 0) + pow;
    return {
      cost: r.cost,
      pieces: pieces.map((x) => ({
        part: x.p.part,
        name: x.p.name,
        perks: Object.keys(x.p.pk)
          .filter((k) => x.p.pk[k])
          .map((k) => `+${x.p.pk[k]} ${tc(k)}`)
          .join(", "),
        slots: x.sl.map((s) => ({ category: s.c, cell: s.cell ? `+${pow} ${tc(s.cell)} Cell` : null })),
      })),
      totals: Object.keys(tot)
        .sort((a, b) => Math.min(6, tot[b]) - Math.min(6, tot[a]) || a.localeCompare(b))
        .map((k) => ({ perk: tc(k), value: Math.min(6, tot[k]), desc: Math.min(6, tot[k]) >= 6 ? PERK_DESC[k] : undefined })),
    };
  });
  return { builds, found: res.length, stoppedEarly: count > LIMIT };
}
