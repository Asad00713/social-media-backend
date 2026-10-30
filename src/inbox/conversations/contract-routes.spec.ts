/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Reflect metadata reads */
import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { RequestMethod } from '@nestjs/common';
import { REQUIRE_CAPABILITY } from '../../workspace-members/require-capability.decorator';

// The Inbox API contract route audit. Every controller under src is discovered
// from disk (the approach of every-workspace-route-guarded.spec.ts), and each
// contract route must exist EXACTLY ONCE across all of them, demanding EXACTLY
// the capability the contract names. A missing route, a duplicate (two
// controllers answering the same METHOD path) or a wrong capability fails.

const INBOX = '/inbox/workspaces/:workspaceId';
const AI = '/ai/workspaces/:workspaceId/inbox';

const CONTRACT: ReadonlyArray<readonly [route: string, capability: string]> = [
  [`GET ${INBOX}/conversations`, 'inbox:view'],
  [`GET ${INBOX}/conversations/counts`, 'inbox:view'],
  [`GET ${INBOX}/conversations/by-key/:threadKey`, 'inbox:view'],
  [`GET ${INBOX}/conversations/:id`, 'inbox:view'],
  [`GET ${INBOX}/conversations/:id/profile`, 'inbox:view'],
  [`PATCH ${INBOX}/conversations/:id`, 'inbox:reply'],
  [`POST ${INBOX}/conversations/bulk`, 'inbox:reply'],
  [`POST ${INBOX}/conversations/:id/read`, 'inbox:view'],
  [`POST ${INBOX}/conversations/:id/unread`, 'inbox:reply'],
  [`DELETE ${INBOX}/conversations/:id`, 'inbox:reply'],
  [`POST ${INBOX}/conversations/:id/restore`, 'inbox:reply'],
  [`POST ${INBOX}/conversations/:conversationId/notes`, 'inbox:reply'],
  [
    `DELETE ${INBOX}/conversations/:conversationId/notes/:noteId`,
    'inbox:reply',
  ],
  [`POST ${INBOX}/comments/:itemId/reply`, 'inbox:reply'],
  [`POST ${INBOX}/threads/:threadKey/comments`, 'inbox:reply'],
  [`POST ${INBOX}/dms/:threadKey/messages`, 'inbox:reply'],
  [`POST ${INBOX}/dms/:threadKey/template`, 'inbox:reply'],
  [`POST ${INBOX}/comments/:itemId/like`, 'inbox:reply'],
  [`POST ${INBOX}/comments/:itemId/hide`, 'inbox:reply'],
  [`DELETE ${INBOX}/comments/:itemId`, 'inbox:reply'],
  [`POST ${INBOX}/comments/:itemId/private-reply`, 'inbox:reply'],
  [`POST ${INBOX}/scheduled`, 'inbox:reply'],
  [`PATCH ${INBOX}/scheduled/:id`, 'inbox:reply'],
  [`POST ${INBOX}/scheduled/:id/send-now`, 'inbox:reply'],
  [`DELETE ${INBOX}/scheduled/:id`, 'inbox:reply'],
  [`POST ${INBOX}/scheduled/:id/restore`, 'inbox:reply'],
  [`GET ${INBOX}/saved-replies`, 'inbox:view'],
  [`POST ${INBOX}/saved-replies`, 'inbox:reply'],
  [`PATCH ${INBOX}/saved-replies/:id`, 'inbox:reply'],
  [`DELETE ${INBOX}/saved-replies/:id`, 'inbox:reply'],
  [`POST ${INBOX}/saved-replies/:id/restore`, 'inbox:reply'],
  [`POST ${INBOX}/saved-replies/:id/use`, 'inbox:reply'],
  [`GET ${INBOX}/settings`, 'inbox:view'],
  [`PUT ${INBOX}/settings`, 'inbox:view'],
  [`POST ${AI}/suggest-reply`, 'inbox:reply'],
  [`POST ${AI}/quick-replies`, 'inbox:reply'],
];

const SRC = path.resolve(__dirname, '../..');

function findControllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findControllerFiles(full));
    else if (entry.name.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

interface Route {
  key: string;
  owner: string;
  capability: unknown;
}

const asArray = (p: unknown): string[] =>
  (Array.isArray(p) ? p : [p ?? '']).map(String);
const join = (...parts: string[]) =>
  '/' +
  parts
    .map((s) => s.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');

function collectRoutes(): Route[] {
  const routes: Route[] = [];
  for (const file of findControllerFiles(SRC).sort()) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(file) as Record<string, unknown>;
    for (const exported of Object.values(mod)) {
      if (typeof exported !== 'function') continue;
      const ctrl = exported as any;
      // @Controller() always writes PATH_METADATA ('path') on the class.
      if (Reflect.getMetadata('path', ctrl) === undefined) continue;
      const proto = ctrl.prototype as Record<string, any>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const sub = Reflect.getMetadata('path', handler);
        const method = Reflect.getMetadata('method', handler);
        if (sub === undefined || method === undefined) continue;
        const capability =
          Reflect.getMetadata(REQUIRE_CAPABILITY, handler) ??
          Reflect.getMetadata(REQUIRE_CAPABILITY, ctrl);
        for (const base of asArray(Reflect.getMetadata('path', ctrl))) {
          for (const s of asArray(sub)) {
            const verb = RequestMethod[method as number] ?? String(method);
            routes.push({
              key: `${verb} ${join(base, s)}`,
              owner: `${ctrl.name}.${name}`,
              capability,
            });
          }
        }
      }
    }
  }
  return routes;
}

describe('Inbox API contract routes', () => {
  const routes = collectRoutes();

  it('the table holds the 36 contract routes, each listed once', () => {
    expect(CONTRACT).toHaveLength(36);
    expect(new Set(CONTRACT.map(([r]) => r)).size).toBe(36);
  });

  it.each(CONTRACT)(
    '%s exists exactly once and demands %s',
    (route, capability) => {
      const found = routes
        .filter((r) => r.key === route)
        .map((r) => ({ owner: r.owner, capability: r.capability }));
      expect(found).toHaveLength(1);
      expect(found[0].capability).toBe(capability);
    },
  );
});
