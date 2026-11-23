import { HttpException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { FirstWeekRepository } from '../first-week/first-week.repository';
import { seedWorkspace } from '../inbox/testing/inbox-db';
import { describeDb, withRollbackDb } from '../planner/testing/rollback-db';
import { DEFAULT_BRAND_VOICE_FIELDS } from './brand-voice.types';
import { BrandVoiceService } from './brand-voice.service';

// 0040: workspace_brand_profiles, which a brand-voice save must not touch.
// 0057: text_snippets.is_sample, which "Use saved groups" filters on.
const MIGRATIONS = [
  '0040_home_first_week.sql',
  '0057_library_is_sample.sql',
  '0101_brand_voice.sql',
];

/** Resolves to the HTTP status and machine code the promise rejected with. */
async function failure(
  p: Promise<unknown>,
): Promise<{ status: number; code?: string }> {
  try {
    await p;
  } catch (err) {
    if (!(err instanceof HttpException)) throw err;
    const body = err.getResponse() as { code?: string };
    return { status: err.getStatus(), code: body.code };
  }
  throw new Error('expected the call to fail');
}

interface StoredRow {
  tone: string[];
  description: string | null;
  words_use: string[];
  emoji_level: string | null;
  hashtags_mode: string | null;
  version: number;
  previous: Record<string, unknown> | null;
}

async function storedRow(
  client: PoolClient,
  workspaceId: string,
): Promise<StoredRow | null> {
  const r = await client.query<StoredRow>(
    `SELECT tone, description, words_use, emoji_level, hashtags_mode, version,
            previous
       FROM workspace_brand_voice WHERE workspace_id = $1`,
    [workspaceId],
  );
  return r.rows[0] ?? null;
}

async function seedSnippet(
  client: PoolClient,
  workspaceId: string,
  createdById: string | null,
  content: string,
  opts: {
    type?: string;
    starred?: boolean;
    sample?: boolean;
    deleted?: boolean;
    usage?: number;
    ageDays?: number;
  } = {},
): Promise<void> {
  await client.query(
    `INSERT INTO text_snippets
       (workspace_id, created_by_id, name, snippet_type, content,
        is_starred, is_sample, is_deleted, usage_count, created_at)
     VALUES ($1, $2, 'Snippet', $3, $4, $5, $6, $7, $8,
             now() - make_interval(days => $9))`,
    [
      workspaceId,
      createdById,
      opts.type ?? 'hashtags',
      content,
      opts.starred ?? false,
      opts.sample ?? false,
      opts.deleted ?? false,
      opts.usage ?? 0,
      opts.ageDays ?? 0,
    ],
  );
}

const BRAND = {
  sells: 'Candles',
  voice: ['warm', 'bold'],
  audience: 'gift buyers',
};

describeDb('BrandVoiceService (database)', () => {
  it('get answers the defaults at version 1 for a workspace with no row, and creates none', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws } = await seedWorkspace(client);
      const svc = new BrandVoiceService(db);

      expect(await svc.get(ws)).toEqual({
        ...DEFAULT_BRAND_VOICE_FIELDS,
        version: 1,
        hasVoice: false,
      });
      expect(await storedRow(client, ws)).toBeNull();
    });
  });

  it('the first save on a missing row needs version 1, answers version 2 and keeps the defaults as previous', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws } = await seedWorkspace(client);
      const svc = new BrandVoiceService(db);

      const saved = await svc.update(ws, { version: 1, tone: ['Warm'] });
      expect(saved).toEqual({
        ...DEFAULT_BRAND_VOICE_FIELDS,
        tone: ['Warm'],
        version: 2,
        hasVoice: true,
      });
      const row = await storedRow(client, ws);
      expect(row).toMatchObject({ tone: ['Warm'], version: 2 });
      expect(row?.previous).toEqual(DEFAULT_BRAND_VOICE_FIELDS);
      expect(await svc.get(ws)).toEqual(saved);
    });
  });

  it('a save on a fresh workspace leaves first-week alone', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws } = await seedWorkspace(client);
      const svc = new BrandVoiceService(db);

      await svc.update(ws, { version: 1, description: 'Hand-poured candles' });

      const profiles = await client.query(
        `SELECT 1 FROM workspace_brand_profiles WHERE workspace_id = $1`,
        [ws],
      );
      expect(profiles.rowCount).toBe(0);
      await expect(
        new FirstWeekRepository(db).insertProfileIfAbsent(ws, {
          source: 'posts',
          status: 'reading',
        }),
      ).resolves.toBe(true);
    });
  });

  it('a stale version is 409 VERSION_CONFLICT and changes nothing', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws } = await seedWorkspace(client);
      const svc = new BrandVoiceService(db);
      await svc.update(ws, { version: 1, tone: ['Warm'] });
      await svc.update(ws, { version: 2, tone: ['Calm'] });
      const before = await storedRow(client, ws);

      expect(
        await failure(svc.update(ws, { version: 2, tone: ['Bold'] })),
      ).toEqual({ status: 409, code: 'VERSION_CONFLICT' });
      expect(await storedRow(client, ws)).toEqual(before);
      expect(before).toMatchObject({ tone: ['Calm'], version: 3 });
    });
  });

  it('two saves with the same version: the first wins, the second is 409', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws } = await seedWorkspace(client);
      const svc = new BrandVoiceService(db);

      // Both read the missing row at version 1.
      await svc.update(ws, { version: 1, tone: ['Warm'] });
      expect(
        await failure(svc.update(ws, { version: 1, tone: ['Bold'] })),
      ).toEqual({ status: 409, code: 'VERSION_CONFLICT' });

      // Both read the row at version 2.
      await svc.update(ws, { version: 2, emojiLevel: 'none' });
      expect(
        await failure(svc.update(ws, { version: 2, emojiLevel: 'lots' })),
      ).toEqual({ status: 409, code: 'VERSION_CONFLICT' });

      expect(await storedRow(client, ws)).toMatchObject({
        tone: ['Warm'],
        emoji_level: 'none',
        version: 3,
      });
    });
  });

  it('a missing row with version 2 is 409', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws } = await seedWorkspace(client);
      const svc = new BrandVoiceService(db);

      expect(
        await failure(svc.update(ws, { version: 2, tone: ['Warm'] })),
      ).toEqual({ status: 409, code: 'VERSION_CONFLICT' });
      expect(await storedRow(client, ws)).toBeNull();
    });
  });

  it('a body with only the version is 400 NOTHING_TO_SAVE', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws } = await seedWorkspace(client);
      const svc = new BrandVoiceService(db);

      expect(await failure(svc.update(ws, { version: 1 }))).toEqual({
        status: 400,
        code: 'NOTHING_TO_SAVE',
      });
      expect(await storedRow(client, ws)).toBeNull();
    });
  });

  it('a partial save keeps the other fields and snapshots the old ones in previous', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws } = await seedWorkspace(client);
      const svc = new BrandVoiceService(db);
      await svc.update(ws, { version: 1, tone: ['Warm', 'Clear'] });

      const saved = await svc.update(ws, { version: 2, emojiLevel: 'none' });
      expect(saved).toMatchObject({
        tone: ['Warm', 'Clear'],
        emojiLevel: 'none',
        version: 3,
      });
      const row = await storedRow(client, ws);
      expect(row?.previous).toEqual({
        ...DEFAULT_BRAND_VOICE_FIELDS,
        tone: ['Warm', 'Clear'],
      });
      expect(row?.previous?.emojiLevel).toBeNull();
    });
  });

  it('emoji and hashtags start not set; previous and Undo keep null; a null save resets a choice', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws } = await seedWorkspace(client);
      const svc = new BrandVoiceService(db);

      await svc.update(ws, { version: 1, tone: ['Warm'] });
      expect(await storedRow(client, ws)).toMatchObject({
        emoji_level: null,
        hashtags_mode: null,
      });

      await svc.update(ws, {
        version: 2,
        emojiLevel: 'lots',
        hashtagsMode: 'many',
      });
      expect((await storedRow(client, ws))?.previous).toMatchObject({
        emojiLevel: null,
        hashtagsMode: null,
      });
      // Undo goes back to not set, not to a default.
      expect(await svc.revert(ws, 3)).toMatchObject({
        emojiLevel: null,
        hashtagsMode: null,
        version: 4,
      });

      await svc.update(ws, { version: 4, emojiLevel: 'none' });
      const reset = await svc.update(ws, { version: 5, emojiLevel: null });
      expect(reset).toMatchObject({ emojiLevel: null, version: 6 });
      const row = await storedRow(client, ws);
      expect(row?.emoji_level).toBeNull();
      expect(row?.previous).toMatchObject({ emojiLevel: 'none' });
    });
  });

  it('stores tone in canonical order and words deduped', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws } = await seedWorkspace(client);
      const svc = new BrandVoiceService(db);

      const saved = await svc.update(ws, {
        version: 1,
        tone: ['Friendly', 'Warm', 'Bold'],
        wordsUse: ['  hand  poured ', 'Hand poured', '', 'cosy'],
      });
      expect(saved.tone).toEqual(['Warm', 'Bold', 'Friendly']);
      expect(saved.wordsUse).toEqual(['hand poured', 'cosy']);
      expect(await storedRow(client, ws)).toMatchObject({
        tone: ['Warm', 'Bold', 'Friendly'],
        words_use: ['hand poured', 'cosy'],
      });
    });
  });

  it('revert restores previous, bumps the version and leaves nothing to undo', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws } = await seedWorkspace(client);
      const svc = new BrandVoiceService(db);
      await svc.update(ws, { version: 1, tone: ['Warm'], description: 'Old' });
      const saved = await svc.update(ws, {
        version: 2,
        tone: ['Bold'],
        description: 'New',
        emojiLevel: 'lots',
      });

      const reverted = await svc.revert(ws, saved.version);
      expect(reverted).toEqual({
        ...DEFAULT_BRAND_VOICE_FIELDS,
        tone: ['Warm'],
        description: 'Old',
        version: 4,
        hasVoice: true,
      });
      expect((await storedRow(client, ws))?.previous).toBeNull();

      expect(await failure(svc.revert(ws, 4))).toEqual({
        status: 409,
        code: 'NOTHING_TO_UNDO',
      });
    });
  });

  it('revert with no row is 409 NOTHING_TO_UNDO', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws } = await seedWorkspace(client);
      const svc = new BrandVoiceService(db);

      expect(await failure(svc.revert(ws, 1))).toEqual({
        status: 409,
        code: 'NOTHING_TO_UNDO',
      });
      expect(await storedRow(client, ws)).toBeNull();
    });
  });

  it('revert after a newer save is 409 VERSION_CONFLICT', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws } = await seedWorkspace(client);
      const svc = new BrandVoiceService(db);
      const first = await svc.update(ws, { version: 1, tone: ['Warm'] });
      await svc.update(ws, { version: first.version, tone: ['Calm'] });
      const before = await storedRow(client, ws);

      expect(await failure(svc.revert(ws, first.version))).toEqual({
        status: 409,
        code: 'VERSION_CONFLICT',
      });
      expect(await storedRow(client, ws)).toEqual(before);
    });
  });

  it('seedFromBrand fills only empty tone and description and bumps the version', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws } = await seedWorkspace(client);
      const svc = new BrandVoiceService(db);
      await svc.update(ws, { version: 1, wordsUse: ['cosy'] });

      await svc.seedFromBrand(ws, BRAND, { sourcePlatform: 'instagram' });
      const row = await storedRow(client, ws);
      expect(row).toMatchObject({
        tone: ['Warm', 'Bold'],
        description: 'Candles for gift buyers',
        words_use: ['cosy'],
        version: 3,
      });
      // The seed is not a save: Undo still goes back to the defaults.
      expect(row?.previous).toEqual(DEFAULT_BRAND_VOICE_FIELDS);

      // Tone set, description cleared: only the description is filled.
      await svc.update(ws, { version: 3, tone: ['Calm'], description: null });
      await svc.seedFromBrand(ws, BRAND, { sourcePlatform: null });
      expect(await storedRow(client, ws)).toMatchObject({
        tone: ['Calm'],
        description: 'Candles for gift buyers',
        version: 5,
      });
    });
  });

  it('seedFromBrand leaves fields a person set, and creates the row when there is none', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const svc = new BrandVoiceService(db);

      const set = await seedWorkspace(client);
      await svc.update(set.workspaceId, {
        version: 1,
        tone: ['Calm'],
        description: 'Mine',
      });
      await svc.seedFromBrand(set.workspaceId, BRAND, { sourcePlatform: null });
      expect(await storedRow(client, set.workspaceId)).toMatchObject({
        tone: ['Calm'],
        description: 'Mine',
        version: 2,
      });

      const fresh = await seedWorkspace(client);
      await svc.seedFromBrand(fresh.workspaceId, BRAND, {
        sourcePlatform: null,
      });
      expect(await storedRow(client, fresh.workspaceId)).toMatchObject({
        tone: ['Warm', 'Bold'],
        description: 'Candles for gift buyers',
        emoji_level: null,
        hashtags_mode: null,
        version: 2,
        previous: null,
      });
    });
  });

  it('after a seed on a fresh workspace a save at version 1 is 409 VERSION_CONFLICT', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws } = await seedWorkspace(client);
      const svc = new BrandVoiceService(db);
      await svc.seedFromBrand(ws, BRAND, { sourcePlatform: null });

      expect(
        await failure(svc.update(ws, { version: 1, tone: ['Bold'] })),
      ).toEqual({ status: 409, code: 'VERSION_CONFLICT' });
      expect(await storedRow(client, ws)).toMatchObject({
        tone: ['Warm', 'Bold'],
        version: 2,
      });
    });
  });

  it('a seed stored in voice order is answered in canonical tone order', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws } = await seedWorkspace(client);
      const svc = new BrandVoiceService(db);
      await svc.seedFromBrand(
        ws,
        { sells: 'Candles', voice: ['bold', 'warm'], audience: null },
        { sourcePlatform: null },
      );

      expect((await storedRow(client, ws))?.tone).toEqual(['Bold', 'Warm']);
      expect((await svc.get(ws)).tone).toEqual(['Warm', 'Bold']);
      expect((await svc.loadPromptSource(ws)).voice.tone).toEqual([
        'Warm',
        'Bold',
      ]);
      // The next save snapshots the canonical order too.
      await svc.update(ws, { version: 2, emojiLevel: 'none' });
      expect((await storedRow(client, ws))?.previous?.tone).toEqual([
        'Warm',
        'Bold',
      ]);
    });
  });

  it('seedFromBrand writes nothing for a Threads-learned brand or an empty seed', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const svc = new BrandVoiceService(db);

      const threads = await seedWorkspace(client);
      await svc.seedFromBrand(threads.workspaceId, BRAND, {
        sourcePlatform: 'threads',
      });
      expect(await storedRow(client, threads.workspaceId)).toBeNull();

      const empty = await seedWorkspace(client);
      await svc.seedFromBrand(
        empty.workspaceId,
        { sells: '  ', voice: ['zesty'], audience: 'everyone' },
        { sourcePlatform: null },
      );
      expect(await storedRow(client, empty.workspaceId)).toBeNull();

      // An existing row is not bumped by an empty seed either.
      await svc.update(empty.workspaceId, { version: 1, wordsUse: ['cosy'] });
      await svc.seedFromBrand(
        empty.workspaceId,
        { sells: null, voice: [], audience: null },
        { sourcePlatform: null },
      );
      expect((await storedRow(client, empty.workspaceId))?.version).toBe(2);
    });
  });

  it("saved groups: only this workspace's live, non-sample hashtag snippets, starred first", async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const other = await seedWorkspace(client);
      // '#b' is newer and more used, so only "starred first" puts '#a' ahead.
      await seedSnippet(client, ws, ownerId, '#a', {
        starred: true,
        ageDays: 3,
      });
      await seedSnippet(client, ws, ownerId, '#b', { usage: 9 });
      await seedSnippet(client, ws, null, '#sample', {
        sample: true,
        usage: 99,
      });
      await seedSnippet(client, ws, ownerId, '#gone', {
        deleted: true,
        usage: 99,
      });
      await seedSnippet(client, ws, ownerId, '#cap', {
        type: 'caption',
        usage: 99,
      });
      await seedSnippet(client, other.workspaceId, other.ownerId, '#other', {
        usage: 99,
      });
      const svc = new BrandVoiceService(db);
      await svc.update(ws, {
        version: 1,
        tone: ['Warm'],
        hashtagsMode: 'saved_groups',
      });

      const source = await svc.loadPromptSource(ws);
      expect(source.savedHashtags).toEqual(['#a', '#b']);
      expect(source.voice).toMatchObject({
        tone: ['Warm'],
        hashtagsMode: 'saved_groups',
      });
      expect(await svc.promptFor(ws)).toContain('#a #b');
    });
  });

  it('loads no snippets unless the mode is saved_groups', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      await seedSnippet(client, ws, ownerId, '#a');
      const svc = new BrandVoiceService(db);

      await svc.update(ws, { version: 1, tone: ['Warm'], hashtagsMode: 'few' });
      expect((await svc.loadPromptSource(ws)).savedHashtags).toEqual([]);

      // saved_groups without a voice is no voice: nothing is read.
      const bare = await seedWorkspace(client);
      await seedSnippet(client, bare.workspaceId, bare.ownerId, '#b');
      await svc.update(bare.workspaceId, {
        version: 1,
        hashtagsMode: 'saved_groups',
      });
      expect(
        (await svc.loadPromptSource(bare.workspaceId)).savedHashtags,
      ).toEqual([]);
    });
  });

  it('promptFor is empty for a workspace with no row', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws } = await seedWorkspace(client);
      const svc = new BrandVoiceService(db);

      expect(await svc.promptFor(ws)).toBe('');
      expect(await svc.loadPromptSource(ws)).toEqual({
        voice: DEFAULT_BRAND_VOICE_FIELDS,
        savedHashtags: [],
      });
      expect(await storedRow(client, ws)).toBeNull();
    });
  });
});
