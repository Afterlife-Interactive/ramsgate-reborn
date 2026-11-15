const STORAGE_KEY = "ramsgatereborn.deviceId";
// Earlier builds stored it under another key; carry the same id over so this device is not seen as new.
const LEGACY_STORAGE_KEY = "mysticparadox.deviceId";

/** A locally generated, persistent identifier sent with login/register — not a secret. */
export function getDeviceId(): string {
  const existing = localStorage.getItem(STORAGE_KEY);

  if (existing) {
    return existing;
  }

  const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
  const id = legacy ?? crypto.randomUUID();
  localStorage.setItem(STORAGE_KEY, id);
  if (legacy) {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  }

  return id;
}
