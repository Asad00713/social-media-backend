import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  NonCommentableMediaError,
  nonCommentableReason,
} from './non-commentable-media.error';

/**
 * A media the platform says has no comments edge must be asked once, not
 * forever.
 *
 * Meta answers `(#100) nonexisting field (comments)` for a Story, a deleted
 * post, or a media whose edge is not named `comments`. Both pollers already
 * handled that correctly — they returned no comments rather than failing the
 * whole channel's poll. What was missing was MEMORY: "no comments" and "no
 * comments edge" were indistinguishable to the caller, so the inbox poller
 * asked again every 30 seconds.
 *
 * Measured on production: one Instagram Story, **20,169 rows in seven days**.
 */

describe('recognising the platform’s answer', () => {
  it.each([
    [
      '(#100) nonexisting field',
      '{"error":{"message":"(#100) Tried accessing nonexisting field (comments) on node type (Story)","code":100}}',
      'no_comments_edge',
    ],
    [
      'code 100 without the prose',
      '{"error":{"code":100,"message":"something else"}}',
      'no_comments_edge',
    ],
    [
      'the prose without the code',
      '{"error":{"message":"Tried accessing nonexisting field (comments)"}}',
      'no_comments_edge',
    ],
    [
      '(#803) aliases do not exist',
      '{"error":{"message":"(#803) Some of the aliases you requested do not exist: 123","code":803}}',
      'alias_not_found',
    ],
  ])('reads %s as %s', (_label, body, expected) => {
    expect(nonCommentableReason(400, body)).toBe(expected);
  });

  it.each([
    ['a rate limit', 429, '{"error":{"code":4,"message":"rate limited"}}'],
    ['an expired token', 401, '{"error":{"code":190}}'],
    ['a server error', 500, 'upstream exploded'],
    ['a 400 that is a different problem', 400, '{"error":{"code":200}}'],
  ])('does NOT claim %s is non-commentable', (_label, status, body) => {
    // Everything else keeps its existing behaviour: logged and retried. A
    // rate limit recorded as permanent would stop polling a real post for
    // good, which is far worse than the bug being fixed.
    expect(nonCommentableReason(status, body)).toBeNull();
  });

  it('only ever treats a 400 this way', () => {
    const body = '{"error":{"code":100,"message":"nonexisting field"}}';
    expect(nonCommentableReason(400, body)).not.toBeNull();
    for (const status of [401, 403, 404, 429, 500, 503]) {
      expect(nonCommentableReason(status, body)).toBeNull();
    }
  });
});

describe('the error it throws', () => {
  it('carries the media id and the reason, for the row', () => {
    const err = new NonCommentableMediaError('media-123', 'no_comments_edge');
    expect(err.platformPostId).toBe('media-123');
    expect(err.reason).toBe('no_comments_edge');
  });

  it('is an Error, so an unprepared catch still behaves', () => {
    const err = new NonCommentableMediaError('m', 'r');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('NonCommentableMediaError');
  });

  it('says what happened in its message', () => {
    expect(new NonCommentableMediaError('m-9', 'alias_not_found').message).toBe(
      'Media m-9 has no comments edge (alias_not_found)',
    );
  });
});

/**
 * A net over the two services, because the thing that was missing here was a
 * line, not a wrong one — the same shape as BE #251 and #252.
 */
describe('both pollers use the shared matcher', () => {
  const SERVICES = [
    ['instagram', 'instagram.service.ts'],
    ['facebook', 'facebook.service.ts'],
  ] as const;

  function sourceOf(file: string): string {
    return readFileSync(
      join(__dirname, '..', '..', 'channels', 'services', file),
      'utf8',
    );
  }

  it.each(SERVICES)('%s throws NonCommentableMediaError', (_p, file) => {
    expect(sourceOf(file)).toMatch(/throw new NonCommentableMediaError\(/);
  });

  it.each(SERVICES)('%s calls nonCommentableReason', (_p, file) => {
    expect(sourceOf(file)).toMatch(/nonCommentableReason\(/);
  });

  it.each(SERVICES)(
    '%s no longer swallows it with its own inline regex',
    (_p, file) => {
      // The two services carried byte-identical inline guards. Leaving one
      // behind would mean that platform silently keeps the old behaviour
      // while the tests above still pass on the other.
      const text = sourceOf(file);
      expect(text).not.toMatch(/aliases you requested do not exist/);
      expect(text).not.toMatch(/has no comments edge.*skipping/);
    },
  );
});

/**
 * The processor is what turns a single refusal into a permanent skip. Checked
 * at source level because constructing it needs eight collaborators, and what
 * matters here is that the wiring exists at all.
 */
describe('the poller records and then skips', () => {
  const processor = readFileSync(
    join(__dirname, '..', 'processors', 'inbox-poll.processor.ts'),
    'utf8',
  );

  it('asks which media are already known', () => {
    expect(processor).toMatch(/knownFor\(/);
  });

  it('skips those media in the poll loop', () => {
    expect(processor).toMatch(/skipIds\.has\([^)]*\)\)\s*continue;/);
  });

  it('records a newly discovered one', () => {
    expect(processor).toMatch(/nonCommentable\.remember\(/);
  });

  it('does not log it as an error every cycle', () => {
    // An un-throttled logger.error() here is precisely what wrote 20,169 rows
    // into error_logs, the table that reached 738MB once already (BE #128).
    //
    // The slice ends at this branch's own `continue;`, not at a marker
    // further down: the first version ran to the comment above the generic
    // handler and so swallowed THAT handler's logger.error, failing against
    // correct code.
    const start = processor.indexOf('err instanceof NonCommentableMediaError');
    const branch = processor.slice(
      start,
      processor.indexOf('continue;', start),
    );

    expect(branch).toMatch(/this\.logger\.log\(/);
    expect(branch).not.toMatch(/this\.logger\.error\(/);
  });

  it('still logs a GENUINE fetch failure as an error', () => {
    // The branch above must not have turned every failure quiet: a real
    // fetch failure is still something someone needs to see.
    const start = processor.indexOf('err instanceof NonCommentableMediaError');
    const after = processor.slice(processor.indexOf('continue;', start));
    expect(after.slice(0, 500)).toMatch(/this\.logger\.error\(/);
  });
});
