import { PgDialect } from 'drizzle-orm/pg-core';
import { workspaceInvitation } from '../../drizzle/schema';
import { inLiveWorkspace, liveWorkspaces } from './soft-delete';

const dialect = new PgDialect();

describe('inLiveWorkspace', () => {
  it('renders an IN-subquery on workspace.deleted_at is null', () => {
    const { sql } = dialect.sqlToQuery(
      inLiveWorkspace(workspaceInvitation.workspaceId),
    );

    expect(sql).toBe(
      '"workspace_invitations"."workspace_id" in (select "workspace"."id" from "workspace" where "workspace"."deleted_at" is null)',
    );
  });

  it('filters on the same predicate as liveWorkspaces()', () => {
    const live = dialect.sqlToQuery(liveWorkspaces()).sql;
    expect(live).toBe('"workspace"."deleted_at" is null');
    expect(
      dialect.sqlToQuery(inLiveWorkspace(workspaceInvitation.workspaceId)).sql,
    ).toContain(live);
  });
});
