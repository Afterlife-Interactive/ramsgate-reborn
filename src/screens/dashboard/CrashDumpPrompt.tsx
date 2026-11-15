import { useState } from "react";
import { Button } from "../../components/Button";
import { answerCrashDump, type CrashDumpOffer } from "../../api/tauri";
import { formatBytes } from "../../ui/uninstall";

interface Props {
  offer: CrashDumpOffer;
  onClose: () => void;
}

// Asked once per crash while the Settings choice is "Ask me after a crash". The logs of the session have already
// been sent; this is only about the dump, which can't be cleaned of personal details the way the logs are.
export function CrashDumpPrompt({ offer, onClose }: Props) {
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState<"send" | "keep" | null>(null);
  const [failed, setFailed] = useState(false);

  const answer = async (send: boolean) => {
    setBusy(send ? "send" : "keep");
    setFailed(false);
    try {
      await answerCrashDump(send, remember);
      onClose();
    } catch {
      setFailed(true);
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 px-6" role="dialog" aria-modal="true" aria-labelledby="crash-dump-title">
      <div className="glass w-full max-w-[460px] rounded-2xl p-6">
        <h2 id="crash-dump-title" className="display text-[22px] leading-none text-text">Send the crash dump?</h2>
        <div className="mt-4 space-y-3 text-[13px] text-text-muted">
          <p>
            Dauntless crashed, and the game saved a crash dump ({formatBytes(offer.bytes)}). It is a snapshot of the game's
            memory at the moment it crashed, and it is the best way for us to find out what went wrong.
          </p>
          <p>
            Your logs were already sent, with your Windows user name and IP address taken out. We can't do that with a
            dump, so it may still hold things like your Windows user name, your account name or recent chat. Only the
            Ramsgate Reborn team can open it, and it is deleted after 3 days.
          </p>
          <label className="flex items-start gap-2 text-text">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="mt-0.5" />
            <span>Remember my answer (you can change it in Settings)</span>
          </label>
          {failed && <p className="text-danger">That didn't work. Try again, or choose Don't send.</p>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" className="w-auto px-4" disabled={busy !== null} loading={busy === "keep"} onClick={() => void answer(false)}>
            Don't send
          </Button>
          <Button className="w-auto px-4" disabled={busy !== null} loading={busy === "send"} onClick={() => void answer(true)}>
            Send it
          </Button>
        </div>
      </div>
    </div>
  );
}
