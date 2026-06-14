import {
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
} from '@nestjs/common'
import * as crypto from 'crypto'
import { eq, and } from 'drizzle-orm'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { db } from '../drizzle/db'
import { leadRoutes, leadForms } from '../drizzle/schema'
import { signWebhookPayload } from './utils/hmac'

interface AuthUser {
  userId: string
  email: string
}

interface CreateRouteBody {
  type: 'inbox' | 'email' | 'webhook'
  config: Record<string, unknown>
  enabled?: boolean
}

interface UpdateRouteBody {
  enabled?: boolean
  config?: Record<string, unknown>
}

interface TestWebhookBody {
  url: string
  secret?: string
}

@Controller('ads/workspaces/:wid')
@UseGuards(JwtAuthGuard)
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
      .limit(1)

    if (rows.length === 0) {
      throw new NotFoundException('Lead form not found in this workspace')
    }

    return rows[0]
  }

  // --------------------------------------------------------------------------
  // GET /ads/workspaces/:wid/lead-forms/:formId/routes
  // --------------------------------------------------------------------------

  @Get('lead-forms/:formId/routes')
  async listRoutes(
    @Param('wid') wid: string,
    @Param('formId') formId: string,
    @CurrentUser() _user: AuthUser,
  ) {
    await this.resolveForm(wid, formId)

    const routes = await db
      .select()
      .from(leadRoutes)
      .where(eq(leadRoutes.leadFormId, formId))

    return { routes }
  }

  // --------------------------------------------------------------------------
  // POST /ads/workspaces/:wid/lead-forms/:formId/routes
  // --------------------------------------------------------------------------

  @Post('lead-forms/:formId/routes')
  async createRoute(
    @Param('wid') wid: string,
    @Param('formId') formId: string,
    @CurrentUser() _user: AuthUser,
    @Body() body: CreateRouteBody,
  ) {
    await this.resolveForm(wid, formId)

    const inserted = await db
      .insert(leadRoutes)
      .values({
        workspaceId: wid,
        leadFormId: formId,
        type: body.type,
        config: body.config,
        enabled: body.enabled ?? true,
      })
      .returning()

    return { route: inserted[0] }
  }

  // --------------------------------------------------------------------------
  // PATCH /ads/workspaces/:wid/lead-forms/:formId/routes/:id
  // --------------------------------------------------------------------------

  @Patch('lead-forms/:formId/routes/:id')
  async updateRoute(
    @Param('wid') wid: string,
    @Param('formId') formId: string,
    @Param('id') id: string,
    @CurrentUser() _user: AuthUser,
    @Body() body: UpdateRouteBody,
  ) {
    await this.resolveForm(wid, formId)

    // Build update payload — only include fields that were provided
    const updates: Partial<{ enabled: boolean; config: Record<string, unknown> }> = {}
    if (typeof body.enabled === 'boolean') updates.enabled = body.enabled
    if (body.config !== undefined) updates.config = body.config

    const updated = await db
      .update(leadRoutes)
      .set(updates)
      .where(and(eq(leadRoutes.id, id), eq(leadRoutes.leadFormId, formId)))
      .returning()

    if (updated.length === 0) {
      throw new NotFoundException('Route not found')
    }

    return { route: updated[0] }
  }

  // --------------------------------------------------------------------------
  // DELETE /ads/workspaces/:wid/lead-forms/:formId/routes/:id
  // --------------------------------------------------------------------------

  @Delete('lead-forms/:formId/routes/:id')
  @HttpCode(HttpStatus.OK)
  async deleteRoute(
    @Param('wid') wid: string,
    @Param('formId') formId: string,
    @Param('id') id: string,
    @CurrentUser() _user: AuthUser,
  ) {
    await this.resolveForm(wid, formId)

    const deleted = await db
      .delete(leadRoutes)
      .where(and(eq(leadRoutes.id, id), eq(leadRoutes.leadFormId, formId)))
      .returning()

    if (deleted.length === 0) {
      throw new NotFoundException('Route not found')
    }

    return { success: true }
  }

  // --------------------------------------------------------------------------
  // POST /ads/workspaces/:wid/lead-forms/:formId/routes/test-webhook
  // --------------------------------------------------------------------------

  @Post('lead-forms/:formId/routes/test-webhook')
  async testWebhook(
    @Param('wid') wid: string,
    @Param('formId') formId: string,
    @CurrentUser() _user: AuthUser,
    @Body() body: TestWebhookBody,
  ) {
    await this.resolveForm(wid, formId)

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
    }

    const payloadStr = JSON.stringify(samplePayload)
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (body.secret) {
      headers['X-Schedura-Signature'] = signWebhookPayload(body.secret, payloadStr)
    }

    let status: number
    let ok: boolean

    try {
      const res = await fetch(body.url, {
        method: 'POST',
        headers,
        body: payloadStr,
        signal: AbortSignal.timeout(10_000),
      })
      status = res.status
      ok = res.ok
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, status: null, error: message }
    }

    return { ok, status }
  }
}
