import { Injectable, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { db } from '../../drizzle/db'
import { leadForms } from '../../drizzle/schema'
import { eq } from 'drizzle-orm'
import { MetaAdsClient } from './meta-ads.client'
import { ChannelService } from '../../channels/services/channel.service'
import type { CreateLeadFormDto } from '../dto/lead-form.dto'

@Injectable()
export class LeadFormService {
  constructor(
    private readonly meta: MetaAdsClient,
    private readonly channelService: ChannelService,
  ) {}

  async create(workspaceId: string, channelId: number, dto: CreateLeadFormDto) {
    // Resolve channel — includes decrypted accessToken + platformAccountId
    const channel = await this.channelService.getChannelForPosting(channelId)
    if (!channel) throw new NotFoundException('Channel not found')
    if (channel.workspaceId !== workspaceId) throw new ForbiddenException('Channel does not belong to this workspace')
    if (channel.platform !== 'facebook') throw new BadRequestException('Lead forms require a Facebook Page channel')
    if (!channel.accessToken) throw new BadRequestException('No page access token for channel')

    // The accessToken on an FB Page channel is already page-scoped — use it directly
    const pageToken = channel.accessToken

    const remote = await this.meta.createLeadForm(channel.platformAccountId, pageToken, {
      name: dto.name,
      locale: dto.locale ?? 'en_US',
      privacy_policy: { url: dto.privacyPolicy.url, link_text: dto.privacyPolicy.linkText },
      questions: dto.questions.map((q) => {
        if (q.type === 'CUSTOM') {
          if (!q.key || !q.label) throw new BadRequestException('Custom questions require key + label')
          return {
            type: 'CUSTOM' as const,
            key: q.key,
            label: q.label,
            input_type: q.inputType ?? 'TEXT',
            options: q.options,
          }
        }
        return { type: q.type as any }
      }),
      thank_you_page: {
        title: dto.thankYou.title,
        body: dto.thankYou.body,
        button_type: dto.thankYou.buttonType,
        website_url: dto.thankYou.websiteUrl,
        button_text: dto.thankYou.buttonText,
      },
      context_card: dto.contextCard
        ? {
            title: dto.contextCard.title,
            style: dto.contextCard.style,
            content: dto.contextCard.content,
            button_text: dto.contextCard.buttonText,
          }
        : undefined,
    })

    const [row] = await db
      .insert(leadForms)
      .values({
        workspaceId,
        channelId,
        metaFormId: remote.id,
        name: dto.name,
        locale: dto.locale ?? 'en_US',
        questionsSnapshot: dto.questions as any,
        privacyPolicyUrl: dto.privacyPolicy.url,
        thankYouSnapshot: dto.thankYou as any,
        introSnapshot: dto.contextCard as any,
      })
      .returning()

    return row
  }

  async list(workspaceId: string) {
    return db.select().from(leadForms).where(eq(leadForms.workspaceId, workspaceId))
  }
}
