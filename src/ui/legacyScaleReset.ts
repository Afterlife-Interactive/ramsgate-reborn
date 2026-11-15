// The launcher used to have a UI scale setting. It is gone. This clears the value it stored so nobody stays stuck at
// an old scale: if one was stored, the caller puts the zoom and window size back to 100%.
export const LEGACY_SCALE_KEY = "rr-ui-scale";

export interface LegacyStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

/** Removes the old stored scale. Returns true when there was one (so the window needs putting back to normal). */
export function clearLegacyScale(storage: LegacyStorage | null | undefined): boolean {
  try {
    if (!storage || storage.getItem(LEGACY_SCALE_KEY) == null) return false;
    storage.removeItem(LEGACY_SCALE_KEY);
    return true;
  } catch {
    return false;
  }
}
