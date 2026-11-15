import { useState } from "react";
import { Button } from "../../components/Button";
import {
  categoryLabel,
  combine,
  MAX_TARGETS,
  PART_LABEL,
  perkList,
  WEAPONS,
  type CombineResult,
  type TargetInput,
} from "../../lib/combiner";

const STORE_KEY = "rr-planner";
const DEFAULT_TARGETS: TargetInput[] = [
  { perk: "Berserker", level: 6 },
  { perk: "Tough", level: 6 },
  { perk: "Sharpened", level: 3 },
];

interface Saved {
  targets: TargetInput[];
  filler: string;
  power: number;
  weapon: string;
}

// Older saves may carry a game version field and cells that do not exist in 1.12; the version is ignored and
// the unknown cells are dropped, so a saved build still opens.
function load(): Saved {
  const fallback: Saved = { targets: DEFAULT_TARGETS, filler: "Rage", power: 3, weapon: "" };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return fallback;
    const v = JSON.parse(raw) as Partial<Saved>;
    const list = perkList();
    const kept = Array.isArray(v.targets)
      ? v.targets.filter((t) => t && list.includes(t.perk) && Number.isFinite(Number(t.level))).map((t) => ({ perk: t.perk, level: Math.max(1, Math.min(6, Number(t.level))) })).slice(0, MAX_TARGETS)
      : [];
    return {
      targets: kept.length ? kept : fallback.targets,
      filler: typeof v.filler === "string" && (v.filler === "" || list.includes(v.filler)) ? v.filler : fallback.filler,
      power: [1, 2, 3].includes(Number(v.power)) ? Number(v.power) : 3,
      weapon: typeof v.weapon === "string" && WEAPONS.some((w) => w.name === v.weapon) ? v.weapon : "",
    };
  } catch {
    return fallback;
  }
}

const SLOT_COLOR: Record<string, string> = {
  power: "bg-red-500/70",
  technique: "bg-amber-500/70",
  defence: "bg-sky-500/70",
  mobility: "bg-emerald-500/70",
  utility: "bg-violet-500/70",
  prismatic: "bg-white/60",
};

const FIELD = "h-9 rounded-lg border border-border bg-black/30 px-2.5 text-[13px] text-text outline-none focus:border-glow";

