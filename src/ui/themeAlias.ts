// Theme ids that were renamed. A saved old id still loads, so nobody's choice is lost: launchers up to 0.2.41 stored
// the Sahvyt theme as "shavyt".
const RENAMED_THEMES = new Map<string, string>([["shavyt", "sahvyt"]]);

/** The current id for a saved theme id, or undefined when the saved id was never renamed. */
export function renamedThemeId(stored: string | null): string | undefined {
  return stored === null ? undefined : RENAMED_THEMES.get(stored);
}
