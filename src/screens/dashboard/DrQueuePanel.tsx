import { useCallback, useEffect, useRef, useState } from "react";
import { drChoiceDecide, drQueueJoin, drQueueLeave, drQueueStatus } from "../../api/tauri";
import { DR_FLOW_START, DR_TEXT, stepFlow, type DrChoiceAnswer, type DrFlow, type DrFlowAction } from "../../lib/drChoice";
import { QUEUE_TEXT, buttonsFor, heartbeatPlan, isInLine, queueViewFor, type DrQueueAnswer, type DrQueueView } from "../../lib/drQueue";

const button = "rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-[14px] font-medium text-text transition-colors enabled:hover:bg-white/10 disabled:opacity-50";

/**
 * The line for a Dauntless Revived copy that is not here yet. It sits on the home tab and does not block anything:
 * the player can use the launcher and play while waiting. The status call is also the heartbeat.
 * Nothing is sent on its own except that status call. Joining, leaving and starting fresh each need a click
 * (starting fresh goes through the same two-step confirm and the same decision call as the choice screen).
 */
export function DrQueuePanel({
  notCopiedText,
  onReady,
  onAnswer,
}: {
  /** The text the home tab already has for "not copied yet", shown until the line answers. */
  notCopiedText: string;
  /** The copy is here: the home tab asks again and the choice screen opens. */
  onReady: () => void;
  /** The server settled the question some other way (declined, moved, played, ended). */
  onAnswer: (answer: DrChoiceAnswer) => void;
}) {
  const [view, setView] = useState<DrQueueView | null>(null);
  const [busy, setBusy] = useState(false);
  const [noUpdate, setNoUpdate] = useState(false);
  const [flow, setFlow] = useState<DrFlow | null>(null);
  const flowRef = useRef<DrFlow | null>(null);

  const mountedRef = useRef(true);
  const viewRef = useRef<DrQueueView | null>(null);
  const leftRef = useRef(false);
  const failuresRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const stoppedRef = useRef(false);
  const hiddenSinceRef = useRef<number | null>(null);
  const onReadyRef = useRef(onReady);
  const onAnswerRef = useRef(onAnswer);
  onReadyRef.current = onReady;
  onAnswerRef.current = onAnswer;

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const plan = () => {
    const current = viewRef.current;
    return heartbeatPlan({
      inLine: current !== null && isInLine(current),
      retryAfterSeconds: current !== null && isInLine(current) ? current.retryAfterSeconds : null,
      failures: failuresRef.current,
      hiddenForMs: hiddenSinceRef.current === null ? null : Date.now() - hiddenSinceRef.current,
      left: leftRef.current || !mountedRef.current,
    });
  };

  const showAnswer = useCallback((answer: DrQueueAnswer) => {
    if (!mountedRef.current) return;
    const next = queueViewFor(answer);
    // A "try again later" answer while in line changes nothing: the place is kept, the heartbeat just backs off.
    if (next.kind === "try_later" && viewRef.current !== null && isInLine(viewRef.current)) {
      failuresRef.current += 1;
      setNoUpdate(true);
      return;
    }
    failuresRef.current = 0;
    setNoUpdate(false);
    if (isInLine(next)) leftRef.current = false;
    viewRef.current = next;
    setView(next);
    if (next.kind === "ready") {
      leftRef.current = true;
      onReadyRef.current();
    } else if (next.kind === "decided" || next.kind === "ended") {
      leftRef.current = true;
      onAnswerRef.current({ state: answer.state, text: answer.text });
    }
  }, []);

  const check = useCallback((): Promise<void> => {
    return drQueueStatus().then(showAnswer, () => {
      if (!mountedRef.current) return;
      failuresRef.current += 1;
      if (viewRef.current !== null && isInLine(viewRef.current)) setNoUpdate(true);
      else {
        const v = queueViewFor({ state: "dr_try_again_later" });
        viewRef.current = v;
        setView(v);
      }
    });
  }, [showAnswer]);

  const schedule = useCallback(() => {
    clearTimer();
    const p = plan();
    if (!p.run) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const again = plan();
      if (!again.run) {
        // Hidden for a long time (or left): stop quietly. It asks again when the window comes back.
        stoppedRef.current = true;
        return;
      }
      void check().finally(schedule);
    }, p.delayMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [check]);

  useEffect(() => {
    mountedRef.current = true;
    leftRef.current = false;
    void check().finally(schedule);
    const onVisibility = () => {
      if (document.hidden) {
        hiddenSinceRef.current = Date.now();
        return;
      }
      hiddenSinceRef.current = null;
      if (stoppedRef.current && viewRef.current !== null && isInLine(viewRef.current) && !leftRef.current) {
        stoppedRef.current = false;
        void check().finally(schedule);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      mountedRef.current = false;
      leftRef.current = true;
      clearTimer();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [check, schedule]);

  const run = (call: () => Promise<DrQueueAnswer>) => {
    setBusy(true);
    call()
      .then(showAnswer, () => {
        if (!mountedRef.current) return;
        const v = queueViewFor({ state: "dr_try_again_later" });
        // A failed leave leaves the player in line: keep the heartbeat going.
        if (viewRef.current === null || !isInLine(viewRef.current)) {
          viewRef.current = v;
          setView(v);
        } else {
          leftRef.current = false;
          setNoUpdate(true);
        }
      })
      .finally(() => {
        if (mountedRef.current) setBusy(false);
        schedule();
      });
  };

  const onJoin = () => run(() => drQueueJoin());
  const onLeave = () => {
    // One click is enough. The heartbeat stops first so it cannot put the player back.
    leftRef.current = true;
    clearTimer();
    run(() => drQueueLeave());
  };

  // Start fresh: the same two-step confirm and the same decision call as the choice screen. Nothing is chosen for the player.
  const dispatch = (action: DrFlowAction) => {
    const current = flowRef.current ?? DR_FLOW_START;
    const { flow: next, send } = stepFlow(current, action);
    flowRef.current = next;
    setFlow(next);
    if (!send) return;
    drChoiceDecide(send.choice).then(
      (reply) => {
        if (!mountedRef.current) return;
        if (reply.state === "dr_try_again_later") dispatch({ type: "sent_failed" });
        else onAnswerRef.current(reply);
      },
      () => dispatch({ type: "sent_failed" }),
    );
  };
  const closeFlow = () => {
    flowRef.current = null;
    setFlow(null);
  };

  const buttons = view ? buttonsFor(view) : null;
  if (view?.kind === "none" || view?.kind === "ready") return null;

  const frame = "max-w-[44ch] rounded-2xl border border-white/10 bg-white/5 p-4 text-[13px] leading-relaxed text-text-muted";

  if (view === null) {
    return (
      <div className="max-w-[44ch] text-[13px] text-text-muted">
        <p>{notCopiedText}</p>
      </div>
    );
  }

  // Step 2 of "Start fresh".
  if (flow && flow.step !== "choose") {
    return (
      <div className={frame} role="group" aria-labelledby="dr-queue-fresh-title">
        <p id="dr-queue-fresh-title" className="font-semibold text-text">{DR_TEXT.confirmFreshTitle}</p>
        <p className="mt-2">{DR_TEXT.confirmFreshBody}</p>
        {flow.step === "sending" && <p className="mt-2 animate-pulse">{DR_TEXT.sending}</p>}
        {flow.step === "failed" && <p className="mt-2 text-text">{DR_TEXT.sendFailed}</p>}
        <div className="mt-3 flex flex-wrap gap-3">
          <button className={button} disabled={flow.step === "sending"} onClick={() => dispatch({ type: "confirm" })}>
            {flow.step === "failed" ? DR_TEXT.sendAgainButton : DR_TEXT.confirmFreshButton}
          </button>
          <button className={button} disabled={flow.step === "sending"} onClick={closeFlow}>
            {DR_TEXT.backButton}
          </button>
        </div>
      </div>
    );
  }

  const inLine = isInLine(view);
  return (
    <div className={frame}>
      {inLine && (
        <p className="font-semibold text-text">{view.kind === "pulling" ? QUEUE_TEXT.pullingHeading : QUEUE_TEXT.heading}</p>
      )}
      {inLine && view.positionLine && <p className="mt-1 text-text">{view.positionLine}</p>}
      {inLine && view.etaLine && <p className="mt-1">{view.etaLine}</p>}
      <p className={inLine ? "mt-2" : ""}>{"text" in view ? view.text : ""}</p>
      {inLine && view.playLine && <p className="mt-2">{view.playLine}</p>}
      {inLine && view.longWait && view.startFreshText && <p className="mt-2 text-text">{view.startFreshText}</p>}
      {noUpdate && <p className="mt-2">{QUEUE_TEXT.noUpdate}</p>}
      {buttons && (buttons.join || buttons.leave || buttons.startFresh || buttons.retry) && (
        <div className="mt-3 flex flex-wrap gap-3">
          {buttons.join && (
            <button className={button} disabled={busy} onClick={onJoin}>
              {buttons.join}
            </button>
          )}
          {buttons.startFresh && (
            <button className={button} disabled={busy} onClick={() => dispatch({ type: "pick", choice: "decline" })}>
              {QUEUE_TEXT.startFreshButton}
            </button>
          )}
          {buttons.leave && (
            <button className={button} disabled={busy} onClick={onLeave}>
              {QUEUE_TEXT.leaveButton}
            </button>
          )}
          {buttons.retry && (
            <button className={button} disabled={busy} onClick={() => run(() => drQueueStatus())}>
              {QUEUE_TEXT.tryAgainButton}
            </button>
          )}
        </div>
      )}
      {view.kind === "not_in_line" && (
        <button className="mt-2 underline" disabled={busy} onClick={() => run(() => drQueueStatus())}>
          {DR_TEXT.tryAgainButton}
        </button>
      )}
    </div>
  );
}
