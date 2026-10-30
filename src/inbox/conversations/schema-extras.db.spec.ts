import type { PoolClient } from 'pg';
import {
  describeInboxDb,
  seedChannel,
  seedWorkspace,
  withInboxDb,
} from '../testing/inbox-db';

async function expectCode(
  client: PoolClient,
  code: string,
  fn: () => Promise<unknown>,
) {
  await client.query('SAVEPOINT s');
  await expect(fn()).rejects.toMatchObject({ code });
  await client.query('ROLLBACK TO SAVEPOINT s');
}

async function seedConv(client: PoolClient, w: string, ch: number) {
  const r = await client.query<{ id: string }>(
    `INSERT INTO inbox_conversations
       (workspace_id, channel_id, platform, kind, thread_key, last_message_at)
     VALUES ($1,$2,'facebook','dm',$3,now()) RETURNING id`,
    [w, ch, `${ch}:k`],
  );
  return r.rows[0].id;
}

const insertReply = (
  client: PoolClient,
  w: string,
  shortcut: string,
  body = 'hi',
) =>
  client.query(
    `INSERT INTO inbox_saved_replies (workspace_id, name, shortcut, body)
     VALUES ($1,'Name',$2,$3) RETURNING id`,
    [w, shortcut, body],
  );

describeInboxDb(
  'inbox notes, saved replies, settings, scheduled columns',
  () => {
    it('rejects a note body over 5000 chars and an empty one', () =>
      withInboxDb(async (_db, client) => {
        const { workspaceId } = await seedWorkspace(client);
        const ch = await seedChannel(client, workspaceId, 'facebook');
        const conv = await seedConv(client, workspaceId, ch);
        const ins = (body: string) =>
          client.query(
            `INSERT INTO inbox_notes (conversation_id, workspace_id, body)
           VALUES ($1,$2,$3)`,
            [conv, workspaceId, body],
          );
        await expectCode(client, '23514', () => ins('x'.repeat(5001)));
        await expectCode(client, '23514', () => ins(''));
        await ins('x'.repeat(5000));
      }));

    it('rejects a bad shortcut and enforces live-only uniqueness', () =>
      withInboxDb(async (_db, client) => {
        const a = await seedWorkspace(client);
        const b = await seedWorkspace(client);
        await expectCode(client, '23514', () =>
          insertReply(client, a.workspaceId, 'Hello'),
        );
        const first = await insertReply(client, a.workspaceId, 'thanks');
        await expectCode(client, '23505', () =>
          insertReply(client, a.workspaceId, 'thanks'),
        );
        await insertReply(client, b.workspaceId, 'thanks');
        await client.query(
          `UPDATE inbox_saved_replies SET deleted_at = now() WHERE id = $1`,
          [first.rows[0].id],
        );
        await insertReply(client, a.workspaceId, 'thanks');
      }));

    it('gives inbox_user_settings its five defaults and checks enums', () =>
      withInboxDb(async (_db, client) => {
        const { workspaceId, ownerId } = await seedWorkspace(client);
        const r = await client.query(
          `INSERT INTO inbox_user_settings (user_id, workspace_id)
         VALUES ($1,$2) RETURNING *`,
          [ownerId, workspaceId],
        );
        expect(r.rows[0]).toMatchObject({
          mark_done_on_reply: true,
          default_later: 'tomorrow',
          notify: 'assigned_and_mentions',
          reply_window_warnings: true,
          ai_quick_replies: true,
        });
        await expectCode(client, '23514', () =>
          client.query(
            `UPDATE inbox_user_settings SET notify = 'loud' WHERE user_id = $1`,
            [ownerId],
          ),
        );
        await expectCode(client, '23514', () =>
          client.query(
            `UPDATE inbox_user_settings SET default_later = 'never' WHERE user_id = $1`,
            [ownerId],
          ),
        );
      }));

    it('deleting a conversation cascades notes and nulls the scheduled link', () =>
      withInboxDb(async (_db, client) => {
        const { workspaceId } = await seedWorkspace(client);
        const ch = await seedChannel(client, workspaceId, 'facebook');
        const conv = await seedConv(client, workspaceId, ch);
        await client.query(
          `INSERT INTO inbox_notes (conversation_id, workspace_id, body)
         VALUES ($1,$2,'n')`,
          [conv, workspaceId],
        );
        const s = await client.query<{ id: string; attachments: unknown }>(
          `INSERT INTO scheduled_inbox_messages
           (workspace_id, channel_id, type, thread_key, text, scheduled_at,
            inbox_conversation_id)
         VALUES ($1,$2,'dm','k','t',now(),$3) RETURNING id, attachments`,
          [workspaceId, ch, conv],
        );
        expect(s.rows[0].attachments).toEqual([]);
        await client.query(`DELETE FROM inbox_conversations WHERE id = $1`, [
          conv,
        ]);
        const notes = await client.query(
          `SELECT 1 FROM inbox_notes WHERE conversation_id = $1`,
          [conv],
        );
        expect(notes.rowCount).toBe(0);
        const sched = await client.query(
          `SELECT inbox_conversation_id FROM scheduled_inbox_messages WHERE id = $1`,
          [s.rows[0].id],
        );
        expect(sched.rows[0].inbox_conversation_id).toBeNull();
      }));
  },
);
