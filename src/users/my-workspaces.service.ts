import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import {
  plans,
  subscriptions,
  users,
  workspace,
  workspaceInvitation,
} from '../drizzle/schema';
import { liveWorkspaces } from '../posts/soft-delete/soft-delete';

export type MyWorkspaceRole = 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST';

/** One row of Settings > Profile > "Your workspaces". */
export interface MyWorkspace {
  id: string;
  name: string;
  logo: string | null;
  role: MyWorkspaceRole;
  /** The workspace OWNER's plan, not the caller's. */
  planName: string | null;
  /** null for a workspace I own, and when the inviter's account is gone. */
  invitedByName: string | null;
  ownerName: string;
}

/**
 * A subscription in one of these states is what the owner is on; a canceled
 * or incomplete one falls back to the free plan, as billing does.
 */
const LIVE_SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due'];

const FREE_PLAN_CODE = 'FREE';

/** The signed-in person's workspaces: the ones they own and the ones they joined. */
@Injectable()
export class MyWorkspacesService {
  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  /**
   * Owned workspaces first, then joined ones, each group by name. Only
   * ACCEPTED memberships count: a PENDING invitation is not a workspace yet
   * and a REMOVED row grants nothing.
   */
  async list(userId: string): Promise<{ workspaces: MyWorkspace[] }> {
    const [owned, joined, freePlanName] = await Promise.all([
      this.ownedRows(userId),
      this.joinedRows(userId),
      this.freePlanName(),
    ]);

    const toRow = (
      r: Row,
      role: MyWorkspaceRole,
      invitedByName: string | null,
    ): MyWorkspace => ({
      id: r.id,
      name: r.name,
      logo: r.logo,
      role,
      planName: r.planName ?? freePlanName,
      invitedByName,
      ownerName: r.ownerName ?? r.ownerEmail,
    });

    const ownedIds = new Set(owned.map((r) => r.id));
    const rows = [
      ...owned.map((r) => toRow(r, 'OWNER', null)).sort(byName),
      ...joined
        // Owners never hold a membership row; guard anyway so a stray one
        // cannot list the same workspace twice.
        .filter((r) => !ownedIds.has(r.id))
        .map((r) => toRow(r, r.role, r.inviterName ?? r.inviterEmail))
        .sort(byName),
    ];
    return { workspaces: rows };
  }

  private async ownedRows(userId: string): Promise<Row[]> {
    const owner = alias(users, 'owner');
    return this.db
      .select(workspaceColumns(owner.name, owner.email))
      .from(workspace)
      .innerJoin(owner, eq(owner.id, workspace.ownerId))
      .leftJoin(
        subscriptions,
        and(
          eq(subscriptions.userId, workspace.ownerId),
          inArray(subscriptions.status, LIVE_SUBSCRIPTION_STATUSES),
        ),
      )
      .leftJoin(plans, eq(plans.code, subscriptions.planCode))
      // A soft-deleted workspace is gone (migration 0088).
      .where(and(eq(workspace.ownerId, userId), liveWorkspaces()));
  }

  private async joinedRows(userId: string): Promise<JoinedRow[]> {
    const owner = alias(users, 'owner');
    const inviter = alias(users, 'inviter');
    return this.db
      .select({
        ...workspaceColumns(owner.name, owner.email),
        role: workspaceInvitation.role,
        // A null-safe pair: both null when `invited_by` is NULL (the inviter's
        // account was deleted, 0093) or never recorded.
        inviterName: inviter.name,
        inviterEmail: inviter.email,
      })
      .from(workspaceInvitation)
      .innerJoin(workspace, eq(workspace.id, workspaceInvitation.workspaceId))
      .innerJoin(owner, eq(owner.id, workspace.ownerId))
      .leftJoin(inviter, eq(inviter.id, workspaceInvitation.invitedBy))
      .leftJoin(
        subscriptions,
        and(
          eq(subscriptions.userId, workspace.ownerId),
          inArray(subscriptions.status, LIVE_SUBSCRIPTION_STATUSES),
        ),
      )
      .leftJoin(plans, eq(plans.code, subscriptions.planCode))
      .where(
        and(
          eq(workspaceInvitation.userId, userId),
          eq(workspaceInvitation.status, 'ACCEPTED'),
          liveWorkspaces(),
        ),
      );
  }

  private async freePlanName(): Promise<string | null> {
    const [row] = await this.db
      .select({ name: plans.name })
      .from(plans)
      .where(eq(plans.code, FREE_PLAN_CODE))
      .limit(1);
    return row?.name ?? null;
  }
}

interface Row {
  id: string;
  name: string;
  logo: string | null;
  planName: string | null;
  ownerName: string | null;
  ownerEmail: string;
}

interface JoinedRow extends Row {
  role: 'ADMIN' | 'MEMBER' | 'GUEST';
  inviterName: string | null;
  inviterEmail: string | null;
}

/** The columns both queries read, given the aliased owner's name and email. */
function workspaceColumns(
  ownerName: AnyPgColumn<{ data: string | null }>,
  ownerEmail: AnyPgColumn<{ data: string }>,
) {
  return {
    id: workspace.id,
    name: workspace.name,
    logo: workspace.logo,
    planName: plans.name,
    ownerName,
    ownerEmail,
  };
}

const byName = (a: MyWorkspace, b: MyWorkspace): number =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
  a.id.localeCompare(b.id);
