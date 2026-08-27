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
 *
 * That covers the OUTBOUND half. The return half — the user's approval getting
 * back to the action — used to travel as ordinary chat text ("Yes, send it"),
 * leaving the model to infer which card it answered and which tool to re-run.
 * Haiku frequently did not: it asked a second time, or narrated "waiting for
 * your approval" while the card beside it already read Answered.
 *
 * So a card now carries its own origin (`pendingAction`): the tool that asked
 * and the arguments it asked with. The service can then re-invoke that handler
 * itself when the approval arrives, and the model is never asked to make the
 * connection. `stampPendingAction` fills this in centrally in buildMcpServer,
 * where the tool name and args are both already in hand — so no call site can
 * forget to.
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

/** The negative option on every confirm card. */
export const CANCEL_LABEL = 'No, cancel';

/**
 * What a confirm card is waiting to do. Stamped centrally (see
 * `stampPendingAction`) and persisted with the message, so an approval can
 * re-invoke the exact handler that asked, with the exact arguments it asked
 * with — instead of asking the model to reconstruct both from chat text.
 */
export interface PendingAction {
  /** Unqualified tool name, e.g. `send_slack_message`. */
  tool: string;
  /** The arguments the tool was called with, minus `confirmed`. */
  args: Record<string, unknown>;
  /** The option that means "go ahead" — matched to identify approval. */
  yesLabel: string;
}

export interface ConfirmCard {
  kind: 'question';
  shown: true;
  questions: {
    header: string;
    question: string;
    options: string[];
    multiSelect: boolean;
  }[];
  instruction: string;
  /** Present only on gate cards; `ask_user` questions have none. */
  pendingAction?: PendingAction;
}

/**
 * Validate a value read back from message metadata as a PendingAction.
 *
 * Stored metadata is untrusted input, not a capability token: it is read back
 * from the database on a later request, so its shape is checked here and its
 * arguments are re-validated against the tool's own schema before anything
 * runs. Tenant identity is never taken from it.
 */
export function isPendingAction(value: unknown): value is PendingAction {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<PendingAction>;
  return (
    typeof v.tool === 'string' &&
    v.tool.length > 0 &&
    typeof v.yesLabel === 'string' &&
    v.yesLabel.length > 0 &&
    typeof v.args === 'object' &&
    v.args !== null &&
    !Array.isArray(v.args)
  );
}

/** True when a tool result is a confirm card awaiting approval. */
export function isConfirmCard(value: unknown): value is ConfirmCard {
  if (!value || typeof value !== 'object') return false;
  const v = value as { kind?: unknown; questions?: unknown };
  return v.kind === 'question' && Array.isArray(v.questions);
}

/**
 * Record which tool asked, and with what, on a card the tool just returned.
 *
 * Called from `buildMcpServer`, the one place holding both the tool name and
 * the arguments — so adding a new outward tool cannot silently miss this the
 * way editing eleven call sites could.
 *
 * `confirmed` is stripped: by definition it was falsy on the call that
 * produced the card, and the approval path sets it itself.
 */
export function stampPendingAction(
  result: unknown,
  tool: string,
  args: Record<string, unknown>,
): unknown {
  if (!isConfirmCard(result) || result.pendingAction) return result;
  const yesLabel = result.questions[0]?.options?.[0];
  // ask_user questions reach here too; only a gate card has the Yes/No shape.
  if (!yesLabel || result.questions[0]?.options?.[1] !== CANCEL_LABEL) {
    return result;
  }
  const rest = { ...args };
  delete rest.confirmed;
  return { ...result, pendingAction: { tool, args: rest, yesLabel } };
}

/**
 * A ready-made Yes/No confirmation card for an outward action.
 * @param summary  Plain-language description of exactly what will happen.
 * @param yesLabel The affirmative option label (e.g. "Yes, send it").
 */
export function confirmCard(summary: string, yesLabel: string): ConfirmCard {
  return {
    kind: 'question' as const,
    shown: true,
    questions: [
      {
        header: 'Confirm',
        question: summary,
        options: [yesLabel, CANCEL_LABEL],
        multiSelect: false,
      },
    ],
    instruction: `Confirmation is required before this action. STOP and end your turn now — the UI is already showing the user "${yesLabel}" and "No, cancel" buttons. Do NOT write the confirmation in words. If the user picks "${yesLabel}", call this SAME tool again with the SAME arguments plus confirmed:true to actually perform it. If they pick "No, cancel", do not call it — just acknowledge the cancellation in one short line.`,
  };
}
