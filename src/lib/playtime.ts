import { invoke } from "@tauri-apps/api/core";

// What GET /launcher/v1/playtime returns (the signed-in account only). Times are epoch ms or null.
export interface Playtime {
  playtimeSeconds: number;
  sessions: number;
  lastSessionStart: number | null;
  lastSessionEnd: number | null;
}

export function fetchPlaytime(): Promise<Playtime> {
  return invoke<Playtime>("native_get_playtime");
}

// Online hours only: these are the server's count.
export const BADGES = [
  { hours: 1, name: "Newcomer" },
  { hours: 10, name: "Rookie Hunter" },
  { hours: 25, name: "Tracker" },
  { hours: 50, name: "Slayer" },
  { hours: 100, name: "Veteran of the Shattered Isles" },
  { hours: 250, name: "Aether Master" },
  { hours: 500, name: "Legend of Ramsgate" },
  { hours: 750, name: "Behemoth Bane" },
  { hours: 1000, name: "Heroic" },
] as const;

export function unlockedBadges(seconds: number): number[] {
  return BADGES.filter((b) => seconds >= b.hours * 3600).map((b) => b.hours);
}

export function nextBadge(seconds: number): { hours: number; name: string; secondsToNext: number } | null {
  const next = BADGES.find((b) => seconds < b.hours * 3600);
  return next ? { hours: next.hours, name: next.name, secondsToNext: next.hours * 3600 - seconds } : null;
}

// 547200 -> "152 h 0 min", 2700 -> "45 min"
export function formatPlaytime(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

export function formatLastSession(start: number | null, end: number | null): string {
  if (start == null || end == null) return "None yet";
  const when = new Date(end).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return `${when} (${formatPlaytime(Math.max(0, Math.round((end - start) / 1000)))})`;
}
