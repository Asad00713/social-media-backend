import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../drizzle/db';
import {
  whatsappMessageTemplates,
  type WhatsAppMessageTemplate,
  type WhatsAppTemplateCategory,
  type WhatsAppTemplateStatus,
} from '../drizzle/schema/whatsapp-templates.schema';
import { WhatsAppService } from '../channels/services/whatsapp.service';
import { ChannelService } from '../channels/services/channel.service';
import {
  mapMetaTemplateRow,
  type MappedMetaTemplate,
  type ParsedTemplateEvent,
} from '../channels/services/whatsapp-template.util';

export interface ExistingRow {
  id: string;
  metaTemplateId: string;
  status: string;
}

export interface ReconcileResult {
  toInsert: MappedMetaTemplate[];
  toUpdate: Array<{ id: string; row: MappedMetaTemplate }>;
  toDeleteIds: string[];
}

/**
 * Diff what we have against what Meta returned.
 *
 * Pure and exported so the reconciliation rules — the part with real risk —
 * are testable without a database. Rows Meta no longer returns are deleted
 * outright rather than soft-deleted: Meta deletion is permanent, and keeping a
 * ghost row would offer a restore that cannot work.
 */
export function reconcile(
  existing: ExistingRow[],
  incoming: MappedMetaTemplate[],
): ReconcileResult {
  const byMetaId = new Map(existing.map((e) => [e.metaTemplateId, e]));
  const seen = new Set<string>();
  const toInsert: MappedMetaTemplate[] = [];
  const toUpdate: Array<{ id: string; row: MappedMetaTemplate }> = [];

  for (const row of incoming) {
    const match = byMetaId.get(row.metaTemplateId);
    if (match) {
      seen.add(match.id);
      toUpdate.push({ id: match.id, row });
    } else {
      toInsert.push(row);
    }
  }

  const toDeleteIds = existing.filter((e) => !seen.has(e.id)).map((e) => e.id);
  return { toInsert, toUpdate, toDeleteIds };
}

/** Fetch-on-load is a backstop for missed webhooks, not a live feed — once
 *  every few minutes per channel is ample, and Meta rate-limits per WABA. */
export const SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;

export function shouldSyncChannel(
  lastSyncedAt: Date | null,
  now: Date,
  force = false,
): boolean {
  if (force) return true;
  if (!lastSyncedAt) return true;
  return now.getTime() - lastSyncedAt.getTime() >= SYNC_MIN_INTERVAL_MS;
}

/**
 * Map a webhook event's `reason` onto what we persist.
 *
 * Three distinct inputs, three distinct outcomes:
 * - `undefined` (field omitted entirely) → `undefined`: don't touch the column.
 * - `null` (Meta explicitly cleared it, e.g. on a delete-scheduled transition)
 *   → `null`: write the clear.
 * - `'NONE'` (Meta's sentinel for "no reason") → `null`: same as an explicit clear.
 *
 * `null` and `undefined` look identical after `?.`/`??` collapse them, which is
 * exactly the bug this function exists to prevent: a webhook that explicitly
 * clears a rejection reason must not be silently treated as "said nothing."
 */
export function resolveRejectionReason(
  reason: string | null | undefined,
): string | null | undefined {
  if (reason === undefined) return undefined;
  if (reason === null || reason === 'NONE') return null;
  return reason;
}

@Injectable()
export class WhatsAppTemplatesService {
  private readonly logger = new Logger(WhatsAppTemplatesService.name);

  constructor(
    private readonly whatsapp: WhatsAppService,
    private readonly channels: ChannelService,
  ) {}

  async listForWorkspace(
    workspaceId: string,
  ): Promise<WhatsAppMessageTemplate[]> {
    return db
      .select()
      .from(whatsappMessageTemplates)
      .where(eq(whatsappMessageTemplates.workspaceId, workspaceId))
      .orderBy(asc(whatsappMessageTemplates.name));
  }

