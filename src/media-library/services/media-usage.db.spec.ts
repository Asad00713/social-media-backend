import { NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import type { DbType } from '../../drizzle/db';
import {
  describeLibraryDb,
  withLibraryDb,
  makeMediaItemService,
  seedWorkspace,
  seedChannel,
  seedMediaItem,
  seedSnippet,
  seedLink,
  seedPost,
  seedCampaignSlot,
  seedEvergreenPost,
} from '../testing/library-db';
import { itemReferencedSql } from '../lib/usage-sql';
import { MediaUsageService } from './media-usage.service';
import { TextSnippetService } from './text-snippet.service';
import { SavedLinkService } from './saved-link.service';

const rand = () => Math.random().toString(36).slice(2, 10);
const url = () => `https://cdn.example.test/${rand()}.png`;

async function isReferenced(
  db: DbType,
  item: { id: string; fileUrl: string; workspaceId: string },
  prefix = sql`true`,
): Promise<boolean> {
  const res = await db.execute<{ r: boolean }>(
    sql`SELECT (${prefix} AND ${itemReferencedSql({
      id: sql`${item.id}`,
      fileUrl: sql`${item.fileUrl}`,
      workspaceId: sql`${item.workspaceId}`,
    })}) AS r`,
  );
  return res.rows[0].r;
}

async function evergreenOf(client: PoolClient, campaignId: string) {
  const r = await client.query<{ name: string; category_id: string }>(
    `SELECT c.name, cat.id AS category_id
       FROM campaigns c
       JOIN campaign_evergreen_categories cat ON cat.campaign_id = c.id
      WHERE c.id = $1`,
    [campaignId],
  );
  return r.rows[0];
}

describeLibraryDb('MediaUsageService.getUsage and itemReferencedSql', () => {
  it('lists posts, unmaterialised slots and evergreen entries of this workspace, newest first', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const other = await seedWorkspace(client);
      const channelId = await seedChannel(client, ws, 'instagram');
      const ux = url();
      const x = await seedMediaItem(client, {
        workspaceId: ws,
        uploadedById: ownerId,
        fileUrl: ux,
      });

      // P1: published, references X by id.
      const p1 = await seedPost(client, {
        workspaceId: ws,
        createdById: ownerId,
        status: 'published',
        content: '  Launch day\nSecond line',
        mediaItems: [{ url: url(), type: 'image', libraryItemId: x }],
        targets: [
          { channelId: String(channelId), platform: 'instagram' },
          { channelId: '999', platform: 'facebook' },
        ],
        publishedAt: new Date('2026-10-05T10:00:00Z'),
      });
      // P2: draft, references X by URL, titled through metadata.
      const p2 = await seedPost(client, {
        workspaceId: ws,
        createdById: ownerId,
        status: 'draft',
        mediaItems: [{ url: ux, type: 'image' }],
        metadata: { title: '  Spring promo  ' },
      });
      await client.query(`UPDATE posts SET updated_at = $2 WHERE id = $1`, [
        p2,
        new Date('2026-10-04T10:00:00Z'),
      ]);
      // P3: another workspace, same URL. Never counts.
      await seedPost(client, {
        workspaceId: other.workspaceId,
        createdById: other.ownerId,
        status: 'published',
        mediaItems: [{ url: ux, type: 'image' }],
        publishedAt: new Date('2026-10-09T10:00:00Z'),
      });
      // A pending slot holding X's URL.
      const slot = await seedCampaignSlot(client, {
        workspaceId: ws,
        createdById: ownerId,
        campaignName: 'Autumn drop',
        channelId: String(channelId),
        media: [{ id: 'm1', url: ux }],
        scheduledAt: new Date('2026-10-06T10:00:00Z'),
        slotStatus: 'pending',
      });
      // A slot already turned into P1: P1 counts, the slot does not.
      await seedCampaignSlot(client, {
        workspaceId: ws,
        createdById: ownerId,
        channelId: String(channelId),
        media: [{ id: x, url: ux }],
        postId: p1,
        scheduledAt: new Date('2026-10-07T10:00:00Z'),
        slotStatus: 'published',
      });
      // An evergreen variation holding X by id.
      const ever = await seedEvergreenPost(client, {
        workspaceId: ws,
        createdById: ownerId,
        media: [{ id: 'unrelated', url: url() }],
        variationMedia: [{ id: x }],
      });
      const everMeta = await evergreenOf(client, ever.campaignId);
      await client.query(
        `UPDATE campaign_evergreen_categories SET channel_ids = $2::jsonb WHERE id = $1`,
        [everMeta.category_id, JSON.stringify([String(channelId)])],
      );
      await client.query(
        `UPDATE campaign_evergreen_posts SET created_at = $2 WHERE id = $1`,
        [ever.postId, new Date('2026-10-03T10:00:00Z')],
      );

      const usage = await new MediaUsageService(db).getUsage(ws, x);

      expect(usage.total).toBe(4);
      expect(usage.items).toEqual([
        {
          kind: 'campaign_slot',
          id: slot.slotId,
          campaignId: slot.campaignId,
          title: 'Autumn drop',
          platform: 'instagram',
          date: '2026-10-06T10:00:00.000Z',
          status: 'scheduled',
        },
        {
          kind: 'post',
          id: p1,
          campaignId: null,
          title: 'Launch day',
          platform: 'instagram',
          date: '2026-10-05T10:00:00.000Z',
          status: 'published',
        },
        {
          kind: 'post',
          id: p2,
          campaignId: null,
          title: 'Spring promo',
          platform: '',
          date: '2026-10-04T10:00:00.000Z',
          status: 'draft',
        },
        {
          kind: 'campaign_slot',
          id: ever.postId,
          campaignId: ever.campaignId,
          title: everMeta.name,
          platform: 'instagram',
          date: '2026-10-03T10:00:00.000Z',
          status: 'scheduled',
        },
      ]);

      expect(
        await isReferenced(db, { id: x, fileUrl: ux, workspaceId: ws }),
      ).toBe(true);
      // The disjunction is wrapped: ANDed with false it stays false although
      // X is referenced by a slot and an evergreen entry too (B1).
      expect(
        await isReferenced(
          db,
          { id: x, fileUrl: ux, workspaceId: ws },
          sql`false`,
        ),
      ).toBe(false);

      const unusedUrl = url();
      const unused = await seedMediaItem(client, {
        workspaceId: ws,
        uploadedById: ownerId,
        fileUrl: unusedUrl,
      });
      expect(
        await isReferenced(db, {
          id: unused,
          fileUrl: unusedUrl,
          workspaceId: ws,
        }),
      ).toBe(false);
    });
  });

  it('dates an unscheduled slot by its UTC created_at (B6)', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const uy = url();
      const y = await seedMediaItem(client, {
        workspaceId: ws,
        uploadedById: ownerId,
        fileUrl: uy,
      });
      const slot = await seedCampaignSlot(client, {
        workspaceId: ws,
        createdById: ownerId,
        media: [{ id: y }],
        scheduledAt: null,
        slotStatus: 'pending',
      });
      // created_at is `timestamp` without time zone, written as UTC wall time.
      await client.query(
        `UPDATE campaign_slot_content SET created_at = '2026-10-01 12:00:00' WHERE id = $1`,
        [slot.slotId],
      );
      const post = await seedPost(client, {
        workspaceId: ws,
        createdById: ownerId,
        status: 'scheduled',
        mediaItems: [{ url: uy, type: 'image' }],
        scheduledAt: new Date('2026-10-01T11:00:00Z'),
      });

      const usage = await new MediaUsageService(db).getUsage(ws, y);

      expect(usage.items.map((e) => [e.id, e.date, e.status])).toEqual([
        [slot.slotId, '2026-10-01T12:00:00.000Z', 'scheduled'],
        [post, '2026-10-01T11:00:00.000Z', 'scheduled'],
      ]);
    });
  });

  it('caps items at 20 and counts the exact total (B16)', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const z = await seedMediaItem(client, {
        workspaceId: ws,
        uploadedById: ownerId,
      });
      for (let n = 0; n < 25; n++) {
        await seedPost(client, {
          workspaceId: ws,
          createdById: ownerId,
          status: 'scheduled',
          mediaItems: [{ url: url(), type: 'image', libraryItemId: z }],
          scheduledAt: new Date(Date.UTC(2026, 8, 1 + n, 9)),
        });
      }

      const usage = await new MediaUsageService(db).getUsage(ws, z);

      expect(usage.items).toHaveLength(20);
      expect(usage.total).toBe(25);
      const dates = usage.items.map((e) => e.date);
      expect(dates).toEqual([...dates].sort().reverse());
      expect(dates[0]).toBe('2026-09-25T09:00:00.000Z');
    });
  });

  it("ignores another workspace's evergreen entry with the same URL (B1)", async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const other = await seedWorkspace(client);
      const uw = url();
      const w = await seedMediaItem(client, {
        workspaceId: ws,
        uploadedById: ownerId,
        fileUrl: uw,
      });
      await seedEvergreenPost(client, {
        workspaceId: other.workspaceId,
        createdById: other.ownerId,
        media: [{ id: 'foreign', url: uw }],
        variationMedia: [{ id: 'foreign-2', url: uw }],
      });

      expect(
        await isReferenced(db, { id: w, fileUrl: uw, workspaceId: ws }),
      ).toBe(false);
      expect(await new MediaUsageService(db).getUsage(ws, w)).toEqual({
        items: [],
        total: 0,
      });
    });
  });

  it('finds an evergreen content.media URL hit in its own workspace (B1)', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const uv = url();
      const v = await seedMediaItem(client, {
        workspaceId: ws,
        uploadedById: ownerId,
        fileUrl: uv,
      });
      const ever = await seedEvergreenPost(client, {
        workspaceId: ws,
        createdById: ownerId,
        media: [{ id: 'v1', url: uv }],
      });

      expect(
        await isReferenced(db, { id: v, fileUrl: uv, workspaceId: ws }),
      ).toBe(true);
      const usage = await new MediaUsageService(db).getUsage(ws, v);
      expect(usage.total).toBe(1);
      expect(usage.items).toEqual([
        expect.objectContaining({
          kind: 'campaign_slot',
          id: ever.postId,
          campaignId: ever.campaignId,
          status: 'scheduled',
          platform: '',
        }),
      ]);
    });
  });

  it('trims every kind of whitespace from post titles', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const ut = url();
      const t = await seedMediaItem(client, {
        workspaceId: ws,
        uploadedById: ownerId,
        fileUrl: ut,
      });
      const fromContent = await seedPost(client, {
        workspaceId: ws,
        createdById: ownerId,
        content: '\n\nHello world  \r\nmore',
        mediaItems: [{ url: ut, type: 'image' }],
        publishedAt: new Date('2026-10-02T10:00:00Z'),
      });
      const fromMetadata = await seedPost(client, {
        workspaceId: ws,
        createdById: ownerId,
        content: 'Body',
        metadata: { title: '\t Promo \r\n' },
        mediaItems: [{ url: ut, type: 'image' }],
        publishedAt: new Date('2026-10-01T10:00:00Z'),
      });
      const blankMetadata = await seedPost(client, {
        workspaceId: ws,
        createdById: ownerId,
        content: '\r\n\t\n',
        metadata: { title: '\n\t ' },
        mediaItems: [{ url: ut, type: 'image' }],
        publishedAt: new Date('2026-09-30T10:00:00Z'),
      });

      const usage = await new MediaUsageService(db).getUsage(ws, t);

      expect(usage.items.map((e) => [e.id, e.title])).toEqual([
        [fromContent, 'Hello world'],
        [fromMetadata, 'Promo'],
        [blankMetadata, 'Untitled post'],
      ]);
    });
  });

  it('shows a retired evergreen entry as draft and still counts it', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const ur = url();
      const r = await seedMediaItem(client, {
        workspaceId: ws,
        uploadedById: ownerId,
        fileUrl: ur,
      });
      const entries: Record<string, string> = {};
      for (const [n, status] of ['active', 'paused', 'retired'].entries()) {
        const ever = await seedEvergreenPost(client, {
          workspaceId: ws,
          createdById: ownerId,
          media: [{ id: `e${n}`, url: ur }],
        });
        await client.query(
          `UPDATE campaign_evergreen_posts SET status = $2 WHERE id = $1`,
          [ever.postId, status],
        );
        entries[status] = ever.postId;
      }

      const usage = await new MediaUsageService(db).getUsage(ws, r);

      expect(usage.total).toBe(3);
      const statusOf = new Map(usage.items.map((e) => [e.id, e.status]));
      expect(statusOf.get(entries.active)).toBe('scheduled');
      expect(statusOf.get(entries.paused)).toBe('scheduled');
      expect(statusOf.get(entries.retired)).toBe('draft');

      // A pool with only a retired entry still references the item.
      const ur2 = url();
      const r2 = await seedMediaItem(client, {
        workspaceId: ws,
        uploadedById: ownerId,
        fileUrl: ur2,
      });
      const retired = await seedEvergreenPost(client, {
        workspaceId: ws,
        createdById: ownerId,
        media: [{ id: 'r2', url: ur2 }],
      });
      await client.query(
        `UPDATE campaign_evergreen_posts SET status = 'retired' WHERE id = $1`,
        [retired.postId],
      );
      expect(
        await isReferenced(db, { id: r2, fileUrl: ur2, workspaceId: ws }),
      ).toBe(true);
    });
  });

  it("names no platform from another workspace's channel", async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const other = await seedWorkspace(client);
      const foreignChannel = await seedChannel(
        client,
        other.workspaceId,
        'tiktok',
      );
      const uc = url();
      const item = await seedMediaItem(client, {
        workspaceId: ws,
        uploadedById: ownerId,
        fileUrl: uc,
      });
      const slot = await seedCampaignSlot(client, {
        workspaceId: ws,
        createdById: ownerId,
        channelId: String(foreignChannel),
        media: [{ id: 'm1', url: uc }],
        scheduledAt: new Date('2026-10-02T10:00:00Z'),
      });
      const ever = await seedEvergreenPost(client, {
        workspaceId: ws,
        createdById: ownerId,
        media: [{ id: 'm2', url: uc }],
      });
      const everMeta = await evergreenOf(client, ever.campaignId);
      await client.query(
        `UPDATE campaign_evergreen_categories SET channel_ids = $2::jsonb WHERE id = $1`,
        [everMeta.category_id, JSON.stringify([String(foreignChannel)])],
      );

      const usage = await new MediaUsageService(db).getUsage(ws, item);

      expect(usage.total).toBe(2);
      const platformOf = new Map(usage.items.map((e) => [e.id, e.platform]));
      expect(platformOf.get(slot.slotId)).toBe('');
      expect(platformOf.get(ever.postId)).toBe('');
    });
  });

  it("ignores another workspace's campaign slot with the same URL", async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const other = await seedWorkspace(client);
      const us = url();
      const item = await seedMediaItem(client, {
        workspaceId: ws,
        uploadedById: ownerId,
        fileUrl: us,
      });
      await seedCampaignSlot(client, {
        workspaceId: other.workspaceId,
        createdById: other.ownerId,
        media: [{ id: item, url: us }],
        slotStatus: 'pending',
      });

      expect(
        await isReferenced(db, { id: item, fileUrl: us, workspaceId: ws }),
      ).toBe(false);
      expect(await new MediaUsageService(db).getUsage(ws, item)).toEqual({
        items: [],
        total: 0,
      });
    });
  });

  it('404s for an item outside the workspace', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId: ws } = await seedWorkspace(client);
      const other = await seedWorkspace(client);
      const foreign = await seedMediaItem(client, {
        workspaceId: other.workspaceId,
        uploadedById: other.ownerId,
      });

      await expect(
        new MediaUsageService(db).getUsage(ws, foreign),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

describeLibraryDb('markUsed only marks recency (D13)', () => {
  async function usageOf(client: PoolClient, table: string, id: string) {
    const r = await client.query<{
      usage_count: number;
      last_used_at: Date | null;
    }>(`SELECT usage_count, last_used_at FROM ${table} WHERE id = $1`, [id]);
    return r.rows[0];
  }

  it('sets last_used_at and leaves usage_count for items, snippets and links', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const item = await seedMediaItem(client, {
        workspaceId: ws,
        uploadedById: ownerId,
        usageCount: 3,
      });
      const snippet = await seedSnippet(client, {
        workspaceId: ws,
        createdById: ownerId,
        usageCount: 4,
      });
      const link = await seedLink(client, {
        workspaceId: ws,
        createdById: ownerId,
        usageCount: 5,
      });

      await makeMediaItemService(db).markUsed(ws, item);
      await new TextSnippetService(db).markUsed(ws, snippet);
      await new SavedLinkService(db).markUsed(ws, link);

      const rows = [
        await usageOf(client, 'media_items', item),
        await usageOf(client, 'text_snippets', snippet),
        await usageOf(client, 'saved_links', link),
      ];
      expect(rows.map((r) => r.usage_count)).toEqual([3, 4, 5]);
      for (const r of rows) expect(r.last_used_at).toBeInstanceOf(Date);
    });
  });

  it('404s outside the workspace', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId: ws } = await seedWorkspace(client);
      const other = await seedWorkspace(client);
      const item = await seedMediaItem(client, {
        workspaceId: other.workspaceId,
        uploadedById: other.ownerId,
      });
      const snippet = await seedSnippet(client, {
        workspaceId: other.workspaceId,
        createdById: other.ownerId,
      });
      const link = await seedLink(client, {
        workspaceId: other.workspaceId,
        createdById: other.ownerId,
      });

      await expect(
        makeMediaItemService(db).markUsed(ws, item),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        new TextSnippetService(db).markUsed(ws, snippet),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        new SavedLinkService(db).markUsed(ws, link),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(
        (await usageOf(client, 'media_items', item)).last_used_at,
      ).toBeNull();
    });
  });
});
