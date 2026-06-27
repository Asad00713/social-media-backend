/**
 * Shared confirmation gate for Maestro's outward-facing tools.
 *
 * When the user's "confirm before sending" setting is on, an outward tool must
 * NOT act on its first call. Instead the handler returns `confirmCard(...)`,
 * which renders through the SAME `kind:'question'` path as ask_user — so the UI
 * shows real Yes/No buttons with zero frontend changes. The model then re-calls
 * the same tool with `confirmed:true` after the user approves.
 *
 * Why this and not a prompt rule: a prompt-only policy only *asks* the model to
 * confirm, so weaker models (e.g. Haiku) sometimes narrate "Confirm? (you should
 * see buttons above)" in prose without ever calling ask_user — no card appears
 * and nothing is gated. This gate makes the handler physically refuse to act
 * until `confirmed:true`, so the model can never "send without asking". Worst
 * case it asks again — it never performs an unconfirmed outward action.
 */

export interface ConfirmableArgs {
  /** Set to true only when re-calling after the user approved. */
  confirmed?: unknown;
}

/** True when the action may proceed: setting off, or the user already approved. */
export function isConfirmed(
  confirmBeforeSend: boolean,
  args: ConfirmableArgs,
): boolean {
  return !confirmBeforeSend || args.confirmed === true;
}

/**
 * A ready-made Yes/No confirmation card for an outward action.
 * @param summary  Plain-language description of exactly what will happen.
 * @param yesLabel The affirmative option label (e.g. "Yes, send it").
 */
export function confirmCard(summary: string, yesLabel: string) {
  return {
    kind: 'question' as const,
    shown: true,
    questions: [
      {
        header: 'Confirm',
        question: summary,
        options: [yesLabel, 'No, cancel'],
        multiSelect: false,
      },
    ],
    instruction: `Confirmation is required before this action. STOP and end your turn now — the UI is already showing the user "${yesLabel}" and "No, cancel" buttons. Do NOT write the confirmation in words. If the user picks "${yesLabel}", call this SAME tool again with the SAME arguments plus confirmed:true to actually perform it. If they pick "No, cancel", do not call it — just acknowledge the cancellation in one short line.`,
  };
}
