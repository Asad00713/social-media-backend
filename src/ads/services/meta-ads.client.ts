import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import type {
  MetaAdAccountDto, MetaCampaignCreate, MetaAdSetCreate,
  MetaCreativeBoostInput, MetaCreativeBoostOverridesInput, MetaCreativeLeadInput,
  MetaLeadFormInput, MetaInsightsRow, MetaTargeting,
} from '../types/meta-ads.types'

const GRAPH = 'https://graph.facebook.com/v21.0'

@Injectable()
export class MetaAdsClient {
  private readonly logger = new Logger(MetaAdsClient.name)

  async listAdAccounts(userAccessToken: string): Promise<MetaAdAccountDto[]> {
    const fields = 'id,account_id,name,currency,timezone_name,account_status,disable_reason,business,capabilities,funding_source_details'
    const res = await this.get<{ data: MetaAdAccountDto[] }>(
      `/me/adaccounts?fields=${fields}&access_token=${encodeURIComponent(userAccessToken)}`,
    )
    return res.data ?? []
  }

  async getDeliveryEstimate(
    adAccountId: string,
    token: string,
    targeting: object,
    optimizationGoal: string,
  ): Promise<{ daily_outcomes_curve?: unknown; estimate_ready: boolean }> {
    const url = `/act_${stripAct(adAccountId)}/delivery_estimate?targeting_spec=${encodeURIComponent(JSON.stringify(targeting))}&optimization_goal=${optimizationGoal}&access_token=${encodeURIComponent(token)}`
    return this.get(url)
  }

  async createCampaign(adAccountId: string, token: string, input: MetaCampaignCreate): Promise<{ id: string }> {
    return this.post(`/act_${stripAct(adAccountId)}/campaigns`, token, {
      ...input,
      is_adset_budget_sharing_enabled: false,
    })
  }

  async createAdSet(adAccountId: string, token: string, input: MetaAdSetCreate): Promise<{ id: string }> {
    return this.post(`/act_${stripAct(adAccountId)}/adsets`, token, {
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      ...input,
    })
  }

  /**
   * Upload an image to Meta's ad library. We use the `url` parameter rather than
   * `bytes` so we don't have to base64-encode large files and bump into the 5 MB
   * request payload limit. The URL must be publicly fetchable (R2 public URL is fine).
   */
  async uploadAdImage(adAccountId: string, token: string, imageUrl: string): Promise<{ hash: string; url: string }> {
    const body = new URLSearchParams({ url: imageUrl, access_token: token })
    const res = await fetch(`${GRAPH}/act_${stripAct(adAccountId)}/adimages`, { method: 'POST', body })
    const data = (await res.json()) as { images?: Record<string, { hash: string; url: string }>; error?: { message: string; code: number } }
    if (!res.ok || !data.images) {
      throw new BadRequestException(`Meta adimage upload failed: ${data.error?.message ?? JSON.stringify(data)}`)
    }
    const first = Object.values(data.images)[0]
    if (!first) throw new BadRequestException('No image hash returned by Meta')
    return first
  }

  async createCreativeBoost(adAccountId: string, token: string, input: MetaCreativeBoostInput): Promise<{ id: string }> {
    return this.post(`/act_${stripAct(adAccountId)}/adcreatives`, token, input)
  }

  async createCreativeBoostWithOverrides(
    adAccountId: string,
    token: string,
    input: MetaCreativeBoostOverridesInput,
  ): Promise<{ id: string }> {
    return this.postJson(`/act_${stripAct(adAccountId)}/adcreatives`, token, input)
  }

  async createCreativeLead(adAccountId: string, token: string, input: MetaCreativeLeadInput): Promise<{ id: string }> {
    return this.post(`/act_${stripAct(adAccountId)}/adcreatives`, token, input)
  }

  async createAd(
    adAccountId: string,
    token: string,
    input: { name: string; adset_id: string; creative: { creative_id: string }; status: 'ACTIVE' | 'PAUSED' },
  ): Promise<{ id: string }> {
    return this.post(`/act_${stripAct(adAccountId)}/ads`, token, input)
  }

