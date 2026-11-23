import { createInteractionTools } from './interaction.tools';

/**
 * `ask_user` is the only way the agent can stop and ask for something, and
 * the card it produces is the user's whole view of that question. The
 * failures that matter here are a question that silently never reaches the
 * screen, and a question that reaches it unanswerable.
 */
describe('ask_user', () => {
  const tool = createInteractionTools().find((t) => t.name === 'ask_user')!;
  const call = (args: Record<string, unknown>) =>
    tool.handler(args, {} as never) as Promise<{
      shown: boolean;
      questions: { question: string; options: string[] }[];
      instruction: string;
    }>;

  it('asks a question that offers no options', async () => {
    // This used to be dropped: an open question ("what should I call it?")
    // was filtered out, the card never rendered, and the turn ended with
    // nothing on screen — so the agent appeared to ignore the user. Every
    // question now carries a free-text field, so there is somewhere to
    // answer.
    const res = await call({
      questions: [{ header: 'Name', question: 'What should I call it?' }],
    });
    expect(res.shown).toBe(true);
    expect(res.questions).toHaveLength(1);
    expect(res.questions[0].options).toEqual([]);
  });

  it('does not tell the model an open question is showing options', async () => {
    // A model told its question is on screen "as clickable options" when it
    // gave none tends to re-ask it in prose with a numbered list, which is
    // the exact behaviour this tool exists to replace.
    const open = await call({
      questions: [{ header: 'Name', question: 'What should I call it?' }],
    });
    expect(open.instruction).not.toContain('clickable options');
    expect(open.instruction).toContain('type into');
  });

  it('still describes options when there are some', async () => {
    const res = await call({
      questions: [
        { header: 'Tone', question: 'Which tone?', options: ['Warm', 'Dry'] },
      ],
    });
    expect(res.instruction).toContain('clickable options');
  });

  it('refuses a card with no question to ask', async () => {
    // An empty card is not an open question — it is a tool call that said
    // nothing, and showing it would put an unanswerable box on screen.
    const res = await call({ questions: [{ header: 'X', question: '  ' }] });
    expect(res.shown).toBe(false);
    expect(res.questions).toEqual([]);
  });

  it('keeps at most three questions and six options', async () => {
    // The card renders questions as tabs and has room for neither more.
    const res = await call({
      questions: Array.from({ length: 5 }, (_, i) => ({
        header: `H${i}`,
        question: `Q${i}?`,
        options: Array.from({ length: 9 }, (_, o) => `o${o}`),
      })),
    });
    expect(res.questions).toHaveLength(3);
    expect(res.questions[0].options).toHaveLength(6);
  });

  it('accepts the legacy single-question shape', async () => {
    // Older stored turns and simpler model calls pass the question at the
    // top level rather than in a batch.
    const res = await call({
      question: 'Which tone?',
      options: ['Warm', 'Dry'],
    });
    expect(res.shown).toBe(true);
    expect(res.questions[0].question).toBe('Which tone?');
  });
});
