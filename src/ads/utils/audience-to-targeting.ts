import type { AudienceDto } from '../dto/audience.dto'
import type { MetaTargeting } from '../types/meta-ads.types'

export function audienceToMetaTargeting(a: AudienceDto): MetaTargeting {
  const genders = a.genders.includes('all')
    ? undefined
    : a.genders.map((g) => (g === 'male' ? 1 : 2))
  return {
    age_min: a.ageMin,
    age_max: a.ageMax,
    genders,
    geo_locations: {
      countries: a.countries,
      cities: a.cities,
    },
    interests: a.interests,
    publisher_platforms: ['facebook', 'instagram'],
    facebook_positions: ['feed', 'story'],
    instagram_positions: ['stream', 'story', 'reels'],
  }
}