  async createLeadForm(pageId: string, pageAccessToken: string, input: MetaLeadFormInput): Promise<{ id: string }> {
    // Lead-gen forms have deeply-nested objects (privacy_policy, thank_you_page,
    // questions[]). Form-urlencoded with JSON.stringify per-field makes Meta's
    // parser return generic "An unknown error has occurred." (code 1). Sending
    // as application/json works reliably — confirmed via Graph API Explorer.
    return this.postJson(`/${pageId}/leadgen_forms`, pageAccessToken, input)
  }

  async getLead(
    leadgenId: string,
    pageAccessToken: string,
  ): Promise<{
    id: string
    created_time: string
    field_data: Array<{ name: string; values: string[] }>
    form_id?: string
    ad_id?: string
    adset_id?: string
    campaign_id?: string
    is_organic?: boolean
  }> {
    return this.get(`/${leadgenId}?fields=id,created_time,field_data,form_id,ad_id,adset_id,campaign_id,is_organic&access_token=${encodeURIComponent(pageAccessToken)}`)
  }

  async getInsights(
    metaEntityId: string,
    token: string,
    timeRange?: { since: string; until: string },
  ): Promise<MetaInsightsRow[]> {
    const tr = timeRange ? `&time_range=${encodeURIComponent(JSON.stringify(timeRange))}` : ''
    const fields = 'impressions,reach,clicks,spend,cpc,cpm,ctr,actions,date_start,date_stop'
    const res = await this.get<{ data: MetaInsightsRow[] }>(
      `/${metaEntityId}/insights?fields=${fields}${tr}&access_token=${encodeURIComponent(token)}`,
    )
    return res.data ?? []
  }

  async updateEntityStatus(
    metaEntityId: string,
    token: string,
    status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED',
  ): Promise<{ success: boolean }> {
    return this.post(`/${metaEntityId}`, token, { status })
  }

  async updateAdSetBudget(metaAdsetId: string, token: string, dailyBudgetMinor: number): Promise<{ success: boolean }> {
    return this.post(`/${metaAdsetId}`, token, { daily_budget: dailyBudgetMinor })
  }

  async updateAdSetSchedule(
    metaAdsetId: string,
    token: string,
    input: { start_time?: string; end_time?: string | null },
  ): Promise<{ success: boolean }> {
    // Meta accepts `null` to clear end_time on an open-ended ad set.
    return this.post(`/${metaAdsetId}`, token, input)
  }

  async updateAdSetTargeting(
    metaAdsetId: string,
    token: string,
    targeting: MetaTargeting,
  ): Promise<{ success: boolean }> {
    return this.post(`/${metaAdsetId}`, token, { targeting })
  }

  async searchInterests(
    query: string,
    token: string,
    limit = 25,
  ): Promise<Array<{ id: string; name: string; audience_size_lower_bound?: number; audience_size_upper_bound?: number; topic?: string }>> {
    const url = `/search?type=adinterest&q=${encodeURIComponent(query)}&limit=${limit}&access_token=${encodeURIComponent(token)}`
    const res = await this.get<{ data: Array<{ id: string; name: string }> }>(url)
    return res.data ?? []
  }

  /** Geo-location autocomplete (cities only). Meta returns key + name + type
   *  + country_name + region for each item. Countries are exposed via the
   *  simple country picker instead. */
  async searchGeoLocations(
    query: string,
    token: string,
    limit = 25,
  ): Promise<Array<{ key: string; name: string; type: string; country_name?: string; region?: string }>> {
    const url = `/search?type=adgeolocation&location_types=${encodeURIComponent('["city"]')}&q=${encodeURIComponent(query)}&limit=${limit}&access_token=${encodeURIComponent(token)}`
    const res = await this.get<{ data: Array<{ key: string; name: string; type: string; country_name?: string; region?: string }> }>(url)
    return res.data ?? []
  }

  /** Locale autocomplete. Meta returns locale id + name (e.g. {key: 6, name: "English (US)"}). */
  async searchLanguages(
    query: string,
    token: string,
    limit = 25,
  ): Promise<Array<{ key: number; name: string }>> {
    const url = `/search?type=adlocale&q=${encodeURIComponent(query)}&limit=${limit}&access_token=${encodeURIComponent(token)}`
    const res = await this.get<{ data: Array<{ key: number; name: string }> }>(url)
    return res.data ?? []
  }

