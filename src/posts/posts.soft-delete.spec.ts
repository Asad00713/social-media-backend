import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Proves deleting a post is a soft delete, and that the two rules behind the
 * exemption list actually hold in the code.
 *
 * `deletePost` reaches calendar sync, queue cancellation and notifications, so
 * standing it up in a unit test would mock most of the application and assert
 * almost nothing. What has to hold is narrower and exact — that the statement
 * is an UPDATE, that no hard DELETE of a user's post survives, and that the
 * measurement reads were left alone on purpose. Those are properties of the
 * source, so the source is what is read.
 *
 * The workspace half of this work shipped with the same approach after
 * reverting its UPDATE to a DELETE passed all 538 existing tests.
 */

const SRC = join(__dirname, '..');

function read(relative: string): string {
  return readFileSync(join(SRC, relative), 'utf8');
}

describe('deleting a post is a soft delete', () => {
  const service = read('posts/services/post.service.ts');
  const draftStore = read('posts/composer/services/draft-store.service.ts');

  it('marks the row instead of removing it', () => {
    expect(service).toMatch(/\.update\(posts\)[\s\S]{0,200}deletedAt:/);
  });

  it('records who deleted it', () => {
    expect(service).toMatch(/deletedById:\s*userId/);
  });

  it('contains no hard delete of a post', () => {
    expect(service).not.toMatch(/\.delete\(\s*posts\s*\)/);
  });

  /**
   * Deleting twice must not overwrite the first deletion's timestamp, which
   * would silently extend the 30-day window each time.
   */
  it('only marks a post that is not already deleted', () => {
    expect(service).toMatch(/\.update\(posts\)[\s\S]{0,400}livePosts\(\)/);
  });

  it('discards a draft the same way', () => {
    expect(draftStore).toMatch(/\.update\(posts\)[\s\S]{0,300}deletedAt:/);
    expect(draftStore).not.toMatch(/\.delete\(\s*posts\s*\)/);
  });
});

describe('the purge job is the only place a post is really deleted', () => {
  const purge = read('posts/services/post-purge.service.ts');

  it('hard-deletes posts', () => {
    expect(purge).toMatch(/\.delete\(\s*posts\s*\)/);
  });

  /**
   * A post can be restored between the read and the delete, so the delete
   * re-checks the condition. Matching on id alone would purge a post someone
   * had just brought back.
   */
  it('re-checks deleted_at in the delete itself, not only in the read', () => {
    const deleteCall = purge.slice(purge.indexOf('.delete(posts)'));
    expect(deleteCall).toMatch(/isNotNull\(posts\.deletedAt\)/);
    expect(deleteCall).toMatch(/lt\(posts\.deletedAt,\s*cutoff\)/);
  });
});

/**
 * The product rule the exemptions encode: what the user *manages* hides
 * deleted posts; what actually *happened* keeps counting them. These two
 * assertions are the load-bearing ends of it.
 */
describe('the measurement/management split', () => {
  it('a deleted post still publishes nothing — the processor skips it', () => {
    const processor = read('posts/processors/post-publish.processor.ts');
    expect(processor).toMatch(/livePosts\(\)/);
  });

  it('a deleted post stops counting towards the queued-post quota', () => {
    // Otherwise a post the user deleted would hold a slot in their plan for
    // 30 days, with nothing on screen to explain why.
    const quota = read('billing/services/post-queue.service.ts');
    expect(quota).toMatch(/livePosts\(\)/);
  });

  it('analytics still counts a post that really published', () => {
    // Deleting in Schedura means "not in my list", not "never happened".
    // Filtering here would move last month's numbers under the user.
    const analytics = read('channels/analytics/services/analytics.service.ts');
    expect(analytics).not.toMatch(/livePosts\(\)|deleted_at IS NULL/);
  });
});
