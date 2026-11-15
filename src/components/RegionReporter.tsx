import { useEffect } from "react";
import { refreshRegions } from "../api/region";

const REFRESH_MS = 10 * 60 * 1000;

// Invisible. Pings every region probe host the backend lists and reports the results; the backend then picks the
// region on its own. There is no menu and no setting: players never choose. Runs at mount, every 10 minutes and
// whenever the parent changes `pingKey` (HomeTab bumps it when Play is pressed). Errors are ignored on purpose.
export function RegionReporter({ pingKey = 0 }: { pingKey?: number }) {
  useEffect(() => {
    const run = () => void refreshRegions().catch(() => undefined);
    run();
    const timer = setInterval(run, REFRESH_MS);
    return () => clearInterval(timer);
  }, [pingKey]);
  return null;
}
