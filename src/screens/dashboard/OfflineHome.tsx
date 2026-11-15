// RR-38: the Play tab in offline mode, signed in. The offline panel itself has no online code; this wrapper (online half)
// hands it one function that downloads a read-only copy of the player's own save through the launcher's separate
// download command. Nothing is sent from offline mode, and the panel only ever imports the saved copy into the local save.
import { OfflinePanel, type OnlineSaveSource } from "../../offline/OfflinePanel";
import { downloadOnlineSave } from "../../api/onlineSave";

const onlineSave: OnlineSaveSource = { getSavedCopy: downloadOnlineSave };

export function OfflineHome() {
  return <OfflinePanel onlineSave={onlineSave} />;
}
