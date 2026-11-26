import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { eq, and } from 'drizzle-orm';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { db } from '../drizzle/db';
import { leadRoutes, leadForms } from '../drizzle/schema';
import {
  assertRouteConfig,
  CreateLeadRouteDto,
  TestWebhookDto,
  UpdateLeadRouteDto,
} from './dto/lead-route.dto';
import { signWebhookPayload } from './utils/hmac';
import {
  assertWebhookUrl,
  WEBHOOK_TIMEOUT_MS,
  WEBHOOK_URL_UNREACHABLE,
} from './utils/webhook-url';
import { fetchPublic, UnsafeUrlError } from '../common/net/public-fetch';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { RequireCapability } from '../workspace-members/require-capability.decorator';
import { PlanFeatureGuard } from '../billing/plan/plan-feature.guard';
import { RequiresFeature } from '../billing/plan/requires-feature.decorator';

interface AuthUser {
  userId: string;
  email: string;
}

@Controller('ads/workspaces/:wid')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard, PlanFeatureGuard)
@RequiresFeature('ads:use')
export class LeadAdsController {
  constructor() {}

  // --------------------------------------------------------------------------
  // Helper — verify the lead form belongs to this workspace
  // --------------------------------------------------------------------------

  private async resolveForm(wid: string, formId: string) {
    const rows = await db
      .select()
      .from(leadForms)
      .where(and(eq(leadForms.id, formId), eq(leadForms.workspaceId, wid)))
      .limit(1);

    if (rows.length === 0) {
      throw new NotFoundException('Lead form not found in this workspace');
    }

    return rows[0];
  }

  // --------------------------------------------------------------------------
  // GET /ads/workspaces/:wid/lead-forms/:formId/routes
  // --------------------------------------------------------------------------

  @Get('lead-forms/:formId/routes')
  @RequireCapability('channels:manage')
  async listRoutes(
    @Param('wid') wid: string,
    @Param('formId') formId: string,
    @CurrentUser() _user: AuthUser,
  ) {
    await this.resolveForm(wid, formId);

    const routes = await db
      .select()
      .from(leadRoutes)
      .where(eq(leadRoutes.leadFormId, formId));

    return { routes };
  }

  // --------------------------------------------------------------------------
  // POST /ads/workspaces/:wid/lead-forms/:formId/routes
  // --------------------------------------------------------------------------

  @Post('lead-forms/:formId/routes')
  @RequireCapability('channels:manage')
  async createRoute(
    @Param('wid') wid: string,
    @Param('formId') formId: string,
    @CurrentUser() _user: AuthUser,
    @Body() body: CreateLeadRouteDto,
  ) {
    await this.resolveForm(wid, formId);
    if (body.type === 'webhook' || body.config?.url !== undefined) {
      await assertWebhookUrl(body.config?.url);
    }

    const inserted = await db
      .insert(leadRoutes)
      .values({
        workspaceId: wid,
        leadFormId: formId,
        type: body.type,
        config: body.config,
        enabled: body.enabled ?? true,
      })
      .returning();

    return { route: inserted[0] };
  }

  // --------------------------------------------------------------------------
  // PATCH /ads/workspaces/:wid/lead-forms/:formId/routes/:id
  // --------------------------------------------------------------------------

  @Patch('lead-forms/:formId/routes/:id')
  @RequireCapability('channels:manage')
  async updateRoute(
    @Param('wid') wid: string,
    @Param('formId') formId: string,
    @Param('id') id: string,
    @CurrentUser() _user: AuthUser,
    @Body() body: UpdateLeadRouteDto,
  ) {
    await this.resolveForm(wid, formId);
    if (body.config !== undefined) {
      // The body carries no type: the config must fit the stored route's.
      const [route] = await db
        .select({ type: leadRoutes.type })
        .from(leadRoutes)
        .where(and(eq(leadRoutes.id, id), eq(leadRoutes.leadFormId, formId)))
        .limit(1);
      if (!route) throw new NotFoundException('Route not found');
      await assertRouteConfig(route.type, body.config);
      if (route.type === 'webhook') {
        await assertWebhookUrl(body.config.url);
      }
    }

    // Build update payload — only include fields that were provided
    const updates: Partial<{
      enabled: boolean;
      config: Record<string, unknown>;
    }> = {};
    if (typeof body.enabled === 'boolean') updates.enabled = body.enabled;
    if (body.config !== undefined) updates.config = body.config;

    const updated = await db
      .update(leadRoutes)
      .set(updates)
      .where(and(eq(leadRoutes.id, id), eq(leadRoutes.leadFormId, formId)))
      .returning();

    if (updated.length === 0) {
      throw new NotFoundException('Route not found');
    }

    return { route: updated[0] };
  }

  // --------------------------------------------------------------------------
  // DELETE /ads/workspaces/:wid/lead-forms/:formId/routes/:id
  // --------------------------------------------------------------------------

  @Delete('lead-forms/:formId/routes/:id')
  @RequireCapability('channels:manage')
  @HttpCode(HttpStatus.OK)
  async deleteRoute(
    @Param('wid') wid: string,
    @Param('formId') formId: string,
    @Param('id') id: string,
    @CurrentUser() _user: AuthUser,
  ) {
    await this.resolveForm(wid, formId);

    const deleted = await db
      .delete(leadRoutes)
      .where(and(eq(leadRoutes.id, id), eq(leadRoutes.leadFormId, formId)))
      .returning();

    if (deleted.length === 0) {
      throw new NotFoundException('Route not found');
    }

    return { success: true };
  }

  // --------------------------------------------------------------------------
  // POST /ads/workspaces/:wid/lead-forms/:formId/routes/test-webhook
  // --------------------------------------------------------------------------

  @Post('lead-forms/:formId/routes/test-webhook')
  @RequireCapability('channels:manage')
  async testWebhook(
    @Param('wid') wid: string,
    @Param('formId') formId: string,
    @CurrentUser() _user: AuthUser,
    @Body() body: TestWebhookDto,
  ) {
    await this.resolveForm(wid, formId);
    await assertWebhookUrl(body.url);

    const samplePayload = {
      id: 'test-' + crypto.randomUUID(),
      formId,
      formName: 'Test Form',
      capturedAt: new Date().toISOString(),
      data: {
        full_name: 'Test User',
        email: 'test@example.com',
        phone_number: '+1-555-000-0000',
      },
    };

    const payloadStr = JSON.stringify(samplePayload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (body.secret) {
      headers['X-Schedura-Signature'] = signWebhookPayload(
        body.secret,
        payloadStr,
      );
    }

    let status: number;
    let ok: boolean;

    try {
      // Redirects are not followed: a 3xx is reported as a failed test.
      const res = await fetchPublic(body.url, {
        method: 'POST',
        headers,
        body: payloadStr,
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      await res.body?.cancel().catch(() => undefined);
      status = res.status;
      ok = res.ok;
    } catch (err) {
      // The host resolved to a private address at connect time.
      if (err instanceof UnsafeUrlError) {
        throw new BadRequestException(WEBHOOK_URL_UNREACHABLE);
      }
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, status: null, error: message };
    }

    return { ok, status };
  }
}
