import { NotFoundException } from '@nestjs/common';
import { describeDb, withRollbackDb } from '../../planner/testing/rollback-db';
import { seedChannel, seedWorkspace } from '../../inbox/testing/inbox-db';
import { ChannelSettingsService } from './channel-settings.service';

const MIGRATIONS = [
  '0063_channel_pause_and_network_requests.sql',
  '0064_channel_nickname_sidebar.sql',
];

describeDb('ChannelSettingsService (database)', () => {
  it('sets, keeps and clears the nickname and the sidebar pin', () =>
    withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws } = await seedWorkspace(client);
      const ch = await seedChannel(client, ws, 'bluesky', {
        accountName: 'Daybreak Coffee Roasters LLC',
      });
      const svc = new ChannelSettingsService(db);

      const fresh = await svc.update(ws, ch, {});
      expect(fresh).toMatchObject({
        id: ch,
        nickname: null,
        displayName: 'Daybreak Coffee Roasters LLC',
        showInSidebar: false,
      });
      // The response never carries tokens.
      expect(fresh).not.toHaveProperty('accessToken');
      expect(fresh).not.toHaveProperty('refreshToken');

      const named = await svc.update(ws, ch, { nickname: 'Daybreak' });
      expect(named).toMatchObject({
        nickname: 'Daybreak',
        displayName: 'Daybreak',
        showInSidebar: false,
      });

      // A field left out is left as it is.
      const pinned = await svc.update(ws, ch, { showInSidebar: true });
      expect(pinned).toMatchObject({
        nickname: 'Daybreak',
        showInSidebar: true,
      });

      // A reconnect rewrites account_name; the nickname survives it.
      await client.query(
        `UPDATE social_media_channels SET account_name = 'Renamed on Bluesky' WHERE id = $1`,
        [ch],
      );
      const afterReconnect = await svc.update(ws, ch, {});
      expect(afterReconnect).toMatchObject({
        accountName: 'Renamed on Bluesky',
        displayName: 'Daybreak',
      });

      const cleared = await svc.update(ws, ch, { nickname: null });
      expect(cleared).toMatchObject({
        nickname: null,
        displayName: 'Renamed on Bluesky',
        showInSidebar: true,
      });

      const stored = await client.query<{
        nickname: string | null;
        show_in_sidebar: boolean;
      }>(
        `SELECT nickname, show_in_sidebar FROM social_media_channels WHERE id = $1`,
        [ch],
      );
      expect(stored.rows[0]).toEqual({ nickname: null, show_in_sidebar: true });
    }));

  it('a channel of another workspace is a 404 and is left untouched', () =>
    withRollbackDb(MIGRATIONS, async (db, client) => {
      const mine = await seedWorkspace(client);
      const theirs = await seedWorkspace(client);
      const foreign = await seedChannel(client, theirs.workspaceId, 'bluesky');
      const svc = new ChannelSettingsService(db);

      for (const dto of [{ nickname: 'Mine now' }, {}]) {
        await expect(
          svc.update(mine.workspaceId, foreign, dto),
        ).rejects.toBeInstanceOf(NotFoundException);
      }
      await expect(
        svc.update(mine.workspaceId, 987654321, { showInSidebar: true }),
      ).rejects.toBeInstanceOf(NotFoundException);

      const stored = await client.query<{ nickname: string | null }>(
        `SELECT nickname FROM social_media_channels WHERE id = $1`,
        [foreign],
      );
      expect(stored.rows[0].nickname).toBeNull();
    }));

  it('the CHECK refuses a blank or over-long nickname written past the API', () =>
    withRollbackDb(MIGRATIONS, async (_db, client) => {
      const { workspaceId: ws } = await seedWorkspace(client);
      const ch = await seedChannel(client, ws, 'bluesky');
      const write = async (nickname: string) => {
        await client.query('SAVEPOINT nick');
        try {
          await client.query(
            `UPDATE social_media_channels SET nickname = $2 WHERE id = $1`,
            [ch, nickname],
          );
          await client.query('RELEASE SAVEPOINT nick');
          return 'ok';
        } catch (e) {
          await client.query('ROLLBACK TO SAVEPOINT nick');
          return (e as { code?: string }).code;
        }
      };
      expect(await write('   ')).toBe('23514'); // check_violation
      expect(await write('')).toBe('23514');
      expect(await write('x'.repeat(81))).toBe('22001'); // varchar(80)
      expect(await write(' Daybreak ')).toBe('ok');

      const def = await client.query<{ show_in_sidebar: boolean }>(
        `SELECT show_in_sidebar FROM social_media_channels WHERE id = $1`,
        [ch],
      );
      expect(def.rows[0].show_in_sidebar).toBe(false);
    }));
});
