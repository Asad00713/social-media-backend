import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * A deleted workspace must publish nothing.
 *
 * Deleting a workspace is a SOFT delete, and it marks only the `workspace`
 * row. Posts keep `deleted_at IS NULL` on purpose — the 30-day window exists
 * so a restore can be lossless — so a scheduled post in a deleted workspace is
 * still a live post, and `livePosts()` alone selects it happily. Proven
 * against the database:
 *
 *   workspace live    -> filter selects:   3
 *   workspace DELETED -> livePosts() only: 3   <- these still publish
 *   workspace DELETED -> with the guard:   0
 *
 * For a read answering a user's request that is harmless: routing scopes it to
 * a workspace they can reach, and a deleted one is unreachable. The background
 * engines are the problem, because nothing scopes them.
 *
 * ## Why this net is DISCOVERED, not a list
 *
 * The first version of this file carried a hand-written list of four files
 * under `src/posts`. It passed 14/14 while TWO WHOLE PUBLISHING ENGINES
 * published unguarded — evergreen recycling (a daily cron that materialises
 * `posts` rows and sends them) and drip campaigns (which call
 * `PostService.publishPost` directly, so the publish processor's guard was
 * never in their path). The list certified the fix complete when it was not,
 * and its stated defence — "you cannot infer intent from disk" — was half
 * right at best: intent cannot be inferred, but CAPABILITY can be enumerated,
 * and capability is the property that matters.
 *
 * So the default is inverted to fail-closed. Any file that can cause a publish
 * must either carry a workspace-liveness guard or be listed below with a
 * reason. A new engine added under `src/campaigns`, `src/drips` or anywhere
 * else fails this spec until someone decides which it is.
 *
 * Modelled on reads-filter-deleted.spec.ts, which does the same for deleted
 * POSTS. That spec passed throughout this bug's life, because it asks a
 * different question: "does this read filter deleted posts". One discovery net
 * only catches the property it encodes.
 */

const SRC = join(__dirname, '..', '..');

/**
 * What makes a file able to publish.
 *
 * Enqueueing a publish job, calling the publish service directly, or creating
 * a `posts` row that is already scheduled (which some later sweep will pick
 * up). Any one of them is enough.
 */
