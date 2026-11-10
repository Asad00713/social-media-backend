import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, desc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import { posts } from '../drizzle/schema/posts.schema';
import {
  shortLinks,
  type ShortLinkRow,
} from '../drizzle/schema/short-links.schema';
import type {
  CreateShortLinkDto,
  ListShortLinksQueryDto,
  ShortLinkDto,
  ShortLinkListDto,
} from './dto/short-links.dto';
import {
  CODE_ATTEMPTS,
  CODE_PATTERN,
  CREATE_LIMIT_PER_HOUR,
  LIST_LIMIT,
  TARGET_URL_MESSAGES,
  checkTargetUrl,
  generateCode,
  isSafeRedirectTarget,
  selfLinkBases,
  shortLinkBaseUrl,
  shortUrlFor,
} from './short-link-rules';

/**
 * True when Postgres says the table does not exist (42P01): the code is
 * deployed but 0061 is not applied yet. drizzle wraps driver errors, so the
 * code may sit on `cause`.
 */
export function isMissingTable(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; e && i < 3; i++) {
    if ((e as { code?: unknown }).code === '42P01') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

const NOT_READY = 'Link shortening is not available yet. Try again shortly.';
const NOT_CONFIGURED =
  'Link shortening is not set up on this server (no public URL).';

/**
 * Short links: create (idempotent per workspace and URL), list with click
 * counts, and resolve a code for the public redirect. Every workspace read
 * and write is scoped to the workspace in the path; the route guard has
 * already checked the caller is a member who can draft.
 */
@Injectable()
export class ShortLinksService {
  /** Draws a code. A field so a spec can force collisions. */
  newCode: () => string = generateCode;

  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  async create(
    workspaceId: string,
    userId: string,
    dto: CreateShortLinkDto,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<ShortLinkDto> {
    const baseUrl = shortLinkBaseUrl(env);
    if (!baseUrl) throw new ServiceUnavailableException(NOT_CONFIGURED);
    const checked = checkTargetUrl(dto.url, selfLinkBases(env));
    if (!checked.ok) {
      throw new BadRequestException(TARGET_URL_MESSAGES[checked.problem]);
    }
    const targetUrl = checked.url;
    const postId = dto.postId ?? null;

    try {
      if (postId) await this.assertPost(workspaceId, postId);

      const existing = await this.findByUrl(workspaceId, targetUrl);
      if (existing) {
        return this.present(await this.claimForPost(existing, postId), baseUrl);
      }

      await this.assertUnderLimit(workspaceId);

      for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
        // Either unique index may refuse the row: the code (a collision,
        // draw again) or (workspace, url) (a concurrent create of the same
        // link, which then exists and is returned).
        const [row] = await this.db
          .insert(shortLinks)
          .values({
            workspaceId,
            code: this.newCode(),
            targetUrl,
            postId,
            createdById: userId,
          })
          .onConflictDoNothing()
          .returning();
        if (row) return this.present(row, baseUrl);
        const raced = await this.findByUrl(workspaceId, targetUrl);
        if (raced) return this.present(raced, baseUrl);
      }
    } catch (err) {
      if (isMissingTable(err)) throw new ServiceUnavailableException(NOT_READY);
      throw err;
    }
    throw new ServiceUnavailableException(
      'Could not make a short link. Try again.',
    );
  }

  /** Newest first, at most LIST_LIMIT. Empty if the table is not there yet. */
  async list(
    workspaceId: string,
    query: ListShortLinksQueryDto,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<ShortLinkListDto> {
    const baseUrl = shortLinkBaseUrl(env);
    if (!baseUrl) return { baseUrl: null, links: [] };
    if (query.codes && query.codes.length === 0) return { baseUrl, links: [] };

    const where: SQL[] = [eq(shortLinks.workspaceId, workspaceId)];
    if (query.postId) where.push(eq(shortLinks.postId, query.postId));
    if (query.codes) where.push(inArray(shortLinks.code, query.codes));
    try {
      const rows = await this.db
        .select()
        .from(shortLinks)
        .where(and(...where))
        .orderBy(desc(shortLinks.createdAt), desc(shortLinks.id))
        .limit(LIST_LIMIT);
      return { baseUrl, links: rows.map((r) => this.present(r, baseUrl)) };
    } catch (err) {
      if (isMissingTable(err)) return { baseUrl, links: [] };
      throw err;
    }
  }

  /**
   * The target for a code, or null. `count` adds the click in the same
   * UPDATE that reads the target, so concurrent clicks never lose one; a
   * HEAD request (link checkers, unfurl probes) reads without counting.
   */
  async resolve(code: string, count: boolean): Promise<string | null> {
    if (!CODE_PATTERN.test(code)) return null;
    try {
      const [row] = count
        ? await this.db
            .update(shortLinks)
            .set({
              clicks: sql`${shortLinks.clicks} + 1`,
              lastClickedAt: sql`now()`,
            })
            .where(eq(shortLinks.code, code))
            .returning({ targetUrl: shortLinks.targetUrl })
        : await this.db
            .select({ targetUrl: shortLinks.targetUrl })
            .from(shortLinks)
            .where(eq(shortLinks.code, code))
            .limit(1);
      if (!row || !isSafeRedirectTarget(row.targetUrl)) return null;
      return row.targetUrl;
    } catch (err) {
      if (isMissingTable(err)) return null;
      throw err;
    }
  }

  private async findByUrl(
    workspaceId: string,
    targetUrl: string,
  ): Promise<ShortLinkRow | undefined> {
    const [row] = await this.db
      .select()
      .from(shortLinks)
      .where(
        and(
          eq(shortLinks.workspaceId, workspaceId),
          eq(shortLinks.targetUrl, targetUrl),
        ),
      )
      .limit(1);
    return row;
  }

  /**
   * An existing link made before the draft was saved gets the post it is
   * now used in. One that already belongs to a post keeps it: the link is
   * per workspace and URL, not per post.
   */
  private async claimForPost(
    row: ShortLinkRow,
    postId: string | null,
  ): Promise<ShortLinkRow> {
    if (!postId || row.postId) return row;
    const [claimed] = await this.db
      .update(shortLinks)
      .set({ postId })
      .where(and(eq(shortLinks.id, row.id), sql`${shortLinks.postId} IS NULL`))
      .returning();
    return claimed ?? row;
  }

  private async assertPost(workspaceId: string, postId: string) {
    const [post] = await this.db
      .select({ id: posts.id })
      .from(posts)
      .where(and(eq(posts.id, postId), eq(posts.workspaceId, workspaceId)))
      .limit(1);
    if (!post) throw new NotFoundException('Post not found');
  }

  /** At most CREATE_LIMIT_PER_HOUR new links per workspace per hour. */
  private async assertUnderLimit(workspaceId: string) {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(shortLinks)
      .where(
        and(
          eq(shortLinks.workspaceId, workspaceId),
          gt(shortLinks.createdAt, sql`now() - interval '1 hour'`),
        ),
      );
    if ((row?.n ?? 0) >= CREATE_LIMIT_PER_HOUR) {
      throw new HttpException(
        `This workspace has made ${CREATE_LIMIT_PER_HOUR} short links in the last hour. Try again later.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private present(row: ShortLinkRow, baseUrl: string): ShortLinkDto {
    return {
      id: row.id,
      code: row.code,
      shortUrl: shortUrlFor(baseUrl, row.code),
      targetUrl: row.targetUrl,
      postId: row.postId,
      clicks: row.clicks,
      lastClickedAt: row.lastClickedAt
        ? new Date(row.lastClickedAt).toISOString()
        : null,
      createdAt: new Date(row.createdAt).toISOString(),
    };
  }
}
