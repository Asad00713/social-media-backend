/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Reflect metadata reads */
import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { REQUIRE_CAPABILITY } from '../require-capability.decorator';

/**
 * Every route of every controller under `src`, read from Nest's decorator
 * metadata. Controllers are discovered from disk, so a new controller is
 * covered without anyone editing a list. Shared by the route specs
 * (every-workspace-route-guarded, media-library contract-routes).
 */

export interface ControllerRoute {
  /** `METHOD /full/path`, e.g. `GET /workspaces/:workspaceId/media-library/stats`. */
  key: string;
  controller: string;
  handler: string;
  fullPath: string;
  /** Class guards, then handler guards. */
  guards: unknown[];
  /** The handler's `@RequireCapability`, else the class's. */
  capability: unknown;
}

const SRC = path.resolve(__dirname, '..', '..');

function findControllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findControllerFiles(full));
    else if (entry.name.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

const asArray = (p: unknown): string[] =>
  (Array.isArray(p) ? p : [p ?? '']).map(String);

/** Joins path segments the way Nest does: one slash between, one in front. */
export const joinPath = (...parts: string[]): string =>
  '/' +
  parts
    .map((s) => s.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');

/** The routes one controller class declares. */
export function routesOfController(ctrl: any): ControllerRoute[] {
  const routes: ControllerRoute[] = [];
  const proto = ctrl.prototype as Record<string, any>;
  for (const name of Object.getOwnPropertyNames(proto)) {
    const handler = proto[name];
    if (name === 'constructor' || typeof handler !== 'function') continue;
    const sub = Reflect.getMetadata('path', handler);
    const method = Reflect.getMetadata('method', handler);
    if (sub === undefined || method === undefined) continue;
    const guards = [
      ...((Reflect.getMetadata(GUARDS_METADATA, ctrl) as unknown[]) ?? []),
      ...((Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[]) ?? []),
    ];
    const capability =
      Reflect.getMetadata(REQUIRE_CAPABILITY, handler) ??
      Reflect.getMetadata(REQUIRE_CAPABILITY, ctrl);
    for (const base of asArray(Reflect.getMetadata('path', ctrl))) {
      for (const s of asArray(sub)) {
        const fullPath = joinPath(base, s);
        const verb = RequestMethod[method as number] ?? String(method);
        routes.push({
          key: `${verb} ${fullPath}`,
          controller: ctrl.name,
          handler: name,
          fullPath,
          guards,
          capability,
        });
      }
    }
  }
  return routes;
}

/** Every controller under `src` and all of their routes. */
export function collectControllerRoutes(): {
  routes: ControllerRoute[];
  controllers: string[];
} {
  const routes: ControllerRoute[] = [];
  const controllers: string[] = [];
  for (const file of findControllerFiles(SRC).sort()) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(file) as Record<string, unknown>;
    for (const exported of Object.values(mod)) {
      if (typeof exported !== 'function') continue;
      // @Controller() always writes PATH_METADATA ('path') on the class.
      if (Reflect.getMetadata('path', exported) === undefined) continue;
      controllers.push((exported as { name: string }).name);
      routes.push(...routesOfController(exported));
    }
  }
  return { routes, controllers };
}
