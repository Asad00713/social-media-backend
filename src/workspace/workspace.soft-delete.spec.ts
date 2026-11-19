import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Proves the workspace delete is a soft delete.
 *
 * Deleting a workspace cascades to 50 foreign-keyed tables — channels,
 * campaigns, inbox, analytics, billing — so the difference between marking
 * the row and removing it is the difference between a mistake that can be
 * undone for 30 days and one that cannot be undone at all.
 *
 * `deleteWorkspace` reaches billing, add-ons, limit re-derivation and pooled
 * channels, so standing it up in a unit test would mock most of the
 * application and assert almost nothing. What has to hold is narrower and
 * exact: that one statement in that method is an UPDATE setting `deletedAt`,
 * and that no hard DELETE of `workspace` survives anywhere outside the purge
 * job. That is a property of the source, so the source is what is read.
 *
 * Reverting the method to `db.delete(workspace)` passed 538 existing tests
 * before this file existed — which is precisely why it exists.
 */

const SRC = join(__dirname, '..');

function read(relative: string): string {
  return readFileSync(join(SRC, relative), 'utf8');
}

describe('deleting a workspace is a soft delete', () => {
  const service = read('workspace/workspace.service.ts');

  it('marks the row instead of removing it', () => {
    expect(service).toMatch(/\.update\(workspace\)[\s\S]{0,200}deletedAt:/);
  });

  it('records who deleted it', () => {
    expect(service).toMatch(/deletedById:\s*userId/);
  });

  /**
   * The mutation this file was written for: swapping the UPDATE back for a
   * DELETE. Nothing else in the suite noticed.
   */
  it('contains no hard delete of the workspace table', () => {
    expect(service).not.toMatch(/\.delete\(\s*workspace\s*\)/);
  });

  it('only marks a workspace that is not already deleted', () => {
    // Without the liveWorkspaces() guard, deleting twice would overwrite the
    // first deletion's timestamp and silently extend the retention window.
    expect(service).toMatch(
      /\.update\(workspace\)[\s\S]{0,400}liveWorkspaces\(\)/,
    );
  });

  describe('the real delete lives only in the purge job', () => {
    it('the purge service is the one place that hard-deletes a workspace', () => {
      const purge = read('workspace/workspace-purge.service.ts');
      expect(purge).toMatch(/\.delete\(\s*workspace\s*\)/);
    });

    it('and it only deletes rows past the retention window', () => {
      const purge = read('workspace/workspace-purge.service.ts');
      expect(purge).toMatch(/lt\(\s*workspace\.deletedAt,\s*cutoff\s*\)/);
    });
  });
});
