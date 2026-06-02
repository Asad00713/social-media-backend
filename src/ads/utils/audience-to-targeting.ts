import type { AudienceDto } from '../dto/audience.dto'
import type { MetaTargeting } from '../types/meta-ads.types'

export function audienceToMetaTargeting(a: AudienceDto): MetaTargeting {
  const genders = a.genders.includes('all')
    ? undefined
    : a.genders.map((g) => (g === 'male' ? 1 : 2))

  // Meta policy: interest / behaviour / demographic targeting cannot be
  // combined with under-18. When ANY of those are present, clamp age_min to
  // 18 so the campaign passes policy review instead of failing with
  // subcode 1870249.
  const hasDetailedTargeting =
    !!(a.interests && a.interests.length) ||
    !!(a.behaviors && a.behaviors.length) ||
    !!(a.demographics && a.demographics.length)
  const ageMin = hasDetailedTargeting ? Math.max(18, a.ageMin) : a.ageMin

  // Cities default to a 10-mile radius (Meta's own default) when the caller
  // omits one.
  const cities =
    a.cities && a.cities.length > 0
      ? a.cities.map((c) => ({ key: c.key, radius: c.radius ?? 10, distance_unit: 'mile' as const }))
      : undefined

  return {
    targeting_automation: { advantage_audience: 0 },
    age_min: ageMin,
    age_max: a.ageMax,
    genders,
    geo_locations: {
      countries: a.countries && a.countries.length > 0 ? a.countries : undefined,
      cities,
    },
    interests: a.interests && a.interests.length > 0 ? a.interests : undefined,
    behaviors: a.behaviors && a.behaviors.length > 0 ? a.behaviors : undefined,
    family_statuses: a.demographics && a.demographics.length > 0 ? a.demographics : undefined,
    locales: a.languages && a.languages.length > 0 ? a.languages : undefined,
    publisher_platforms: ['facebook', 'instagram'],
    facebook_positions: ['feed', 'story'],
    instagram_positions: ['stream', 'story', 'reels'],
  }
}
