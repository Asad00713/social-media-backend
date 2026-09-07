/**
 * When a workspace's monthly AI token allowance rolls over.
 *
 * `workspace_usage.ai_tokens_reset_date` is nullable, and the monthly reset in
 * AiTokenService is gated on it:
 *
 *     if (usage.aiTokensResetDate && new Date() >= usage.aiTokensResetDate)
 *
 * NULL is falsy, so a row that never got a date NEVER resets — the workspace
 * burns its allowance once and stays at zero forever, with no code path able to
 * revive it. That was survivable only while AiTokenService's lazy
 * initialisation was the sole creator of usage rows, because it set the date.
 * Now that subscription creation and workspace creation insert the row up
 * front, that lazy branch is unreachable and every insert must supply the date
 * itself.
 *
 * Kept as a free function rather than a method so all five insert sites share
 * exactly one definition of "next cycle".
 */
export function getNextTokenResetDate(now: Date = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth() + 1, 1);
}
