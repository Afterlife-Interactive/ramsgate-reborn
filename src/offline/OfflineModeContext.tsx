// RR-38 offline mode: which half of the launcher is showing (Online | Offline). Stored by the native side in the
// launcher's config folder; switching to Offline the first time needs the one-way notice accepted.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { acceptNotice, getMode, setMode as setNativeMode, type LauncherMode, type ModeState } from "./api";

interface OfflineModeValue {
  mode: LauncherMode;
  noticeAccepted: boolean;
  /** True while the first-time notice is open (asked for by switching to Offline). */
  noticeOpen: boolean;
  requestMode: (mode: LauncherMode) => void;
  confirmNotice: () => Promise<void>;
  cancelNotice: () => void;
}

const OfflineModeContext = createContext<OfflineModeValue | null>(null);

export function OfflineModeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ModeState>({ mode: "online", noticeAccepted: false });
  const [noticeOpen, setNoticeOpen] = useState(false);

  useEffect(() => {
    getMode().then(setState).catch(() => {});
  }, []);

  const requestMode = useCallback(
    (mode: LauncherMode) => {
      if (mode === "offline" && !state.noticeAccepted) {
        setNoticeOpen(true);
        return;
      }
      setState((s) => ({ ...s, mode }));
      void setNativeMode(mode).then(setState).catch(() => {});
    },
    [state.noticeAccepted],
  );

  const confirmNotice = useCallback(async () => {
    const accepted = await acceptNotice();
    const next = await setNativeMode("offline").catch(() => ({ ...accepted, mode: "offline" as const }));
    setState(next);
    setNoticeOpen(false);
  }, []);

  const cancelNotice = useCallback(() => setNoticeOpen(false), []);

  const value = useMemo(
    () => ({ mode: state.mode, noticeAccepted: state.noticeAccepted, noticeOpen, requestMode, confirmNotice, cancelNotice }),
    [state, noticeOpen, requestMode, confirmNotice, cancelNotice],
  );
  return <OfflineModeContext.Provider value={value}>{children}</OfflineModeContext.Provider>;
}

export function useOfflineMode(): OfflineModeValue {
  const v = useContext(OfflineModeContext);
  if (!v) throw new Error("useOfflineMode outside OfflineModeProvider");
  return v;
}
