/**
 * Appends a brand-voice block to a system prompt. Import-free on purpose:
 * `ai/lib/composer-assist.ts` imports this, and `brand-voice-prompt.ts` imports
 * `asData` from `composer-assist.ts`, so living in the prompt file would be a
 * circular require.
 */
export function withBrandVoice(system: string, block: string): string {
  return block ? `${system}\n\n${block}` : system;
}