export function BuildPlannerTab() {
  const [init] = useState(load);
  const [targets, setTargets] = useState<TargetInput[]>(init.targets);
  const [filler, setFiller] = useState(init.filler);
  const [power, setPower] = useState(init.power);
  const [weapon, setWeapon] = useState(init.weapon);
  const [result, setResult] = useState<CombineResult | null>(null);
  const [busy, setBusy] = useState(false);

  const save = (next: Partial<Saved>) => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ targets, filler, power, weapon, ...next }));
    } catch {
      // Storage unavailable: settings last until the launcher closes.
    }
  };
  const setT = (next: TargetInput[]) => {
    setTargets(next);
    save({ targets: next });
  };
  const perks = perkList();
  const run = () => {
    setBusy(true);
    setResult(null);
    // Let the "Searching" state paint before the search blocks the thread.
    setTimeout(() => {
      setResult(combine(targets, { filler, power, weapon }));
      setBusy(false);
    }, 30);
  };

  return (
    <div className="max-w-[860px] px-12 pb-6 pt-4">
      <h1 className="display text-[30px] leading-none text-text">Build planner</h1>
      <p className="mt-1 text-[13px] text-text-muted">Pick the perks and levels you want. It finds the gear that needs the fewest cells.</p>

      <section className="glass mt-6 rounded-2xl p-5">
        <p className="text-[13px] font-medium text-text">Target perks</p>
        <div className="mt-3 space-y-2">
          {targets.map((t, i) => (
            <div key={i} className="flex items-center gap-2">
              <select
                aria-label="Perk"
                className={`${FIELD} w-56`}
                value={t.perk}
                onChange={(e) => setT(targets.map((x, j) => (j === i ? { ...x, perk: e.target.value } : x)))}
              >
                {perks.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
              <select
                aria-label="Level"
                className={`${FIELD} w-20`}
                value={t.level}
                onChange={(e) => setT(targets.map((x, j) => (j === i ? { ...x, level: Number(e.target.value) } : x)))}
              >
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
              <button
                onClick={() => setT(targets.filter((_, j) => j !== i))}
                className="h-9 rounded-lg px-3 text-[13px] text-text-muted hover:bg-white/8 hover:text-text"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        {targets.length < MAX_TARGETS && (
          <button
            onClick={() => setT([...targets, { perk: perks[0], level: 3 }])}
            className="mt-3 h-9 rounded-lg px-3 text-[13px] text-accent-hover hover:bg-white/8"
          >
            + Add perk
          </button>
        )}

        <div className="mt-5 grid grid-cols-2 gap-4 border-t border-border pt-4">
          <label className="block text-[12px] text-text-muted">
            Filler perk for spare slots
            <select
              className={`${FIELD} mt-1 w-full`}
              value={filler}
              onChange={(e) => {
                setFiller(e.target.value);
                save({ filler: e.target.value });
              }}
            >
              <option value="">None</option>
              {perks.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <label className="block text-[12px] text-text-muted">
            Cell strength
            <select
              className={`${FIELD} mt-1 w-full`}
              value={power}
              onChange={(e) => {
                setPower(Number(e.target.value));
                save({ power: Number(e.target.value) });
              }}
            >
              {[1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  +{n}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-[12px] text-text-muted">
            Weapon
            <select
              className={`${FIELD} mt-1 w-full`}
              value={weapon}
              onChange={(e) => {
                setWeapon(e.target.value);
                save({ weapon: e.target.value });
              }}
            >
              <option value="">Any weapon</option>
              {WEAPONS.map((w) => (
                <option key={w.name} value={w.name}>
                  [{w.type}] {w.name}{w.legendary ? " (Legendary)" : ""}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-5">
          <Button onClick={run} disabled={busy || targets.length === 0}>
            {busy ? "Searching…" : "Find builds"}
          </Button>
        </div>
      </section>

      {result && result.builds.length === 0 && (
        <p className="glass mt-4 rounded-2xl p-4 text-[13px] text-danger">
          No combination reaches those targets with the gear available. Lower a level or drop a perk.
        </p>
      )}

      {result && result.builds.length > 0 && (
        <p className="mt-5 text-[13px] text-text-muted">
          {result.found} working build{result.found > 1 ? "s" : ""}{result.stoppedEarly ? " (search stopped early)" : ""}, fewest cells first. Showing the best{" "}
          {result.builds.length}.
        </p>
      )}

      {result?.builds.map((b, bi) => (
        <div key={bi} className="glass mt-3 overflow-hidden rounded-2xl">
          <div className="flex items-baseline justify-between bg-black/30 px-4 py-2.5">
            <span className="text-[14px] font-semibold text-text">Build {bi + 1}</span>
            <span className="text-[12px] text-text-muted">
              {b.cost} cell{b.cost === 1 ? "" : "s"} needed
            </span>
          </div>
          <div className="grid grid-cols-[2fr_1fr] gap-4 p-4">
            <div className="space-y-2">
              {b.pieces.map((p, pi) => (
                <div key={pi} className="rounded-xl border border-border bg-black/20 px-3 py-2.5">
                  <p className="text-[11px] uppercase tracking-wide text-text-faint">{PART_LABEL[p.part] ?? p.part}</p>
                  <p className="text-[14px] font-medium text-text">{p.name}</p>
                  {p.perks && <p className="text-[12px] text-text-muted">Perks: {p.perks}</p>}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {p.slots.map((s, si) => (
                      <span
                        key={si}
                        className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] ${
                          s.cell ? "bg-white/10 text-text" : "border border-dashed border-border-strong text-text-faint"
                        }`}
                      >
                        <span className={`h-2.5 w-2.5 rounded-full ${SLOT_COLOR[s.category] ?? "bg-white/40"} ${s.cell ? "" : "opacity-50"}`} />
                        {s.cell ?? `Empty ${categoryLabel(s.category)} slot`}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="space-y-2 self-start">
              <p className="text-center text-[11px] font-semibold uppercase tracking-[0.16em] text-text-faint">Perks</p>
              {b.totals.map((t) => (
                <div
                  key={t.perk}
                  className={`rounded-xl border px-3 py-2 text-center ${t.value >= 6 ? "border-glow/60 bg-accent/30" : "border-border bg-black/20"}`}
                >
                  <p className="text-[13px] font-semibold text-text">
                    +{t.value} {t.perk}
                  </p>
                  {t.desc && <p className="mt-0.5 text-[11px] text-text-muted">{t.desc}</p>}
                </div>
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
