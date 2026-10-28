import { describeInboxDb, withInboxDb } from '../testing/inbox-db';

describeInboxDb('notification_type enum (0053)', () => {
  it('holds the three inbox notification types', async () => {
    await withInboxDb(async (_db, client) => {
      const { rows } = await client.query<{ enumlabel: string }>(
        `SELECT e.enumlabel FROM pg_enum e
           JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'notification_type'`,
      );
      const labels = rows.map((r) => r.enumlabel);
      expect(labels).toEqual(
        expect.arrayContaining([
          'inbox_assigned',
          'inbox_note_mention',
          'inbox_new_message',
        ]),
      );
    });
  });
});
