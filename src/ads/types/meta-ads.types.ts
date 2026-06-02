export interface MetaAdAccountDto {
  id: string                       // 'act_<numeric>'
  account_id: string               // '<numeric>'
  name: string
  currency: string                 // 'USD', 'PKR' etc.
  timezone_name: string            // 'America/Los_Angeles'
  account_status: number           // 1=ACTIVE, 2=DISABLED, 3=UNSETTLED, 7=PENDING_RISK_REVIEW, 9=IN_GRACE_PERIOD, 100=PENDING_CLOSURE, 101=CLOSED
  disable_reason?: number
  business?: { id: string; name: string }
  capabilities?: string[]
  funding_source_details?: { id: string; display_string: string; type: number }
}

export interface MetaTargeting {
  targeting_automation?: { advantage_audience: 0 | 1 }
  age_min?: number
  age_max?: number
  genders?: number[]               // [0]=all, [1]=male, [2]=female
  geo_locations?: {
    countries?: string[]
    cities?: Array<{ key: string; radius?: number; distance_unit?: 'mile' | 'kilometer' }>
  }
  interests?: Array<{ id: string; name: string }>
  behaviors?: Array<{ id: string; name: string }>
  family_statuses?: Array<{ id: string; name: string }>
  locales?: number[]
  publisher_platforms?: string[]
  facebook_positions?: string[]
  instagram_positions?: string[]
  device_platforms?: string[]
}

export interface MetaCampaignCreate {
  name: string
  objective: 'OUTCOME_LEADS' | 'OUTCOME_ENGAGEMENT' | 'OUTCOME_AWARENESS'
  status: 'ACTIVE' | 'PAUSED'
  special_ad_categories: string[]
  buying_type?: 'AUCTION'
}

export interface MetaAdSetCreate {
  name: string
  campaign_id: string
  daily_budget: number             // minor units (cents for USD; whole units for JPY)
  billing_event: 'IMPRESSIONS' | 'LINK_CLICKS'
  optimization_goal: 'LEAD_GENERATION' | 'POST_ENGAGEMENT' | 'REACH' | 'IMPRESSIONS' | 'LINK_CLICKS'
  bid_strategy?: 'LOWEST_COST_WITHOUT_CAP'
  destination_type?: 'ON_POST' | 'ON_AD' | 'WEBSITE' | 'APP' | 'MESSENGER'
  targeting: MetaTargeting
  start_time?: string              // ISO8601
  end_time?: string
  status: 'ACTIVE' | 'PAUSED'
  promoted_object?: { page_id?: string; application_id?: string }
}

export interface MetaCreativeBoostInput {
  name: string
  object_story_id: string          // '<page_id>_<post_id>'
}

export interface MetaCreativeLeadInput {
  name: string
  object_story_spec: {
    page_id: string
    instagram_actor_id?: string
    link_data: {
      message: string
      link: string
      name?: string
      description?: string
      /** Image hash from /adimages upload. Requires Marketing API standard
       *  access — blocked in newer dev-mode apps. Prefer `picture` (URL). */
      image_hash?: string
      /** Public image URL. Works in dev mode without /adimages capability. */
      picture?: string
      call_to_action: {
        type: 'SIGN_UP' | 'LEARN_MORE' | 'APPLY_NOW' | 'GET_QUOTE' | 'DOWNLOAD' | 'SUBSCRIBE'
        value: { lead_gen_form_id: string }
      }
    }
  }
}

export type MetaLeadFormQuestion =
  | { type: 'FULL_NAME' | 'EMAIL' | 'PHONE' | 'STREET_ADDRESS' | 'CITY' | 'STATE' | 'COUNTRY' | 'POST_CODE' | 'COMPANY_NAME' | 'JOB_TITLE' | 'WORK_EMAIL' | 'WORK_PHONE_NUMBER' | 'DATE_OF_BIRTH' | 'GENDER' | 'MARITAL_STATUS' | 'RELATIONSHIP_STATUS' | 'MILITARY_STATUS' }
  | { type: 'CUSTOM'; key: string; label: string; input_type?: 'TEXT' | 'MULTIPLE_CHOICE'; options?: Array<{ key: string; value: string }> }

export interface MetaLeadFormInput {
  name: string
  locale: string
  privacy_policy: { url: string; link_text: string }
  questions: MetaLeadFormQuestion[]
  thank_you_page: {
    title: string
    body: string
    button_type?: 'VIEW_WEBSITE' | 'CALL_BUSINESS' | 'DOWNLOAD'
    website_url?: string
    button_text?: string
  }
  context_card?: {
    title: string
    style?: 'LIST_STYLE' | 'PARAGRAPH_STYLE'
    content?: string[]
    button_text?: string
  }
  follow_up_action_url?: string
}

export interface MetaInsightsRow {
  impressions: string
  reach: string
  clicks: string
  spend: string
  cpc?: string
  cpm?: string
  ctr?: string
  actions?: Array<{ action_type: string; value: string }>
  date_start: string
  date_stop: string
}
