import { useCallback, useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { Banner } from "../../components/Banner";
import type { AdminAccount } from "../../api/admin";
import {
  deletePlayer,
  getInventory,
  getTracks,
  grantPreset,
  maxPlayer,
  setAccountStatus,
  setCurrency,
  setTrack,
  type OwnedItem,
  type TrackInfo,
} from "../../api/adminGrants";

type Section = "quick" | "inventory" | "levels" | "currency" | "account";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "quick", label: "Quick actions" },
  { id: "inventory", label: "Inventory" },
  { id: "levels", label: "Levels" },
  { id: "currency", label: "Currency" },
  { id: "account", label: "Account" },
];

const INPUT = "w-full glass rounded-2xl-raised px-3 py-2 text-sm text-text";

function errorText(error: unknown): string {
  return typeof error === "string" ? error : error instanceof Error ? error.message : "Something went wrong.";
}

function trackLabel(id: string): string {
  const parts = id.split("_");
  const kind = parts[0] === "MasteryTrack" ? "mastery" : "level";
  const what = parts.slice(1).join(" ").replace("ChainBlades", "Chain Blades").replace("PlayerLevel", "Player").replace("Weapon ", "");
  return `${what || "Player"} ${kind}`;
}

export function PlayerTools({ player }: { player: AdminAccount }) {
  const [section, setSection] = useState<Section>("quick");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [items, setItems] = useState<OwnedItem[]>([]);
  const [currencies, setCurrencies] = useState<OwnedItem[]>([]);
  const [filter, setFilter] = useState("");
  const [tracks, setTracks] = useState<TrackInfo[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [currencyId, setCurrencyId] = useState("CURRENCY_NOTES");
  const [currencyAmount, setCurrencyAmount] = useState("0");
  const [deleteText, setDeleteText] = useState("");
  const [deleteReason, setDeleteReason] = useState("");

  async function run(task: () => Promise<string | void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const message = await task();
      if (message) setNotice(message);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const loadInventory = useCallback(async () => {
    const result = await getInventory(player.userId);
    setItems(result.items);
    setCurrencies(result.currencies);
  }, [player.userId]);

  const loadTracks = useCallback(async () => {
    setTracks(await getTracks(player.userId));
    setEdits({});
  }, [player.userId]);

  useEffect(() => {
    setNotice(null);
    setError(null);
    if (section === "inventory" || section === "currency") loadInventory().catch((err) => setError(errorText(err)));
    if (section === "levels") loadTracks().catch((err) => setError(errorText(err)));
  }, [section, player.userId, loadInventory, loadTracks]);

  function doMax() {
    if (!window.confirm(`Max out ${player.displayName}? This gives all gear, +3 cells, materials, max levels and Slayer's Path. The player should be offline.`)) return;
    run(async () => {
      try {
        await maxPlayer(player.userId);
      } catch (err) {
        if (!errorText(err).includes("online")) throw err;
        if (!window.confirm(`${player.displayName} is online. Run it anyway?`)) return;
        await maxPlayer(player.userId, true);
      }
      return `${player.displayName} is maxed. They need to relaunch the game to see it.`;
    });
  }

  function doPreset(preset: "gear" | "cells" | "materials", label: string) {
    run(async () => {
      const result = await grantPreset(player.userId, preset);
      return `${label}: ${result.granted} entries granted to ${player.displayName}.`;
    });
  }

  const shown = items.filter((item) => !filter || item.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="mt-6 border-t border-border pt-4">
      <h3 className="text-[13px] font-semibold text-text">Tools for {player.displayName}</h3>
      <div className="mt-2 flex flex-wrap gap-1 rounded-lg border border-border bg-surface-raised p-1" role="tablist">
        {SECTIONS.map(({ id, label }) => (
          <button
            key={id}
            role="tab"
            aria-selected={section === id}
            onClick={() => setSection(id)}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${section === id ? "bg-accent-muted text-text" : "text-text-muted hover:text-text"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {error && <div className="mt-3"><Banner>{error}</Banner></div>}
      {notice && <div className="mt-3"><Banner tone="muted">{notice}</Banner></div>}

      {section === "quick" && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={doMax} disabled={busy}>Max account + Slayer's Path</Button>
          <Button variant="secondary" onClick={() => doPreset("gear", "All gear")} disabled={busy}>All gear</Button>
          <Button variant="secondary" onClick={() => doPreset("cells", "All +3 cells x5")} disabled={busy}>All +3 cells x5</Button>
          <Button variant="secondary" onClick={() => doPreset("materials", "Materials x5000")} disabled={busy}>Materials x5000</Button>
        </div>
      )}

      {section === "inventory" && (
        <div className="mt-3">
          <input className={INPUT} placeholder="Filter by name" value={filter} onChange={(event) => setFilter(event.target.value)} />
          <ul className="mt-1 max-h-64 divide-y divide-border overflow-y-auto rounded-md border border-border">
            {shown.length === 0 && <li className="px-3 py-2 text-xs text-text-muted">Nothing found.</li>}
            {shown.map((item) => (
              <li key={item.catalogId} className="flex justify-between px-3 py-1.5 text-xs text-text">
                <span>{item.name}</span>
                <span className="text-text-muted">x{item.quantity.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {section === "levels" && (
        <ul className="mt-3 divide-y divide-border rounded-md border border-border">
          {tracks.map((track) => (
            <li key={track.progressionId} className="flex items-center gap-3 px-3 py-1.5 text-xs text-text">
              <span className="w-44">{trackLabel(track.progressionId)}</span>
              <span className="w-32 text-text-muted">{track.progress.toLocaleString()} / {track.max.toLocaleString()}</span>
              <input
                className="w-28 glass rounded-2xl-raised px-2 py-1 text-xs text-text"
                type="number"
                min={0}
                max={track.max}
                placeholder="Set to"
                value={edits[track.progressionId] ?? ""}
                onChange={(event) => setEdits((current) => ({ ...current, [track.progressionId]: event.target.value }))}
              />
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || (edits[track.progressionId] ?? "") === ""}
                onClick={() => run(async () => { await setTrack(player.userId, track.progressionId, Number(edits[track.progressionId])); await loadTracks(); return "Saved. The player must relaunch to see it."; })}
              >
                Set
              </Button>
              <button className="text-text-muted hover:text-text" onClick={() => setEdits((current) => ({ ...current, [track.progressionId]: String(track.max) }))}>Max</button>
              <button className="text-text-muted hover:text-text" onClick={() => setEdits((current) => ({ ...current, [track.progressionId]: "0" }))}>Reset</button>
            </li>
          ))}
        </ul>
      )}

      {section === "currency" && (
        <div className="mt-3">
          <ul className="divide-y divide-border rounded-md border border-border">
            {currencies.length === 0 && <li className="px-3 py-2 text-xs text-text-muted">No currency balances.</li>}
            {currencies.map((currency) => (
              <li key={currency.catalogId}>
                <button className="flex w-full justify-between px-3 py-1.5 text-left text-xs text-text hover:bg-surface-raised" onClick={() => { setCurrencyId(currency.catalogId); setCurrencyAmount(String(currency.quantity)); }}>
                  <span>{currency.name}</span>
                  <span className="text-text-muted">{currency.quantity.toLocaleString()}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-text-muted">Click a balance to edit it, then set the exact amount. For a currency they do not have yet, grant it from the list above first.</p>
          <div className="mt-2 flex items-center gap-2">
            <span className="text-xs text-text">{currencies.find((currency) => currency.catalogId === currencyId)?.name ?? currencyId}</span>
            <input className={`${INPUT} w-40`} type="number" min={0} value={currencyAmount} onChange={(event) => setCurrencyAmount(event.target.value)} />
            <Button size="sm" disabled={busy} onClick={() => run(async () => { await setCurrency(player.userId, currencyId, Math.trunc(Number(currencyAmount))); await loadInventory(); return "Balance set."; })}>Set exactly</Button>
          </div>
        </div>
      )}

      {section === "account" && (
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => run(async () => { await setAccountStatus(player.userId, "active"); return "Account active."; })}>Activate</Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => run(async () => { await setAccountStatus(player.userId, "disabled"); return "Account disabled; they are signed out."; })}>Disable</Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => { if (window.confirm(`Ban ${player.displayName}?`)) run(async () => { await setAccountStatus(player.userId, "banned"); return "Account banned; they are signed out."; }); }}>Ban</Button>
          </div>
          <div className="rounded-md border border-danger/30 p-3">
            <p className="text-xs text-danger">Permanently delete this player and their data. Type DELETE {player.displayName} to confirm.</p>
            <input className={`${INPUT} mt-2`} placeholder={`DELETE ${player.displayName}`} value={deleteText} onChange={(event) => setDeleteText(event.target.value)} />
            <input className={`${INPUT} mt-2`} placeholder="Reason (for the audit log)" value={deleteReason} onChange={(event) => setDeleteReason(event.target.value)} />
            <div className="mt-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={busy || deleteText !== `DELETE ${player.displayName}` || deleteReason.trim().length < 3}
                onClick={() => run(async () => { await deletePlayer(player.userId, deleteText, deleteReason.trim()); return `${player.displayName} was deleted.`; })}
              >
                Delete player
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
