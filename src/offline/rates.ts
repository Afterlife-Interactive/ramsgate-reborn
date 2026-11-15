// RR-38 offline mode: the Offline rates sliders. Same ranges as the offline backend (RATE_LIMITS in
// the backend rates table) and the launcher's Rust side (src-tauri/src/offline/rates.rs); a test checks all
// three agree. The Rust side clamps again before it writes rates.json, and the backend clamps again when it reads it.
// These rates only ever apply to the offline servers on this PC.

export interface OfflineRates {
  xp: number;
  weaponXp: number;
  huntPassXp: number;
  coinChance: number;
  coinsPerRun: number;
  coinsFromAllEscalations: boolean;
  ramsPerGrant: number;
  bountyTokensPerDay: number;
  materials: number;
}

export type NumericRateKey = Exclude<keyof OfflineRates, "coinsFromAllEscalations">;

export interface RateLimit {
  min: number;
  max: number;
  integer?: boolean;
}

export const RATE_LIMITS: Record<NumericRateKey, RateLimit> = {
  xp: { min: 0.5, max: 10 },
  weaponXp: { min: 0.5, max: 10 },
  huntPassXp: { min: 0.5, max: 10 },
  coinChance: { min: 0, max: 1 },
  coinsPerRun: { min: 1, max: 10, integer: true },
  ramsPerGrant: { min: 0, max: 100000, integer: true },
  bountyTokensPerDay: { min: 0, max: 10, integer: true },
  materials: { min: 0.5, max: 10 },
};

export const OFFICIAL_RATES: Readonly<OfflineRates> = Object.freeze({
  xp: 1,
  weaponXp: 1,
  huntPassXp: 1,
  coinChance: 0.25,
  coinsPerRun: 1,
  coinsFromAllEscalations: false,
  ramsPerGrant: 5000,
  bountyTokensPerDay: 0,
  materials: 1,
});

export type PresetId = "1x" | "2x" | "5x";
export type PresetChoice = PresetId | "custom";

function scaled(factor: number): OfflineRates {
  return clampRates({
    xp: factor,
    weaponXp: factor,
    huntPassXp: factor,
    coinChance: OFFICIAL_RATES.coinChance * factor,
    coinsPerRun: OFFICIAL_RATES.coinsPerRun * factor,
    coinsFromAllEscalations: false,
    ramsPerGrant: OFFICIAL_RATES.ramsPerGrant * factor,
    bountyTokensPerDay: OFFICIAL_RATES.bountyTokensPerDay,
    materials: factor,
  });
}

export const PRESETS: Record<PresetId, Readonly<OfflineRates>> = {
  "1x": OFFICIAL_RATES,
  "2x": Object.freeze(scaled(2)),
  "5x": Object.freeze(scaled(5)),
};

export const PRESET_LABELS: Record<PresetChoice, string> = {
  "1x": "Official (1x)",
  "2x": "2x",
  "5x": "5x",
  custom: "Custom",
};

export function clampValue(key: NumericRateKey, value: number): number {
  const limit = RATE_LIMITS[key];
  if (!Number.isFinite(value)) return OFFICIAL_RATES[key];
  const v = Math.min(limit.max, Math.max(limit.min, value));
  return limit.integer ? Math.round(v) : Math.round(v * 100) / 100;
}

/** Every value inside its range, integers rounded, anything unusable replaced by the official value. */
export function clampRates(input: Partial<Record<keyof OfflineRates, unknown>>): OfflineRates {
  const out = { ...OFFICIAL_RATES } as OfflineRates;
  for (const key of Object.keys(RATE_LIMITS) as NumericRateKey[]) {
    const raw = input[key];
    out[key] = typeof raw === "number" ? clampValue(key, raw) : OFFICIAL_RATES[key];
  }
  out.coinsFromAllEscalations = input.coinsFromAllEscalations === true;
  return out;
}

/** Problems with a value as typed, before clamping (shown under the slider). Empty when everything is fine. */
export function validateRates(input: Partial<Record<keyof OfflineRates, unknown>>): Partial<Record<keyof OfflineRates, string>> {
  const errors: Partial<Record<keyof OfflineRates, string>> = {};
  for (const key of Object.keys(RATE_LIMITS) as NumericRateKey[]) {
    const raw = input[key];
    const limit = RATE_LIMITS[key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) errors[key] = "Enter a number.";
    else if (raw < limit.min || raw > limit.max) errors[key] = `Between ${limit.min} and ${limit.max}.`;
    else if (limit.integer && !Number.isInteger(raw)) errors[key] = "Whole numbers only.";
  }
  if (input.coinsFromAllEscalations !== undefined && typeof input.coinsFromAllEscalations !== "boolean") {
    errors.coinsFromAllEscalations = "On or off.";
  }
  return errors;
}

export function sameRates(a: OfflineRates, b: OfflineRates): boolean {
  return (Object.keys(OFFICIAL_RATES) as (keyof OfflineRates)[]).every((k) => a[k] === b[k]);
}

export function presetOf(rates: OfflineRates): PresetChoice {
  for (const id of Object.keys(PRESETS) as PresetId[]) if (sameRates(rates, PRESETS[id])) return id;
  return "custom";
}

export type RateKind = "multiplier" | "chance" | "count";

export interface RateField {
  key: NumericRateKey;
  label: string;
  help: string;
  kind: RateKind;
  step: number;
  /** Shown as "experimental" until the slider's in-game test passes (none has yet). */
  experimental: boolean;
}

export const RATE_FIELDS: readonly RateField[] = [
  { key: "xp", label: "XP", help: "Slayer and other progression XP.", kind: "multiplier", step: 0.25, experimental: true },
  { key: "weaponXp", label: "Weapon XP", help: "Weapon mastery XP. The weapon level cap still applies.", kind: "multiplier", step: 0.25, experimental: true },
  { key: "huntPassXp", label: "Hunt Pass XP", help: "Hunt Pass track XP, bounty XP included.", kind: "multiplier", step: 0.25, experimental: true },
  { key: "materials", label: "Materials", help: "Behemoth parts, gathered items, archonite, orbs and arcstones from hunts.", kind: "multiplier", step: 0.25, experimental: true },
  { key: "coinChance", label: "Coin chance", help: "Chance an escalation reward becomes coins.", kind: "chance", step: 0.05, experimental: true },
  { key: "coinsPerRun", label: "Coins per run", help: "Coins given when the coin roll succeeds.", kind: "count", step: 1, experimental: true },
  { key: "ramsPerGrant", label: "Rams per grant", help: "Rams given in place of other coin rewards.", kind: "count", step: 500, experimental: true },
  { key: "bountyTokensPerDay", label: "Bounty tokens per day", help: "Bounty draft tokens the board hands out each day.", kind: "count", step: 1, experimental: true },
];

/** The "Coins from all escalations" toggle; also experimental until tested in game. */
export const ALL_ESCALATIONS_EXPERIMENTAL = true;

export function formatRate(field: RateField, value: number): string {
  if (field.kind === "multiplier") return `${value.toFixed(2).replace(/\.?0+$/, "")}x`;
  if (field.kind === "chance") return `${Math.round(value * 100)}%`;
  return value.toLocaleString("en-US");
}
