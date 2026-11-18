import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A deleted workspace must stop publishing.
 *
 * Deleting a workspace is a SOFT delete, and it marks only the `workspace`
 * row. Posts keep `deleted_at IS NULL` on purpose — the 30-day window exists
 * so the whole workspace can be restored intact — so a scheduled post in a
 * deleted workspace is still a live post and `livePosts()` alone selects it
 * happily. Proven against the real database:
 *
 *   workspace live    -> filter selects: 3
 *   workspace DELETED -> livePosts() only: 3   <-- these publish
 *   workspace DELETED -> with the guard:   0
 *
 * For a read answering a user's request that gap is harmless: the routing
 * scopes it to a workspace they can reach, and a deleted one is unreachable.
 * The BACKGROUND paths are the problem, because nothing scopes them — they
 * scan `posts` globally on a timer, with no workspace id in the query at all
 * (`grep -c "eq(posts.workspaceId"` returns 0 in every file below). So a
 * workspace someone deleted went on PUBLISHING TO SOCIAL MEDIA in their name
 * until the purge removed it 30 days later, and the reconciler actively
 * re-armed the jobs that would otherwise have drained out of Redis.
 *
 * This is a separate net from reads-filter-deleted.spec.ts. That one asks
 * "does this read filter deleted POSTS", which these files all passed while
 * the bug was live. This one asks the question that was missed: on a path that
 * runs with no user, is the post's WORKSPACE still there?
 *
 * The list is explicit rather than discovered. "Reads posts" is a property of
 * a file; "publishes without a user to scope it" is a property of its purpose,
 * which no pattern can read off disk — and guessing wrong in the permissive
 * direction is how this bug survived the first sweep. A new background scanner
 * has to be added here, and the counts below fail if one of these grows an
 * unguarded read.
 */

const POSTS = join(__dirname, '..');

/**
 * Every path that reads `posts` on a timer or a queue, with no workspace id
 * in the query, and can cause a publish.
 */
const PUBLISHING_PATHS = [
  {
    file: 'processors/post-publish.processor.ts',
    what: 'the publish job itself — the one that actually sends',
    reads: 1,
  },
  {
    file: 'services/scheduled-post-reconciler.service.ts',
    what: 're-arms posts whose Redis job vanished, so it RECREATES jobs',
    reads: 1,
  },
  {
    file: 'services/stranded-post-sweeper.service.ts',
    what: 'recovers posts stuck in `publishing`',
    reads: 2,
  },
  {
    file: 'services/repeat-posts.service.ts',
    what: 'schedules the next post of a repeating series',
    reads: 1,
  },
] as const;

function source(file: string): string {
  return readFileSync(join(POSTS, file), 'utf8');
}

describe('a deleted workspace publishes nothing', () => {
  it.each(PUBLISHING_PATHS.map((p) => [p.file, p] as const))(
    '%s guards on the workspace',
    (_file, path) => {
      const text = source(path.file);
      expect({
        what: path.what,
        guarded: text.includes('liveWorkspacePosts'),
      }).toEqual({ what: path.what, guarded: true });
    },
  );

  /**
   * Every `livePosts()` on these paths needs the workspace guard beside it —
   * not just one of them. The sweeper has two reads, and guarding only the
   * first would leave the batch scan wide open.
   */
  it.each(PUBLISHING_PATHS.map((p) => [p.file, p] as const))(
    '%s guards EVERY read, not just one',
    (_file, path) => {
      const text = source(path.file);
      const live = text.match(/livePosts\(\)/g)?.length ?? 0;
      const guarded = text.match(/liveWorkspacePosts\(\)/g)?.length ?? 0;

      expect({ file: path.file, live }).toEqual({
        file: path.file,
        live: path.reads,
      });
      // One guard per read: the guard is passed as a sibling argument to the
      // same `and(...)`, so the counts match exactly when none was missed.
      expect({ file: path.file, guarded }).toEqual({
        file: path.file,
        guarded: path.reads,
      });
    },
  );

  /**
   * The guard has to sit NEXT TO the post filter, inside the same `and(...)`.
   * A `liveWorkspacePosts()` that appears in the file but in a different
   * clause — or in a comment — would satisfy the checks above and filter
   * nothing.
   */
  it.each(PUBLISHING_PATHS.map((p) => [p.file, p] as const))(
    '%s puts the guard in the same clause as livePosts()',
    (_file, path) => {
      const text = source(path.file);
      const adjacent =
        text.match(/livePosts\(\),\s*liveWorkspacePosts\(\)/g)?.length ?? 0;
      expect({ file: path.file, adjacent }).toEqual({
        file: path.file,
        adjacent: path.reads,
      });
    },
  );
});

describe('the guard itself', () => {
  const helper = source('soft-delete/soft-delete.ts');

  it('tests the workspace, not the post, for deletion', () => {
    const start = helper.indexOf('export function liveWorkspacePosts');
    expect(start).toBeGreaterThan(-1);
    const body = helper.slice(start, helper.indexOf('\n}', start));

    // Correlated on the post's own workspace: a subquery that forgot the
    // correlation would be true whenever ANY live workspace existed, i.e.
    // always, and the tests above would still pass.
    expect(body).toMatch(/workspace\.id\}\s*=\s*\$\{posts\.workspaceId/);
    expect(body).toMatch(/workspace\.deletedAt\}\s*IS NULL/);
  });

  it('does not filter on the post, which livePosts() already does', () => {
    const start = helper.indexOf('export function liveWorkspacePosts');
    const body = helper.slice(start, helper.indexOf('\n}', start));
    expect(body).not.toMatch(/posts\.deletedAt/);
  });
});
