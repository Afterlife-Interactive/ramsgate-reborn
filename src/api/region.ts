import { invoke } from "@tauri-apps/api/core";

// Region selection. The native side asks the backend for the region list, pings each region and reports the
// results; when the backend has region selection off it answers enabled:false and nothing is shown.

export interface RegionEntry {
  id: string;
  label: string;
  qosUrl: string | null;
  free: number;
  cap: number;
}

export type RegionPref = { mode: "auto" } | { mode: "manual"; region: string };

export interface RegionRefresh {
  enabled: boolean;
  info: { enabled: boolean; ceilingMs?: number; regions?: RegionEntry[]; pref?: RegionPref };
  pings: Record<string, number>;
}

export function refreshRegions(): Promise<RegionRefresh> {
  return invoke<RegionRefresh>("native_region_refresh");
}