const CAN_PUBLISH: ReadonlyArray<{ what: string; pattern: RegExp }> = [
  { what: "enqueues 'publish-post'", pattern: /['"`]publish-post['"`]/ },
  { what: "enqueues 'publish'", pattern: /\.add\(\s*['"`]publish['"`]/ },
  { what: 'calls publishPost()', pattern: /\.publishPost\(/ },
  {
    what: 'materialises and enqueues a campaign post',
    pattern: /materializeAndEnqueue\(/,
  },
  {
    what: "inserts a post with status 'scheduled'",
    pattern:
      /\.insert\(\s*posts\s*\)[\s\S]{0,600}?status:\s*['"`]scheduled['"`]/,
  },
];

/**
 * The ways a file can gate publishing on the workspace being live.
 *
 * `liveWorkspaces()` is deliberately NOT one of them. It is a bare SQL
 * fragment used all over the codebase for ordinary scoped reads, and counting
 * it here made this net miss a real bug: `drip.processor.ts` uses it once for
 * a TIMEZONE LOOKUP that feeds an email, so the file matched while its publish
 * path was completely unguarded. Mutation-testing caught that - removing the
 * drip guard left 14/14 green.
 *
 * Only the two purpose-built guards count, because only they mean "this
 * workspace may be published to": `liveWorkspacePosts()` filters a read of
 * `posts`, and `isWorkspaceLive()` is the early-return form for a path that
 * CREATES posts.
 */
const GUARDS = /liveWorkspacePosts\(|isWorkspaceLive\(/;

/**
 * Files that CAN publish but need no guard of their own, each with the reason.
 *
 * A reason is mandatory. "Scoped by routing" is the common one and is only
 * valid when the path cannot run without a user request naming a workspace
 * they can reach — a cron or queue processor never qualifies.
 */
const EXEMPT: Readonly<Record<string, string>> = {
  'posts/posts.controller.ts':
    'The Publish now route: @RequireCapability + a :workspaceId path param, ' +
    'so it cannot run for a workspace the caller cannot reach.',
  'maestro/tools/post.tools.ts':
    'Agent tools publish through ctx.workspaceId, the session workspace, and ' +
    'load the post via getPost which carries the guard.',
  'posts/lib/held-targets.ts':
    'A pure helper. enqueueHeldPost takes the queue, db and post from its ' +
    'caller and reads nothing itself; its callers are channel-pause ' +
    '(user-scoped) and post.service (guarded in getPost).',
  'campaigns/campaign-publishing.service.ts':
    'The shared materialise helper. Its callers decide liveness: ' +
    'evergreen.service.ts guards fireOccurrence, campaigns.service.ts is ' +
    'user-request scoped. Guarding here would duplicate the check.',
  'campaigns/campaigns.service.ts':
    'Its materializeAndEnqueue calls are user-request initiated (launch, ' +
    'slot edit), scoped to a reachable workspace.',
  'posts/composer/services/composer-scheduling.service.ts':
    'Composer scheduling, from a user request that names its workspace.',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.includes('.spec.')) out.push(full);
  }
  return out;
}

/** Every file that can cause a publish, with what makes it able to. */
function publishingFiles(): Array<{ file: string; why: string[] }> {
  const found: Array<{ file: string; why: string[] }> = [];
  for (const full of walk(SRC)) {
    const text = readFileSync(full, 'utf8');
    const why = CAN_PUBLISH.filter((c) => c.pattern.test(text)).map(
      (c) => c.what,
    );
    if (why.length > 0) {
      found.push({ file: relative(SRC, full).split(sep).join('/'), why });
    }
  }
  return found;
}

const PUBLISHERS = publishingFiles();

describe('every publishing path knows about deleted workspaces', () => {
  it('finds the publishing paths at all', () => {
    // A rewrite that breaks the patterns would otherwise pass vacuously.
    expect(PUBLISHERS.length).toBeGreaterThanOrEqual(8);
  });

  it('each one either guards or is exempt with a reason', () => {
    const unguarded = PUBLISHERS.filter(({ file }) => !(file in EXEMPT)).filter(
      ({ file }) => !GUARDS.test(readFileSync(join(SRC, file), 'utf8')),
    );

    // Names the file AND what makes it a publisher, so the failure says what
    // to do rather than only that something is wrong.
    expect(unguarded.map((u) => `${u.file} (${u.why.join('; ')})`)).toEqual([]);
  });

  it('the exemption list has no stale entries', () => {
    const files = new Set(PUBLISHERS.map((p) => p.file));
    expect(Object.keys(EXEMPT).filter((f) => !files.has(f))).toEqual([]);
  });

  it('every exemption states a reason', () => {
    expect(
      Object.entries(EXEMPT)
        .filter(([, reason]) => reason.trim().length < 20)
        .map(([file]) => file),
    ).toEqual([]);
  });

  /**
   * The engines that burned us. Named explicitly as well as discovered: these
   * are the two the hand-written list missed, and a regression here is the
   * original bug returning.
   */
  it.each([
    ['campaigns/evergreen.service.ts', 'evergreen recycling (daily cron)'],
    ['drips/processors/drip.processor.ts', 'drip campaigns (queue processor)'],
    ['posts/processors/post-publish.processor.ts', 'the publish job itself'],
    ['posts/services/repeat-posts.service.ts', 'repeating series'],
  ])('%s guards the workspace (%s)', (file) => {
    expect(GUARDS.test(readFileSync(join(SRC, file), 'utf8'))).toBe(true);
  });
});

/**
 * Two engines sweep EVERY campaign in the system on a timer. An unscoped
 * `select().from(campaigns)` is how a deleted workspace stayed on their books
 * for 30 days — the daily one armed and fired occurrences, materialising
 * `posts` rows and marking occurrences `published` the whole time.
 */
describe('the campaign crons do not sweep deleted workspaces', () => {
  it.each([
    ['campaigns/evergreen.service.ts', 'reconcile'],
    ['campaigns/evergreen-scoring.service.ts', 'recomputeAllActiveScores'],
  ])('%s scopes its campaign sweep (%s)', (file) => {
    const text = readFileSync(join(SRC, file), 'utf8');
    // The bare form that caused this: every campaign, filtered in JS.
    // Comments stripped: the shape being forbidden is quoted in this file's
    // own prose and in the comments explaining why it was wrong.
    const code = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    // The defect is a sweep with NO `.where` at all - every campaign in the
    // system, filtered in JS. A `select().from(campaigns).where(...)` is a
    // scoped lookup by id and is fine, so the pattern requires the absence of
    // a following `.where`.
    expect(code).not.toMatch(
      /select\(\)\s*\.from\(campaigns\)\s*\)?\s*(?!\s*\.where)[;)]/,
    );
    expect(code).toMatch(/liveWorkspaces\(/);
  });
});

/**
 * `fireOccurrence` always re-arms the next occurrence in a `finally`, whatever
 * happened. So its workspace check has to return BEFORE the `try` — inside it,
 * the chain would keep spinning: this occurrence stopped, the next one
 * scheduled.
 */
describe('a deleted workspace stops the evergreen rotation', () => {
  const text = readFileSync(
    join(SRC, 'campaigns/evergreen.service.ts'),
    'utf8',
  );
  const fire = text.slice(text.indexOf('async fireOccurrence'));

  it('checks the workspace before the try/finally that re-arms', () => {
    const check = fire.indexOf('isWorkspaceLive');
    const tryBlock = fire.indexOf('\n    try {');
    expect(check).toBeGreaterThan(-1);
    expect(tryBlock).toBeGreaterThan(-1);
    expect({ checkBeforeTry: check < tryBlock }).toEqual({
      checkBeforeTry: true,
    });
  });
});

describe('the guards themselves', () => {
  const helper = readFileSync(
    join(SRC, 'posts/soft-delete/soft-delete.ts'),
    'utf8',
  );

  function body(name: string): string {
    const start = helper.indexOf(`export ${name}`);
    expect(start).toBeGreaterThan(-1);
    return helper.slice(start, helper.indexOf('\n}', start));
  }

  it('liveWorkspacePosts correlates on the post own workspace', () => {
    const text = body('function liveWorkspacePosts');
    // An uncorrelated EXISTS is true whenever ANY live workspace exists — it
    // filters nothing while looking entirely correct.
    expect(text).toMatch(/workspace\.id\}\s*=\s*\$\{posts\.workspaceId/);
    expect(text).toMatch(/workspace\.deletedAt\}\s*IS NULL/);
  });

  it('liveWorkspacePosts does not re-filter the post', () => {
    expect(body('function liveWorkspacePosts')).not.toMatch(/posts\.deletedAt/);
  });

  it('isWorkspaceLive asks about one workspace', () => {
    const text = body('async function isWorkspaceLive');
    expect(text).toMatch(/eq\(workspace\.id,\s*workspaceId\)/);
    expect(text).toMatch(/liveWorkspaces\(\)/);
  });
});
