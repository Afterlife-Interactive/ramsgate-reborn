// RR-38 offline mode: the "Offline rates" section of the Settings tab (offline mode only). Writes rates.json on this
// PC through offline_save_rates (validated and written atomically by the native side). Only the offline servers on this
// PC read it.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../components/Button";
import { sanitizeError } from "../lib/sanitize";
import { applyRatesNow, getRates, openOfflineLogFolder, resetRates, saveRates } from "./api";
import {
  ALL_ESCALATIONS_EXPERIMENTAL,
  OFFICIAL_RATES,
  PRESET_LABELS,
  PRESETS,
  RATE_FIELDS,
  RATE_LIMITS,
  clampRates,
  clampValue,
  formatRate,
  presetOf,
  sameRates,
  type OfflineRates,
  type PresetChoice,
  type PresetId,
} from "./rates";

function Experimental() {
  return (
    <span className="ml-2 rounded-sm border border-border-strong px-1.5 py-px text-[9px] font-bold uppercase tracking-[0.14em] text-text-faint" title="Not yet confirmed in game">
      experimental
    </span>
  );
}

export function OfflineRatesSection() {
  const [saved, setSaved] = useState<OfflineRates | null>(null);
  const [draft, setDraft] = useState<OfflineRates>({ ...OFFICIAL_RATES });
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    getRates()
      .then((v) => {
        setSaved(v.rates);
        setDraft(v.rates);
        if (v.warnings.length) setMessage({ kind: "error", text: `rates.json had problems and was read with corrections: ${v.warnings.join("; ")}` });
      })
      .catch((err) => setMessage({ kind: "error", text: sanitizeError(String(err)) }));
  }, []);

  const preset: PresetChoice = useMemo(() => presetOf(draft), [draft]);
  const dirty = saved !== null && !sameRates(saved, draft);

  const act = useCallback(async (fn: () => Promise<string>) => {
    setWorking(true);
    setMessage(null);
    try {
      setMessage({ kind: "ok", text: await fn() });
    } catch (err) {
      setMessage({ kind: "error", text: sanitizeError(typeof err === "string" ? err : err instanceof Error ? err.message : undefined) });
    } finally {
      setWorking(false);
    }
  }, []);

  const save = () =>
    act(async () => {
      const v = await saveRates(clampRates(draft));
      setSaved(v.rates);
      setDraft(v.rates);
      return "Saved. The offline servers pick this up within a few seconds; hunts started from now on use it.";
    });

  return (
    <section className="mt-7 overflow-hidden rounded-sm border border-border bg-surface">
      <div className="border-b border-border px-6 py-4">
        <p className="text-[13px] font-medium text-text">
          Offline rates <Experimental />
        </p>
        <p className="mt-0.5 text-xs text-text-muted">
          Only for offline play on this PC. Online rates can't be changed from here. Each slider stays experimental until it has
          been checked in game.
        </p>
      </div>

      <div className="px-6 py-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-faint">Preset</p>
        <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="Rates preset">
          {(["1x", "2x", "5x", "custom"] as PresetChoice[]).map((p) => (
            <button
              key={p}
              role="radio"
              aria-checked={preset === p}
              disabled={p === "custom"}
              onClick={() => p !== "custom" && setDraft({ ...PRESETS[p as PresetId] })}
              className={`rounded-md border px-3 py-1.5 text-[12px] font-semibold transition-colors ${
                preset === p ? "border-accent bg-accent text-on-ink" : "border-border-strong text-text hover:border-accent"
              } disabled:cursor-default`}
            >
              {PRESET_LABELS[p]}
            </button>
          ))}
        </div>

        <div className="mt-5 space-y-4">
          {RATE_FIELDS.map((f) => {
            const limit = RATE_LIMITS[f.key];
            const value = draft[f.key];
            return (
              <div key={f.key}>
                <div className="flex items-baseline justify-between gap-3">
                  <label htmlFor={`rate-${f.key}`} className="text-[13px] font-medium text-text">
                    {f.label}
                    {f.experimental && <Experimental />}
                  </label>
                  <span className="font-mono text-[12px] tabular-nums text-text">{formatRate(f, value)}</span>
                </div>
                <input
                  id={`rate-${f.key}`}
                  type="range"
                  min={limit.min}
                  max={limit.max}
                  step={f.step}
                  value={value}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: clampValue(f.key, Number(e.target.value)) }))}
                  className="mt-1 w-full accent-[var(--color-accent)]"
                />
                <p className="text-[11px] text-text-faint">
                  {f.help} Official: {formatRate(f, OFFICIAL_RATES[f.key])}. Range {formatRate(f, limit.min)} to {formatRate(f, limit.max)}.
                </p>
              </div>
            );
          })}
          <label className="flex items-center gap-2 text-[13px] text-text">
            <input
              type="checkbox"
              checked={draft.coinsFromAllEscalations}
              onChange={(e) => setDraft((d) => ({ ...d, coinsFromAllEscalations: e.target.checked }))}
            />
            Coins from all escalations (not only 10-50)
            {ALL_ESCALATIONS_EXPERIMENTAL && <Experimental />}
          </label>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button className="w-auto px-4" onClick={() => void save()} disabled={working || !dirty}>
            Save
          </Button>
          <Button
            variant="secondary"
            className="w-auto px-4"
            disabled={working}
            onClick={() =>
              void act(async () => {
                const v = await resetRates();
                setSaved(v.rates);
                setDraft(v.rates);
                return "Back to official rates.";
              })
            }
          >
            Reset
          </Button>
          <Button
            variant="secondary"
            className="w-auto px-4"
            disabled={working}
            onClick={() =>
              void act(async () => {
                if (dirty) {
                  const v = await saveRates(clampRates(draft));
                  setSaved(v.rates);
                  setDraft(v.rates);
                }
                const r = await applyRatesNow();
                if (r.applied) return "Applied: the offline hub was restarted with these rates.";
                if (r.reason === "client-running") return "Saved. Close the offline game to restart the hub; new hunts already use these rates.";
                return "Saved. The offline servers are not running; they use these rates when they start.";
              })
            }
          >
            Apply now
          </Button>
        </div>
        {message && <p className={`mt-3 text-[13px] ${message.kind === "ok" ? "text-online" : "text-danger"}`}>{message.text}</p>}
      </div>

      <div className="border-t border-border px-6 py-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-faint">Offline logs</p>
        <p className="mt-1 text-[13px] text-text-muted">Offline logs stay on this PC and are never sent anywhere.</p>
        <Button variant="secondary" className="mt-3 w-auto px-4" onClick={() => void openOfflineLogFolder().catch(() => {})}>
          Open offline log folder
        </Button>
      </div>
    </section>
  );
}