  /** Behaviour-targeting autocomplete (Meta's behaviour taxonomy). */
  async searchBehaviors(
    query: string,
    token: string,
    limit = 25,
  ): Promise<Array<{ id: string; name: string; audience_size_lower_bound?: number; audience_size_upper_bound?: number }>> {
    const url = `/search?type=adTargetingCategory&class=behaviors&q=${encodeURIComponent(query)}&limit=${limit}&access_token=${encodeURIComponent(token)}`
    const res = await this.get<{ data: Array<{ id: string; name: string; audience_size_lower_bound?: number; audience_size_upper_bound?: number }> }>(url)
    return res.data ?? []
  }

  /** Detailed-demographic autocomplete. */
  async searchDemographics(
    query: string,
    token: string,
    limit = 25,
  ): Promise<Array<{ id: string; name: string; audience_size_lower_bound?: number; audience_size_upper_bound?: number }>> {
    const url = `/search?type=adTargetingCategory&class=demographics&q=${encodeURIComponent(query)}&limit=${limit}&access_token=${encodeURIComponent(token)}`
    const res = await this.get<{ data: Array<{ id: string; name: string; audience_size_lower_bound?: number; audience_size_upper_bound?: number }> }>(url)
    return res.data ?? []
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${GRAPH}${path}`)
    const data = await res.json()
    if (!res.ok) {
      const sanitized = path.split('?')[0]
      this.logger.error(`Meta GET ${sanitized} failed: ${JSON.stringify(data)}`)
      throw new BadRequestException(`Meta API error: ${(data as any)?.error?.message ?? 'unknown'} (code: ${(data as any)?.error?.code})`)
    }
    return data as T
  }

  /** application/json variant of post(). Used for endpoints whose payloads
   *  include deeply-nested objects that Meta's form-urlencoded parser mangles
   *  (e.g. leadgen_forms). */
  private async postJson<T>(path: string, token: string, body: object): Promise<T> {
    const res = await fetch(`${GRAPH}${path}?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!res.ok) {
      this.logger.error(`Meta POST(json) ${path} failed: ${JSON.stringify(data)} body: ${JSON.stringify(body)}`)
      const err = (data as any)?.error ?? {}
      const detail = err.error_user_msg || err.error_user_title || err.message || 'unknown'
      throw new BadRequestException(
        `Meta API error on ${path}: ${detail} (code: ${err.code}, subcode: ${err.error_subcode ?? 'none'}, trace: ${err.fbtrace_id ?? 'none'})`,
      )
    }
    return data as T
  }

  private async post<T>(path: string, token: string, body: object): Promise<T> {
    const formBody = new URLSearchParams()
    for (const [k, v] of Object.entries(body)) {
      formBody.append(k, typeof v === 'string' ? v : JSON.stringify(v))
    }
    formBody.append('access_token', token)
    const res = await fetch(`${GRAPH}${path}`, { method: 'POST', body: formBody })
    const data = await res.json()
    if (!res.ok) {
      this.logger.error(`Meta POST ${path} failed: ${JSON.stringify(data)} body: ${JSON.stringify(body)}`)
      const err = (data as any)?.error ?? {}
      let detail = err.error_user_msg || err.error_user_title || err.message || 'unknown'
      // Meta returns a useless "An unknown error has occurred." (code 1) when
      // creating leadgen_forms before the Page admin has accepted the Lead
      // Generation Terms of Service. Surface a helpful hint.
      if (path.includes('/leadgen_forms') && err.code === 1) {
        detail =
          'Meta could not create the lead form. Most often this means the Facebook Page admin has not yet accepted the Lead Generation Terms of Service. Open the Page → Settings → Lead Ads Forms and accept the terms, then retry.'
      }
      throw new BadRequestException(
        `Meta API error on ${path}: ${detail} (code: ${err.code}, subcode: ${err.error_subcode ?? 'none'}, trace: ${err.fbtrace_id ?? 'none'})`,
      )
    }
    return data as T
  }
}

function stripAct(id: string): string {
  return id.startsWith('act_') ? id.slice(4) : id
}
