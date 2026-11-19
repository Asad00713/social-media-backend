import { HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { PoolClient } from 'pg';
import { seedWorkspace } from '../inbox/testing/inbox-db';
import { describeDb, withRollbackDb } from '../planner/testing/rollback-db';
import { CloudflareR2Service } from '../media/cloudflare-r2.service';
import { WorkspaceService } from './workspace.service';

// 0091 adds the workspace columns this service selects and writes. The
// harness applies each file twice, so it must stay idempotent.
const MIGRATIONS = ['0091_workspace_settings.sql'];

// A real R2 service with a fixed public base: the own-URL rule runs for real
// and nothing ever leaves the process (no key means no client call is made).
const PUBLIC_BASE = 'https://cdn.test';
const r2 = new CloudflareR2Service({
  get: (name: string, fallback?: string) =>
    ({
      CLOUDFLARE_R2_ACCOUNT_ID: 'acct',
      CLOUDFLARE_R2_ACCESS_KEY_ID: 'key',
      CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'secret',
      CLOUDFLARE_R2_BUCKET: 'bucket',
      CLOUDFLARE_R2_PUBLIC_URL: PUBLIC_BASE,
    })[name] ?? fallback,
} as unknown as ConfigService);

function makeService(db: never): WorkspaceService {
  return new WorkspaceService(
    db,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    r2,
    // The time-zone move has its own DB spec.
    {} as never,
    {} as never,
  );
}

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

async function row(client: PoolClient, id: string) {
  const r = await client.query<{
    name: string;
    slug: string;
    logo: string | null;
    approval_policy: string;
    shorten_links_default: boolean;
    utm_default: boolean;
    timezone: string;
  }>(`SELECT * FROM workspace WHERE id = $1`, [id]);
  return r.rows[0];
}

describeDb('WorkspaceService General (database)', () => {
  it('updates the name and slug with no owner check: the route guard decides', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws } = await seedWorkspace(client);
      const svc = makeService(db as never);

      const { workspace, timezoneMove } = await svc.update(ws, { name: 'New' });

      expect(workspace).toMatchObject({ id: ws, name: 'New' });
      expect(timezoneMove).toBeNull();
      const saved = await row(client, ws);
      expect(saved.name).toBe('New');
      expect(saved.slug).toBe('new');
    });
  });

  it('refuses a logo that is not one of our uploads and leaves the row alone', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws } = await seedWorkspace(client);
      const svc = makeService(db as never);

      for (const logo of [
        'https://evil.test/workspace-logos/x.png',
        `${PUBLIC_BASE}/avatars/u/1-a.png`,
        `${PUBLIC_BASE}/workspace-logos/${ws}/u/1-a.png?x=1`,
        `${PUBLIC_BASE}/workspace-logos/%2e%2e/avatars/u/1-a.png`,
        `${PUBLIC_BASE}/workspace-logos/${randomUUID()}/u/1-${'a'.repeat(24)}.png`,
      ]) {
        expect(await failure(svc.update(ws, { logo }))).toEqual({
          status: 400,
          code: 'LOGO_NOT_UPLOADED',
        });
      }
      expect((await row(client, ws)).logo).toBeNull();
    });
  });

  it('saves a logo from our own bucket and null clears it', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws } = await seedWorkspace(client);
      const svc = makeService(db as never);
      const own = `${PUBLIC_BASE}/workspace-logos/${ws}/u/1-${'a'.repeat(24)}.png`;

      await svc.update(ws, { logo: own });
      expect((await row(client, ws)).logo).toBe(own);

      await svc.update(ws, { logo: null });
      expect((await row(client, ws)).logo).toBeNull();
    });
  });

  it('refuses applyTimezoneToChannels without a timezone and changes nothing', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws } = await seedWorkspace(client);
      const svc = makeService(db as never);

      expect(
        await failure(
          svc.update(ws, { name: 'Renamed', applyTimezoneToChannels: true }),
        ),
      ).toEqual({ status: 400, code: 'TIMEZONE_REQUIRED' });
      expect((await row(client, ws)).name).toBe('Inbox WS');
    });
  });

  it('stores the publishing defaults and reads them back', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws } = await seedWorkspace(client);
      const svc = makeService(db as never);

      // What a workspace had before the setting existed.
      expect(await svc.getPublishingDefaults(ws)).toEqual({
        approvalPolicy: 'none',
        shortenLinksDefault: false,
        utmDefault: false,
      });

      await svc.update(ws, {
        approvalPolicy: 'members',
        shortenLinksDefault: true,
        utmDefault: true,
      });

      expect(await svc.getPublishingDefaults(ws)).toEqual({
        approvalPolicy: 'members',
        shortenLinksDefault: true,
        utmDefault: true,
      });
      expect(await row(client, ws)).toMatchObject({
        approval_policy: 'members',
        shorten_links_default: true,
        utm_default: true,
      });
    });
  });

  it('findDetail returns ownerName and never the Maestro key or the invite code', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      await client.query(
        `UPDATE workspace
            SET maestro_anthropic_key = 'enc-secret',
                invite_link_code = 'join-code-1'
          WHERE id = $1`,
        [ws],
      );
      const svc = makeService(db as never);

      const detail = await svc.findDetail(ws);

      expect(detail).toMatchObject({
        id: ws,
        ownerId,
        ownerName: 'Owner',
        owner: { id: ownerId, name: 'Owner' },
        approvalPolicy: 'none',
        shortenLinksDefault: false,
        utmDefault: false,
      });
      expect(detail).not.toHaveProperty('maestroAnthropicKey');
      expect(detail).not.toHaveProperty('inviteLinkCode');
      expect(JSON.stringify(detail)).not.toContain('enc-secret');
      expect(JSON.stringify(detail)).not.toContain('join-code-1');
    });
  });

  it('ownerName falls back to the owner email when the owner has no name', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      await client.query(`UPDATE users SET name = NULL WHERE id = $1`, [
        ownerId,
      ]);
      const svc = makeService(db as never);

      const detail = await svc.findDetail(ws);

      expect(detail.owner.name).toBeNull();
      expect(detail.ownerName).toBe(detail.owner.email);
    });
  });

  it('findDetail keeps the suspended check and 404s an unknown workspace', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws } = await seedWorkspace(client);
      const svc = makeService(db as never);

      expect(
        (await failure(svc.findDetail('00000000-0000-4000-8000-000000000000')))
          .status,
      ).toBe(404);

      await client.query(
        `UPDATE workspace SET is_active = false, suspended_reason = 'manual' WHERE id = $1`,
        [ws],
      );
      expect((await failure(svc.findDetail(ws))).status).toBe(403);
    });
  });
});
