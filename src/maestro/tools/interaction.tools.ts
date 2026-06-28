import { z } from 'zod';
import type { AgentToolDefinition } from '../maestro.types';

/** One clarifying question in an ask_user batch. */
interface NormalizedQuestion {
  header: string;
  question: string;
  options: string[];
  multiSelect: boolean;
}

/** Coerce whatever the model passed into a clean 1-3 question batch. */
function normalizeQuestions(args: Record<string, unknown>): NormalizedQuestion[] {
  const raw = Array.isArray(args.questions)
    ? args.questions
    : // Legacy single-question shape: { question, options, multiSelect }
      args.question
      ? [
          {
            header: args.header,
            question: args.question,
            options: args.options,
            multiSelect: args.multiSelect,
          },
        ]
      : [];

  return raw
    .map((q) => {
      const item = (q ?? {}) as Record<string, unknown>;
      const question = String(item.question || '').trim();
      const options = Array.isArray(item.options)
        ? item.options
            .map((o) => String(o).trim())
            .filter(Boolean)
            .slice(0, 6)
        : [];
      const header = String(item.header || '').trim() || question.slice(0, 24);
      return {
        header,
        question,
        options,
        multiSelect: Boolean(item.multiSelect),
      };
    })
    .filter((q) => q.question && q.options.length > 0)
    .slice(0, 3);
}

export function createInteractionTools(): AgentToolDefinition[] {
  return [
    {
      name: 'ask_user',
      description:
        'Ask the user 1-3 clarifying questions at once, each with selectable options. The UI renders them as a single panel — multiple questions appear as tabs (like a short wizard). ALWAYS use this instead of writing choices as a bullet/numbered list in your text. Use it only when you genuinely cannot proceed without the user picking. After calling this, STOP and end your turn — wait for the user to reply; do not keep talking or answer your own questions.',
      inputSchema: {
        questions: z
          .array(
            z.object({
              header: z
                .string()
                .describe(
                  'A very short tab label (1-3 words), e.g. "Tone", "Topic", "Format".',
                ),
              question: z
                .string()
                .describe('The full question to ask the user.'),
              options: z
                .array(z.string())
                .describe(
                  '2-6 short, action-oriented option labels to choose from.',
                ),
              multiSelect: z
                .boolean()
                .optional()
                .describe(
                  'True if the user may pick multiple options for THIS question; omit/false for a single choice.',
                ),
            }),
          )
          .describe(
            'A batch of 1-3 related questions. Prefer batching related questions together rather than asking one at a time across multiple turns.',
          ),
      },
      handler: async (args) => {
        const questions = normalizeQuestions(args);
        if (questions.length === 0) {
          return {
            kind: 'question' as const,
            shown: false,
            questions: [],
            instruction:
              'No valid questions were provided. Ask the user directly in one short line instead.',
          };
        }
        return {
          kind: 'question' as const,
          shown: true,
          questions,
          instruction:
            'The question(s) are now displayed to the user as clickable options. End your turn now and wait for their reply.',
        };
      },
    },
  ];
}
