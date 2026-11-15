import { useCallback, useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { Banner } from "../../components/Banner";
import { listAudit, listOnline, type AuditRecord } from "../../api/adminGrants";

function errorText(error: unknown): string {
  return typeof error === "string" ? error : error instanceof Error ? error.message : "Something went wrong.";
}

const ACTION_LABELS: Record<string, string> = {
  "player.grant": "Granted items",
  "player.max": "Maxed account",
  "player.currency.set": "Set a currency",
  "player.track.set": "Set a level",
  "player.access.update": "Changed access",
  "player.account.delete": "Deleted player",
};

export function OnlinePlayers() {
  const [players, setPlayers] = useState<{ userId: string; displayName: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    listOnline().then((result) => { setPlayers(result); setError(null); }).catch((err) => setError(errorText(err)));
  }, []);
  useEffect(() => {
    load();
    const timer = setInterval(load, 30000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <section className="glass rounded-2xl p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold text-text">Online now{players ? ` (${players.length})` : ""}</h2>
        <Button variant="secondary" size="sm" onClick={load}>Refresh</Button>
      </div>
      {error && <div className="mt-3"><Banner>{error}</Banner></div>}
      <p className="mt-2 text-xs text-text-muted">
        {players === null ? "Loading..." : players.length === 0 ? "Nobody is online." : players.map((player) => player.displayName).join(", ")}
      </p>
    </section>
  );
}

export function AuditLog() {
  const [records, setRecords] = useState<AuditRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    listAudit().then((result) => { setRecords(result); setError(null); }).catch((err) => setError(errorText(err)));
  }, []);
  useEffect(load, [load]);

  return (
    <section className="glass rounded-2xl p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold text-text">Admin activity</h2>
        <Button variant="secondary" size="sm" onClick={load}>Refresh</Button>
      </div>
      {error && <div className="mt-3"><Banner>{error}</Banner></div>}
      <ul className="mt-3 max-h-72 divide-y divide-border overflow-y-auto rounded-md border border-border">
        {records.length === 0 && <li className="px-3 py-2 text-xs text-text-muted">No activity yet.</li>}
        {records.map((record) => (
          <li key={record.id} className="px-3 py-1.5 text-xs text-text">
            <span className="text-text-muted">{new Date(record.createdAt).toLocaleString()}</span>{" "}
            {record.actorName || "?"}: {ACTION_LABELS[record.action] ?? record.action}
            {record.targetName ? ` (${record.targetName})` : ""}
          </li>
        ))}
      </ul>
    </section>
  );
}
