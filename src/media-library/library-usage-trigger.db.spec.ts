import type { PoolClient } from 'pg';
import {
  applyMigrationAgain,
  describeLibraryDb,
  seedLink,
  seedMediaItem,
  seedPost,
  seedSnippet,
  seedWorkspace,
  withLibraryDb,
} from './testing/library-db';

const MIGRATION = '0055_posts_library_refs.sql';

async function usage(
  client: PoolClient,
  table: 'media_items' | 'saved_links' | 'text_snippets',
  id: string,
): Promise<number | null> {
  const r = await client.query<{ usage_count: number | null }>(
    `SELECT usage_count FROM ${table} WHERE id = $1`,
    [id],
  );
  return r.rows[0].usage_count;
}

async function urlInText(
  client: PoolClient,
  txt: string,
  url: string,
): Promise<boolean> {
  const r = await client.query<{ hit: boolean }>(
    `SELECT library_url_in_text($1, $2) AS hit`,
    [txt, url],
  );
  return r.rows[0].hit;
}

const sorted = (values: string[]) => [...new Set(values)].sort();

describeLibraryDb('migration 0055 (post library refs, usage trigger)', () => {
  it('derives library_refs and media_urls from media_items and every platform override', async () => {
    await withLibraryDb(async (_db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const [i1, i3] = [crypto.randomUUID(), crypto.randomUUID()];
      const [u1, u2, u3, u4] = [1, 2, 3, 4].map(
        (n) => `https://cdn.example.test/u${n}.png`,
      );
      const full = await seedPost(client, {
        workspaceId,
        createdById: ownerId,
        mediaItems: [
          { url: u1, type: 'image', libraryItemId: i1 },
          { url: u2, type: 'image' },
        ],
        platformContent: {
          instagram: {
            overrides: {
              mediaItems: [{ url: u3, type: 'image', libraryItemId: i3 }],
            },
          },
          facebook: { mediaItems: [{ url: u4, type: 'image' }] },
        },
      });
      const empty = await seedPost(client, {
        workspaceId,
        createdById: ownerId,
      });
      await client.query(
        `UPDATE posts SET media_items = NULL, platform_content = NULL
          WHERE id = $1`,
        [empty],
      );

      const r = await client.query<{
        id: string;
        library_refs: string[];
        media_urls: string[];
      }>(`SELECT id, library_refs, media_urls FROM posts WHERE id = ANY($1)`, [
        [full, empty],
      ]);
      const row = (id: string) => r.rows.find((x) => x.id === id)!;
      expect(sorted(row(full).library_refs)).toEqual(sorted([i1, i3]));
      expect(sorted(row(full).media_urls)).toEqual(sorted([u1, u2, u3, u4]));
      expect(row(empty).library_refs).toEqual([]);
      expect(row(empty).media_urls).toEqual([]);
    });
  });

  it('keeps a media item’s usage_count a count of its workspace’s posts, by id or URL', async () => {
    await withLibraryDb(async (_db, client) => {
      const a = await seedWorkspace(client);
      const b = await seedWorkspace(client);
      const ux = `https://cdn.example.test/x-${crypto.randomUUID()}.png`;
      const x = await seedMediaItem(client, {
        workspaceId: a.workspaceId,
        uploadedById: a.ownerId,
        fileUrl: ux,
      });
      const post = (mediaItems: unknown[]) =>
        seedPost(client, {
          workspaceId: a.workspaceId,
          createdById: a.ownerId,
          mediaItems,
        });

      // By id only (the URL is a stale transform, not Ux).
      const p1 = await post([
        {
          url: 'https://cdn.example.test/other.png',
          type: 'image',
          libraryItemId: x,
        },
      ]);
      expect(await usage(client, 'media_items', x)).toBe(1);

      // By URL only.
      const p2 = await post([{ url: ux, type: 'image' }]);
      expect(await usage(client, 'media_items', x)).toBe(2);

      // By id in one entry and URL in another: still one post.
      const p3 = await post([
        {
          url: 'https://cdn.example.test/crop.png',
          type: 'image',
          libraryItemId: x,
        },
        { url: ux, type: 'image' },
      ]);
      expect(await usage(client, 'media_items', x)).toBe(3);

      await client.query(
        `UPDATE posts SET media_items = '[]'::jsonb WHERE id = $1`,
        [p2],
      );
      expect(await usage(client, 'media_items', x)).toBe(2);

      await client.query(`DELETE FROM posts WHERE id = $1`, [p1]);
      expect(await usage(client, 'media_items', x)).toBe(1);

      // B4: workspace B holds the same URL; only B's own item counts it.
      const y = await seedMediaItem(client, {
        workspaceId: b.workspaceId,
        uploadedById: b.ownerId,
        fileUrl: ux,
      });
      await seedPost(client, {
        workspaceId: b.workspaceId,
        createdById: b.ownerId,
        mediaItems: [{ url: ux, type: 'image' }],
      });
      expect(await usage(client, 'media_items', y)).toBe(1);
      expect(await usage(client, 'media_items', x)).toBe(1);

      // A content edit on P3 recounts X; B's post must not join the count.
      await client.query(`UPDATE posts SET content = 'Edited' WHERE id = $1`, [
        p3,
      ]);
      expect(await usage(client, 'media_items', x)).toBe(1);

      // A change to no watched column does not fire the trigger.
      await client.query(
        `UPDATE media_items SET usage_count = 99 WHERE id = $1`,
        [x],
      );
      await client.query(
        `UPDATE posts SET status = 'scheduled' WHERE id = $1`,
        [p3],
      );
      expect(await usage(client, 'media_items', x)).toBe(99);
      // A no-op write to a watched column fails the WHEN clause too.
      await client.query(`UPDATE posts SET content = content WHERE id = $1`, [
        p3,
      ]);
      expect(await usage(client, 'media_items', x)).toBe(99);
    });
  });

  it('counts a saved link only where its URL ends on a boundary (B5)', async () => {
    await withLibraryDb(async (_db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const link = await seedLink(client, {
        workspaceId,
        createdById: ownerId,
        url: 'https://shop.example/p',
      });
      const post = (
        content: string | null,
        platformContent?: Record<string, unknown>,
      ) =>
        seedPost(client, {
          workspaceId,
          createdById: ownerId,
          content,
          platformContent,
        });

      const withQuery = await post('Buy https://shop.example/p?utm_source=ig');
      expect(await usage(client, 'saved_links', link)).toBe(1);

      await post('See https://shop.example/pricing');
      expect(await usage(client, 'saved_links', link)).toBe(1);

      // The recount this edit triggers must not count the /pricing post.
      await client.query(
        `UPDATE posts SET content = 'Sold out' WHERE id = $1`,
        [withQuery],
      );
      expect(await usage(client, 'saved_links', link)).toBe(0);

      await post('Shop now https://shop.example/p');
      expect(await usage(client, 'saved_links', link)).toBe(1);

      await post(null, { facebook: { text: 'Go to https://shop.example/p' } });
      expect(await usage(client, 'saved_links', link)).toBe(2);

      // Only in an override, followed by a newline (JSON would escape it).
      await post(null, {
        linkedin: { text: 'See https://shop.example/p\nnext' },
      });
      expect(await usage(client, 'saved_links', link)).toBe(3);

      // Trailing sentence punctuation before the boundary.
      await post('Grab it at https://shop.example/p.');
      expect(await usage(client, 'saved_links', link)).toBe(4);
      await post('New stock (https://shop.example/p) today');
      expect(await usage(client, 'saved_links', link)).toBe(5);
      await post('Old page https://shop.example/p.html');
      expect(await usage(client, 'saved_links', link)).toBe(5);
    });
  });

  it('library_url_in_text matches the escaped URL followed by a boundary', async () => {
    await withLibraryDb(async (_db, client) => {
      const url = 'https://x.io/a.b';
      expect(await urlInText(client, 'a https://x.io/a.b c', url)).toBe(true);
      expect(await urlInText(client, 'https://x.io/aXb', url)).toBe(false);
      // The literal URL is present (strpos passes) but not on a boundary; an
      // unescaped `.` would match `aXb ` instead.
      expect(
        await urlInText(client, 'https://x.io/aXb then https://x.io/a.bZ', url),
      ).toBe(false);
      expect(await urlInText(client, 'end https://x.io/a.b', url)).toBe(true);
      expect(await urlInText(client, 'https://x.io/a.b#top', url)).toBe(true);
      expect(await urlInText(client, 'https://x.io/a.b&x=1', url)).toBe(true);
      expect(await urlInText(client, 'https://x.io/a.b/more', url)).toBe(false);
      expect(await urlInText(client, 'anything', '')).toBe(false);
      expect(await urlInText(client, 'see https://x.io/a.b.', url)).toBe(true);
      expect(await urlInText(client, '(https://x.io/a.b)', url)).toBe(true);
      expect(await urlInText(client, '(https://x.io/a.b). Next', url)).toBe(
        true,
      );
      expect(await urlInText(client, 'https://x.io/a.b.html', url)).toBe(false);
      expect(await urlInText(client, 'https://x.io/a.b:8080', url)).toBe(false);
    });
  });

  it('library_post_text is content plus unescaped override strings, minus media', async () => {
    await withLibraryDb(async (_db, client) => {
      const r = await client.query<{ txt: string }>(
        `SELECT library_post_text($1, $2::jsonb) AS txt`,
        [
          'Body',
          JSON.stringify({
            linkedin: { text: 'Line one\nLine "two"' },
            instagram: {
              mediaItems: [
                { url: 'https://cdn.example.test/m.png', type: 'image' },
              ],
            },
          }),
        ],
      );
      const txt = r.rows[0].txt;
      expect(txt.startsWith('Body ')).toBe(true);
      expect(txt).toContain('Line one\nLine "two"');
      expect(txt).not.toContain('image');
      expect(txt).not.toContain('cdn.example.test');
      expect(txt).not.toContain('linkedin');
    });
  });

  it('counts a snippet of at least 3 characters by containment', async () => {
    await withLibraryDb(async (_db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const tags = await seedSnippet(client, {
        workspaceId,
        createdById: ownerId,
        content: '#summer #sale',
      });
      const short = await seedSnippet(client, {
        workspaceId,
        createdById: ownerId,
        content: 'ab',
      });
      const multiLine = await seedSnippet(client, {
        workspaceId,
        createdById: ownerId,
        content: 'Free shipping\nall week',
      });
      const mediaToken = await seedSnippet(client, {
        workspaceId,
        createdById: ownerId,
        content: 'image',
      });
      await seedPost(client, {
        workspaceId,
        createdById: ownerId,
        content: 'Hot deals #summer #sale about it',
      });
      expect(await usage(client, 'text_snippets', tags)).toBe(1);
      expect(await usage(client, 'text_snippets', short)).toBe(0);

      // A multi-line snippet inside an override (JSON would escape the newline).
      await seedPost(client, {
        workspaceId,
        createdById: ownerId,
        content: null,
        platformContent: {
          instagram: { text: 'Big news\nFree shipping\nall week\nGo' },
        },
      });
      expect(await usage(client, 'text_snippets', multiLine)).toBe(1);

      // A media-only post holds `image` only as a media type, not as text.
      await seedPost(client, {
        workspaceId,
        createdById: ownerId,
        content: '',
        mediaItems: [{ url: 'https://cdn.example.test/i.png', type: 'image' }],
        platformContent: {
          instagram: {
            mediaItems: [
              { url: 'https://cdn.example.test/i.png', type: 'image' },
            ],
          },
        },
      });
      expect(await usage(client, 'text_snippets', mediaToken)).toBe(0);
    });
  });

  it('a re-apply recounts every stale usage_count, zeroing snippets under 3 characters (B5)', async () => {
    await withLibraryDb(async (_db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const item = await seedMediaItem(client, {
        workspaceId,
        uploadedById: ownerId,
      });
      const link = await seedLink(client, {
        workspaceId,
        createdById: ownerId,
        url: 'https://shop.example/stale',
      });
      await seedPost(client, {
        workspaceId,
        createdById: ownerId,
        content: 'New in https://shop.example/stale today ab',
        mediaItems: [
          { url: 'https://cdn.example.test/t.png', libraryItemId: item },
        ],
      });
      // Stale values written behind the trigger's back (no trigger on these).
      await client.query(
        `UPDATE media_items SET usage_count = 7 WHERE id = $1`,
        [item],
      );
      await client.query(
        `UPDATE saved_links SET usage_count = 4 WHERE id = $1`,
        [link],
      );
      const short = await seedSnippet(client, {
        workspaceId,
        createdById: ownerId,
        content: 'ab',
        usageCount: 5,
      });
      const blank = await seedSnippet(client, {
        workspaceId,
        createdById: ownerId,
        content: '',
        usageCount: 3,
      });
      // Only inside an override, after a newline / spanning lines: the
      // recount searches unescaped override text, as the trigger does.
      const overrideLink = await seedLink(client, {
        workspaceId,
        createdById: ownerId,
        url: 'https://shop.example/override',
        usageCount: 9,
      });
      const multiLine = await seedSnippet(client, {
        workspaceId,
        createdById: ownerId,
        content: 'Free shipping\nall week',
        usageCount: 9,
      });
      const mediaToken = await seedSnippet(client, {
        workspaceId,
        createdById: ownerId,
        content: 'image',
        usageCount: 9,
      });
      await client.query(
        `INSERT INTO posts (workspace_id, created_by_id, content, platform_content)
         VALUES ($1, $2, NULL, $3::jsonb)`,
        [
          workspaceId,
          ownerId,
          JSON.stringify({
            linkedin: {
              text: 'See https://shop.example/override\nFree shipping\nall week',
              mediaItems: [
                { url: 'https://cdn.example.test/o.png', type: 'image' },
              ],
            },
          }),
        ],
      );
      // The trigger already counted them; make them stale again.
      await client.query(
        `UPDATE saved_links SET usage_count = 9 WHERE id = $1`,
        [overrideLink],
      );
      await client.query(
        `UPDATE text_snippets SET usage_count = 9 WHERE id = ANY($1)`,
        [[multiLine, mediaToken]],
      );

      await applyMigrationAgain(client, MIGRATION);

      expect(await usage(client, 'media_items', item)).toBe(1);
      expect(await usage(client, 'saved_links', link)).toBe(1);
      expect(await usage(client, 'text_snippets', short)).toBe(0);
      expect(await usage(client, 'text_snippets', blank)).toBe(0);
      expect(await usage(client, 'saved_links', overrideLink)).toBe(1);
      expect(await usage(client, 'text_snippets', multiLine)).toBe(1);
      expect(await usage(client, 'text_snippets', mediaToken)).toBe(0);
    });
  });

  it('applies on a database without campaign_slot_content, and indexes it where present', async () => {
    await withLibraryDb(async (_db, client) => {
      const slotIndex = async () =>
        (
          await client.query(
            `SELECT 1 FROM pg_indexes WHERE indexname = 'campaign_slot_content_media_gin'`,
          )
        ).rowCount;
      expect(await slotIndex()).toBe(1);

      await client.query(`DROP INDEX campaign_slot_content_media_gin`);
      await client.query(
        `ALTER TABLE campaign_slot_content RENAME TO campaign_slot_content_away`,
      );
      await expect(
        applyMigrationAgain(client, MIGRATION),
      ).resolves.toBeUndefined();
      expect(await slotIndex()).toBe(0);
    });
  });

  it('a workspace delete cascades through its posts', async () => {
    await withLibraryDb(async (_db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const item = await seedMediaItem(client, {
        workspaceId,
        uploadedById: ownerId,
      });
      await seedLink(client, {
        workspaceId,
        createdById: ownerId,
        url: 'https://shop.example/gone',
      });
      await seedSnippet(client, {
        workspaceId,
        createdById: ownerId,
        content: 'Bye now',
      });
      await seedPost(client, {
        workspaceId,
        createdById: ownerId,
        content: 'Bye now https://shop.example/gone',
        mediaItems: [
          { url: 'https://cdn.example.test/g.png', libraryItemId: item },
        ],
      });

      await expect(
        client.query(`DELETE FROM workspace WHERE id = $1`, [workspaceId]),
      ).resolves.toBeDefined();
      const left = await client.query(
        `SELECT 1 FROM posts WHERE workspace_id = $1`,
        [workspaceId],
      );
      expect(left.rowCount).toBe(0);
    });
  });
});
