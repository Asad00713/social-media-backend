import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Fail-closed net over the three savings that stop the IG DM rate-limit loop.
 *
 * One conversation produced 2,115 `Application request limit reached` rows in
 * seven days because every cycle re-fetched every conversation. These assert
 * the savings still exist in the source; the behaviour itself is pinned by
 * `dm-poll-window.spec.ts`.
 */
const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('IG DM poll cost', () => {
  const igService = stripComments(
    read('channels/services/instagram.service.ts'),
  );
  const processor = stripComments(
    read('inbox/processors/inbox-poll.processor.ts'),
  );

  it('asks Instagram for 20 messages, not 100', () => {
    // Meta serves at most the 20 most recent messages for IG Messaging.
    expect(igService).toContain("msgUrl.searchParams.set('limit', '20')");
    expect(igService).not.toContain("msgUrl.searchParams.set('limit', '100')");
  });

  it('skips the thread-id lookup when the caller already has one', () => {
    expect(igService).toMatch(/if \(knownThreadId\) \{/);
  });

  it('hands the known thread id to the adapter', () => {
    expect(processor).toMatch(/knownThreadId/);
    expect(processor).toMatch(/thread_id/);
  });

  it('filters conversations through the selector before fetching', () => {
    expect(processor).toContain('selectDmConversationsToFetch');
    // The loop must iterate the SELECTED set, never the raw list again.
    expect(processor).toContain('for (const convo of decision.fetch)');
    expect(processor).not.toContain('for (const convo of conversations)');
  });

  it('only advances the sweep clock when a sweep really happened', () => {
    expect(processor).toContain('dmSwept ? { lastDmSweepAt: new Date() } : {}');
  });
});
