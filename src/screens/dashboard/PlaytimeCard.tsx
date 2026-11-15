import { useEffect, useState } from "react";
import { BADGES, fetchPlaytime, formatLastSession, formatPlaytime, nextBadge, type Playtime } from "../../lib/playtime";

// Placeholder badge: a plain shield drawn in SVG with the hour mark, grey until unlocked.
function BadgeIcon({ hours, unlocked }: { hours: number; unlocked: boolean }) {
  return (
    <svg viewBox="0 0 48 56" width="44" height="52" aria-hidden="true">
      <path
        d="M24 3 43 10v17c0 13-8 22-19 26C13 49 5 40 5 27V10z"
        fill={unlocked ? "var(--color-accent-muted, #3b3566)" : "transparent"}
        stroke={unlocked ? "var(--color-accent-hover, #a99bff)" : "currentColor"}
        strokeWidth="2.5"
        opacity={unlocked ? 1 : 0.35}
      />
      <text x="24" y="33" textAnchor="middle" fontSize={hours >= 1000 ? 13 : 16} fontWeight="700" fill="currentColor" opacity={unlocked ? 1 : 0.5}>
        {hours}
      </text>
    </svg>
  );
}

export function PlaytimeCard() {
  const [data, setData] = useState<Playtime | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchPlaytime()
      .then((p) => !cancelled && setData(p))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, []);

  const seconds = data?.playtimeSeconds ?? 0;
  const next = data ? nextBadge(seconds) : null;
  const prevHours = [...BADGES].reverse().find((b) => seconds >= b.hours * 3600)?.hours ?? 0;
  const progress = next ? Math.min(100, ((seconds - prevHours * 3600) / (next.hours * 3600 - prevHours * 3600)) * 100) : 100;

  return (
    <div className="mt-6 overflow-hidden glass rounded-2xl">
      <div className="p-6">
        <p className="text-[13px] font-medium text-text">Playtime</p>
        {data ? (
          <>
            <p className="mt-2 text-[26px] font-semibold leading-none text-text">{formatPlaytime(seconds)}</p>
            <div className="mt-3 flex gap-8 text-xs text-text-muted">
              <span>Sessions: {data.sessions}</span>
              <span>Last session: {formatLastSession(data.lastSessionStart, data.lastSessionEnd)}</span>
            </div>
            <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-border">
              <div className="h-full rounded-full bg-accent" style={{ width: `${progress}%` }} />
            </div>
            <p className="mt-1.5 text-xs text-text-muted">
              {next ? `${formatPlaytime(Math.ceil(next.secondsToNext / 60) * 60)} to ${next.name}` : "Every badge unlocked."}
            </p>
          </>
        ) : (
          <p className="mt-2 text-xs text-text-muted">{failed ? "Playtime isn't available right now." : "Loading..."}</p>
        )}
      </div>

      <div className="border-t border-border p-6">
        <p className="text-xs text-text-muted">Badges count online hours only.</p>
        <div className="mt-3 grid grid-cols-3 gap-3">
          {BADGES.map((b) => {
            const unlocked = seconds >= b.hours * 3600;
            return (
              <div
                key={b.hours}
                title={`${b.name} (${b.hours} h)`}
                className={`flex flex-col items-center text-center ${unlocked ? "text-text" : "text-text-muted"}`}
              >
                <BadgeIcon hours={b.hours} unlocked={unlocked} />
                <span className="mt-1 text-[11px] leading-tight">{b.name}</span>
                <span className="text-[10px] opacity-70">{b.hours} h</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