  /**
   * Pull every WhatsApp channel's templates from Meta and reconcile them
   * against our mirror. One broken channel (expired token, Graph outage) is
   * logged and skipped rather than failing the whole workspace sync.
   */
  async syncWorkspace(
    workspaceId: string,
    opts?: { force?: boolean },
  ): Promise<{ synced: number }> {
    const channels = await this.channels.getWorkspaceChannels(workspaceId, {
      platform: 'whatsapp',
      isActive: true,
    });

    let synced = 0;
    for (const channel of channels) {
      const rawWabaId: unknown = channel.metadata?.wabaId;
      const wabaId = typeof rawWabaId === 'string' ? rawWabaId : undefined;
      if (!wabaId) {
        this.logger.warn(
          `Channel ${channel.id} has no metadata.wabaId; skipping sync`,
        );
        continue;
      }

      const existingForChannel = await db
        .select({
          id: whatsappMessageTemplates.id,
          metaTemplateId: whatsappMessageTemplates.metaTemplateId,
          status: whatsappMessageTemplates.status,
          lastSyncedAt: whatsappMessageTemplates.lastSyncedAt,
        })
        .from(whatsappMessageTemplates)
        .where(eq(whatsappMessageTemplates.channelId, channel.id));

      const newestSync = existingForChannel.reduce<Date | null>(
        (latest, row) => {
          if (!row.lastSyncedAt) return latest;
          if (!latest || row.lastSyncedAt > latest) return row.lastSyncedAt;
          return latest;
        },
        null,
      );

      if (!shouldSyncChannel(newestSync, new Date(), opts?.force)) {
        continue;
      }

      try {
        const accessToken = await this.channels.getAccessToken(
          channel.id,
          workspaceId,
        );
        const rows = await this.whatsapp.listMessageTemplates(
          accessToken,
          wabaId,
        );
        const incoming = rows.map((row) => mapMetaTemplateRow(row));
        const result = reconcile(existingForChannel, incoming);

        await db.transaction(async (tx) => {
          const now = new Date();

          if (result.toInsert.length > 0) {
            await tx.insert(whatsappMessageTemplates).values(
              result.toInsert.map((row) => ({
                workspaceId,
                channelId: channel.id,
                wabaId,
                metaTemplateId: row.metaTemplateId,
                name: row.name,
                language: row.language,
                category: row.category as WhatsAppTemplateCategory,
                status: row.status as WhatsAppTemplateStatus,
                components: row.components,
                lastSyncedAt: now,
              })),
            );
          }

          for (const { id, row } of result.toUpdate) {
            await tx
              .update(whatsappMessageTemplates)
              .set({
                name: row.name,
                language: row.language,
                category: row.category as WhatsAppTemplateCategory,
                status: row.status as WhatsAppTemplateStatus,
                components: row.components,
                lastSyncedAt: now,
                updatedAt: now,
              })
              .where(eq(whatsappMessageTemplates.id, id));
          }

          if (result.toDeleteIds.length > 0) {
            for (const id of result.toDeleteIds) {
              await tx
                .delete(whatsappMessageTemplates)
                .where(eq(whatsappMessageTemplates.id, id));
            }
          }
        });

        synced += incoming.length;
      } catch (err) {
        this.logger.warn(
          `Template sync failed for channel ${channel.id}: ${(err as Error).message}`,
        );
        continue;
      }
    }

    return { synced };
  }

  /**
   * Apply a webhook status event to EVERY row matching (wabaId,
   * metaTemplateId) — plural on purpose. One WABA can be connected to more
   * than one workspace, and updating only the first row is precisely the
   * fan-out bug this team has shipped before.
   */
  async applyStatusEvents(events: ParsedTemplateEvent[]): Promise<void> {
    for (const event of events) {
      const reason = resolveRejectionReason(event.reason);

      const updateValues: Partial<
        typeof whatsappMessageTemplates.$inferInsert
      > = {
        status: event.status as WhatsAppTemplateStatus,
        updatedAt: new Date(),
      };
      if (reason !== undefined) {
        updateValues.rejectionReason = reason;
      }
      if (event.category !== undefined) {
        updateValues.category = event.category as WhatsAppTemplateCategory;
      }

      const updated = await db
        .update(whatsappMessageTemplates)
        .set(updateValues)
        .where(
          and(
            eq(whatsappMessageTemplates.wabaId, event.wabaId),
            eq(whatsappMessageTemplates.metaTemplateId, event.metaTemplateId),
          ),
        )
        .returning({ id: whatsappMessageTemplates.id });

      if (updated.length === 0) {
        this.logger.debug(
          `No local template row for waba=${event.wabaId} metaTemplateId=${event.metaTemplateId}; ignoring event`,
        );
      }
    }
  }

  /**
   * Meta first: delete at Meta, and only remove the local row if that
   * succeeds. If Meta rejects, the local row must survive so the list does
   * not lie about what still exists.
   */
  async deleteTemplate(workspaceId: string, id: string): Promise<void> {
    const [row] = await db
      .select()
      .from(whatsappMessageTemplates)
      .where(
        and(
          eq(whatsappMessageTemplates.id, id),
          eq(whatsappMessageTemplates.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (!row) {
      throw new NotFoundException('Template not found');
    }

    const accessToken = await this.channels.getAccessToken(
      row.channelId,
      workspaceId,
    );
    await this.whatsapp.deleteMessageTemplate(
      accessToken,
      row.wabaId,
      row.name,
      row.metaTemplateId,
    );

    await db
      .delete(whatsappMessageTemplates)
      .where(eq(whatsappMessageTemplates.id, id));
  }
}
