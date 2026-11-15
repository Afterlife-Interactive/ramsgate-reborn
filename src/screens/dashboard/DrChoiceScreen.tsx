import { useEffect, useRef, useState } from "react";
import { drChoiceDecide } from "../../api/tauri";
import { DR_FLOW_START, DR_TEXT, stepFlow, type DrChoiceAnswer, type DrFlow, type DrFlowAction } from "../../lib/drChoice";

const button = "rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-[14px] font-medium text-text transition-colors enabled:hover:bg-white/10 disabled:opacity-50";

/**
 * The one-time choice. It covers the home tab, so Play cannot be reached until the player has chosen and confirmed.
 * Nothing is pre-selected, nothing has a timer, and Esc or clicking outside does nothing: the screen stays open.
 */
export function DrChoiceScreen({ onAnswer }: { onAnswer: (answer: DrChoiceAnswer) => void }) {
  const [flow, setFlow] = useState<DrFlow>(DR_FLOW_START);
  const flowRef = useRef<DrFlow>(DR_FLOW_START);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Focus goes to the heading, never to a choice button, so Enter cannot pick anything.
  useEffect(() => {
    headingRef.current?.focus();
  }, [flow.step]);

  const dispatch = (action: DrFlowAction) => {
    const { flow: next, send } = stepFlow(flowRef.current, action);
    flowRef.current = next;
    setFlow(next);
    if (!send) return;
    drChoiceDecide(send.choice).then(
      (reply) => {
        // A "try again later" answer means the choice was not saved.
        if (reply.state === "dr_try_again_later") dispatch({ type: "sent_failed" });
        else onAnswer(reply);
      },
      () => dispatch({ type: "sent_failed" }),
    );
  };

  const choice = flow.step === "choose" ? null : flow.choice;
  const moving = choice === "transfer";

  return (
    <div
      className="fixed inset-0 z-40 grid grid-rows-[minmax(0,1fr)] place-items-center overflow-hidden bg-black/70 p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dr-choice-title"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          dispatch({ type: "dismiss" });
        }
      }}
    >
      {/* The text scrolls inside the card; the two buttons stay in view, even in the smallest window (960x600). */}
      <div className="glass flex max-h-full w-full max-w-[520px] flex-col rounded-2xl p-6 text-[14px] leading-relaxed text-text-muted">
        {flow.step === "choose" ? (
          <>
            <div className="min-h-0 overflow-y-auto pr-1">
            <h2 id="dr-choice-title" ref={headingRef} tabIndex={-1} className="display text-[26px] leading-tight text-text outline-none">
              {DR_TEXT.choiceTitle}
            </h2>
            <p className="mt-3">{DR_TEXT.choiceIntro}</p>
            <p className="mt-3 font-semibold text-text">{DR_TEXT.choiceOnlyChance}</p>
            <p className="mt-3">{DR_TEXT.endsOption}</p>
            <p className="mt-4 text-[12px] font-semibold uppercase tracking-wide text-text">{DR_TEXT.moveListHeading}</p>
            <ul className="mt-1 list-disc pl-5">
              {DR_TEXT.moveList.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="mt-3">
              <span className="font-semibold text-text">{DR_TEXT.notMovedHeading}: </span>
              {DR_TEXT.notMoved}
            </p>
            </div>
            <div className="mt-5 flex shrink-0 flex-wrap gap-3">
              <button className={button} onClick={() => dispatch({ type: "pick", choice: "transfer" })}>
                {DR_TEXT.moveButton}
              </button>
              <button className={button} onClick={() => dispatch({ type: "pick", choice: "decline" })}>
                {DR_TEXT.freshButton}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="min-h-0 overflow-y-auto pr-1">
            <h2 id="dr-choice-title" ref={headingRef} tabIndex={-1} className="display text-[24px] leading-tight text-text outline-none">
              {moving ? DR_TEXT.confirmMoveTitle : DR_TEXT.confirmFreshTitle}
            </h2>
            <p className="mt-3">{moving ? DR_TEXT.confirmMoveBody : DR_TEXT.confirmFreshBody}</p>
            {flow.step === "sending" && <p className="mt-3 animate-pulse">{DR_TEXT.sending}</p>}
            {flow.step === "failed" && <p className="mt-3 text-text">{DR_TEXT.sendFailed}</p>}
            </div>
            <div className="mt-5 flex shrink-0 flex-wrap gap-3">
              <button className={button} disabled={flow.step === "sending"} onClick={() => dispatch({ type: "confirm" })}>
                {flow.step === "failed" ? DR_TEXT.sendAgainButton : moving ? DR_TEXT.confirmMoveButton : DR_TEXT.confirmFreshButton}
              </button>
              <button className={button} disabled={flow.step === "sending"} onClick={() => dispatch({ type: "back" })}>
                {DR_TEXT.backButton}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
