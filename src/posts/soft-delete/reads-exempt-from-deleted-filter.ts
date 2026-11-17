/**
 * Reads of `workspace` that may legitimately see soft-deleted rows.
 *
 * Every other read must filter them out, or a workspace the owner deleted
 * comes back in the switcher, keeps counting towards their plan, and keeps
 * sending them email. The regression test discovers read sites from disk, so
 * a new one is covered the moment it is written — and the only way past it is
 * an entry here, with a reason.
 *
 * Keys are `relative/path.ts`. A file is exempt in full, so this belongs only
 * on small, single-purpose files where every read is deliberate. A file that
 * mixes both kinds should filter by default and ask for deleted rows
 * explicitly where it needs them.
 */
export const READS_EXEMPT_FROM_DELETED_FILTER: Record<string, string> = {
  'src/workspace/workspace-purge.service.ts':
    'The purge job: finding soft-deleted workspaces is its entire purpose.',

  'src/auth/guards/workspace-suspended.guard.ts':
    'Reads deleted_at on purpose and answers 404. Filtering here would make a deleted workspace return no row, which this guard treats as "nothing to enforce" — it would wave the request through, and the membership checks downstream read workspaceInvitation rather than workspace.',

  'src/inbox/testing/inbox-db.ts':
    'A test fixture that seeds rows against a workspace it just created, so it cannot encounter a deleted one.',
};
