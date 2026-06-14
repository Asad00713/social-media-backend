import { Injectable, NotFoundException } from '@nestjs/common'
import { db } from '../../drizzle/db'
import { adDrafts } from '../../drizzle/schema'
import { and, desc, eq } from 'drizzle-orm'
import type { UpsertDraftDto } from '../dto/draft.dto'

@Injectable()
export class AdDraftsService {
  async upsert(workspaceId: string, userId: string, body: UpsertDraftDto) {
    if (body.id) {
      const [updated] = await db
        .update(adDrafts)
        .set({
          state: body.state,
          currentStep: body.currentStep,
          updatedAt: new Date(),
        })
        .where(and(eq(adDrafts.id, body.id), eq(adDrafts.userId, userId)))
        .returning()
      if (!updated) throw new NotFoundException('Draft not found')
      return updated
    }
    const [created] = await db
      .insert(adDrafts)
      .values({
        workspaceId,
        userId,
        kind: body.kind,
        state: body.state,
        currentStep: body.currentStep,
      })
      .returning()
    return created
  }

  async list(workspaceId: string, userId: string) {
    return db
      .select()
      .from(adDrafts)
      .where(and(eq(adDrafts.workspaceId, workspaceId), eq(adDrafts.userId, userId)))
      .orderBy(desc(adDrafts.updatedAt))
      .limit(20)
  }

  async get(workspaceId: string, userId: string, id: string) {
    const [row] = await db
      .select()
      .from(adDrafts)
      .where(
        and(
          eq(adDrafts.id, id),
          eq(adDrafts.workspaceId, workspaceId),
          eq(adDrafts.userId, userId),
        ),
      )
    if (!row) throw new NotFoundException('Draft not found')
    return row
  }

  async delete(workspaceId: string, userId: string, id: string) {
    await db
      .delete(adDrafts)
      .where(and(eq(adDrafts.id, id), eq(adDrafts.userId, userId)))
  }
}
