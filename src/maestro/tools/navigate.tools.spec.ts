import {
  createNavigateTools,
  NAVIGATION_DESTINATIONS,
} from './navigate.tools';

/**
 * This tool moves the user's screen, so its failure mode is not a wrong
 * sentence — it is the app jumping somewhere they did not ask to go. The
 * guard that matters is that an unrecognised destination produces nothing
 * the client will act on.
 */
describe('navigate_to', () => {
  const tool = createNavigateTools()[0];
  const run = (args: Record<string, unknown>) =>
    tool.handler(args) as Promise<Record<string, unknown>>;

  it('returns the destination for the client to route', async () => {
    // Deliberately a NAME, not a URL: the backend does not own frontend
    // routing, and a model writing its own links writes broken ones.
    const out = await run({ destination: 'settings-profile' });
    expect(out).toMatchObject({
      kind: 'navigate',
      ok: true,
      destination: 'settings-profile',
    });
    expect(JSON.stringify(out)).not.toContain('/w/');
    expect(JSON.stringify(out)).not.toContain('http');
  });

  it('refuses a destination that is not on the list', async () => {
    // The enum normally catches this, but a provider that skips schema
    // validation would otherwise hand the client a name it might act on.
    const out = await run({ destination: 'settings-teleport' });
    expect(out.ok).toBe(false);
    expect(out.destination).toBeUndefined();
    expect(String(out.error)).toContain('settings-teleport');
  });

  it('refuses a missing destination rather than defaulting', async () => {
    // Defaulting to Home would move the user for a malformed call.
    const out = await run({});
    expect(out.ok).toBe(false);
    expect(out.destination).toBeUndefined();
  });

  it('passes the reason through, capped', async () => {
    const out = await run({
      destination: 'planner',
      reason: 'x'.repeat(500),
    });
    expect(String(out.reason).length).toBe(120);
  });

  it('omits reason entirely when none was given', async () => {
    const out = await run({ destination: 'inbox' });
    expect(out).not.toHaveProperty('reason');
  });

  it('tells the model which destination covers a profile picture', async () => {
    // The question that motivated this tool was "where do I change my
    // profile picture". If the description does not point at the profile
    // page, the model picks workspace settings instead.
    expect(tool.description).toMatch(/settings-profile[^\n]*avatar/i);
  });

  it('keeps the agent off entity deep links', async () => {
    // A specific post or campaign is an entity reference, which already
    // carries an id and routes through the reference system.
    expect(tool.description).toMatch(/Do NOT use it to show one specific/i);
  });

  it('warns against navigating mid-task', async () => {
    // Moving the page while someone is composing loses their work.
    expect(tool.description).toMatch(/Do NOT navigate away mid-task/i);
  });

  it('offers a profile destination at all', () => {
    expect(NAVIGATION_DESTINATIONS).toContain('settings-profile');
  });
});
