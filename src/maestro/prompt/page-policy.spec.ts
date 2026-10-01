import { pagePolicy } from './system-prompt';

/**
 * Page context is the one prompt block that changes as the user moves around.
 * Its risks are specific, and each assertion here is one of them.
 *
 * Saying too much: the agent treating "you are on the Planner" as a topic it
 * must stay inside, or narrating the page every turn.
 *
 * Saying too little: not naming the entity the route already identifies, so
 * "summarise this campaign" becomes a question instead of an answer.
 *
 * Claiming too much: the agent describing what is ON a screen it cannot see.
 * It is given the page's NAME, not its contents.
 */
describe('pagePolicy', () => {
  it('costs nothing when there is no page', () => {
    // The bridges (Telegram/WhatsApp) have no UI. A block that said "the user
    // is nowhere" would spend tokens to describe an absence.
    expect(pagePolicy(undefined)).toBe('');
  });

  it('names the screen the user is on', () => {
    const block = pagePolicy({ page: 'planner', label: 'the Planner' });
    expect(block).toContain('the Planner');
  });

  it('carries the entity id so "this one" resolves without asking', () => {
    const block = pagePolicy({
      page: 'campaign-detail',
      label: 'a campaign',
      entity: { kind: 'campaign', id: 'c-9' },
    });
    expect(block).toContain('c-9');
    expect(block).toContain('campaign');
    // The whole point: act on it rather than asking which one they mean.
    expect(block).toMatch(/rather than asking which one/i);
  });

  it('omits the id instruction when the route names no entity', () => {
    // Telling the model to "pass that id" when there is no id invites it to
    // invent one.
    const block = pagePolicy({ page: 'inbox', label: 'the Inbox' });
    expect(block).not.toMatch(/rather than asking which one/i);
  });

  it('says the page is context, not a boundary', () => {
    // Without this the agent refuses off-page questions, which turns a
    // helpful signal into a cage.
    const block = pagePolicy({ page: 'inbox', label: 'the Inbox' });
    expect(block).toMatch(/CONTEXT, not an instruction/);
    expect(block).toMatch(/never refuse/i);
  });

  it('forbids describing a screen it cannot see', () => {
    // It knows the page's NAME. Everything about its contents has to come
    // from a tool, or the agent will confidently invent what is on screen.
    const block = pagePolicy({ page: 'planner', label: 'the Planner' });
    expect(block).toMatch(/NAME, not what is on it/i);
    expect(block).toMatch(/do not describe a screen you cannot see/i);
  });

  it('tells the agent not to announce the page every turn', () => {
    const block = pagePolicy({ page: 'home', label: 'Home' });
    expect(block).toMatch(/Do not mention the page unless it matters/i);
  });
});
