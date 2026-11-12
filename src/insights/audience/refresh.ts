import type {
  RawSlice,
  StoredAudienceStatus,
} from '../../drizzle/schema/channel-audience.schema';
import type { SupportedPlatform } from '../../drizzle/schema/channels.schema';
import type { FacebookApiClient } from '../../channels/analytics/adapters/facebook/facebook-api.client';
import type { InstagramApiClient } from '../../channels/analytics/adapters/instagram/instagram-api.client';
import type { ThreadsApiClient } from '../../channels/analytics/adapters/threads/threads-api.client';
import { facebookLocation, metaBreakdown, statusOfError } from './normalize';

/** Instagram and Threads expose demographics only from this many followers. */
export const MIN_FOLLOWERS_FOR_DEMOGRAPHICS = 100;

export interface RefreshDeps {
  instagram: Pick<InstagramApiClient, 'getFollowerDemographics'>;
  threads: Pick<ThreadsApiClient, 'getFollowerDemographics'>;
  facebook: Pick<FacebookApiClient, 'getPageFollowsLocation'>;
}

/** What `channel_audience` stores (raw counts; percentages are computed on read). */
export interface AudienceRow {
  status: StoredAudienceStatus;
  followerCount: number | null;
  countries: RawSlice[];
  cities: RawSlice[];
  ages: RawSlice[];
  genders: RawSlice[];
}

export interface RefreshChannel {
  platform: SupportedPlatform;
  platformAccountId: string;
  /** Already decrypted. */
  accessToken: string;
  /** Our own latest channel_snapshots.followers_count; null when unknown. */
  followersCount: number | null;
}

type MetaBreakdown = 'country' | 'city' | 'age' | 'gender';
const META_BREAKDOWNS: readonly MetaBreakdown[] = [
  'country',
  'city',
  'age',
  'gender',
];

function emptyRow(
  status: StoredAudienceStatus,
  followerCount: number | null,
): AudienceRow {
  return {
    status,
    followerCount,
    countries: [],
    cities: [],
    ages: [],
    genders: [],
  };
}

/**
 * Fetches one channel's audience breakdown and folds it into a row. Never
 * throws: a platform error becomes the row's status with every array empty
 * (all-or-nothing, so a half-filled row never looks complete).
 */
export async function refreshAudience(
  channel: RefreshChannel,
  deps: RefreshDeps,
): Promise<AudienceRow> {
  const { platform, platformAccountId, accessToken, followersCount } = channel;

  try {
    if (platform === 'instagram' || platform === 'threads') {
      // Decided from our own snapshot, never from a Meta error string.
      if (
        followersCount === null ||
        followersCount < MIN_FOLLOWERS_FOR_DEMOGRAPHICS
      ) {
        return emptyRow('below_threshold', followersCount);
      }
      const fetchBreakdown = (b: MetaBreakdown): Promise<unknown> =>
        platform === 'instagram'
          ? deps.instagram.getFollowerDemographics(
              platformAccountId,
              accessToken,
              b,
            )
          : deps.threads.getFollowerDemographics(accessToken, b);
      const bodies = await Promise.all(META_BREAKDOWNS.map(fetchBreakdown));
      const [countries, cities, ages, genders] = bodies.map((body, i) =>
        metaBreakdown(body, META_BREAKDOWNS[i]),
      );
      return {
        status: 'ok',
        followerCount: followersCount,
        countries,
        cities,
        ages,
        genders,
      };
    }

    if (platform === 'facebook') {
      const [countryBody, cityBody] = await Promise.all([
        deps.facebook.getPageFollowsLocation(
          platformAccountId,
          accessToken,
          'page_follows_country',
        ),
        deps.facebook.getPageFollowsLocation(
          platformAccountId,
          accessToken,
          'page_follows_city',
        ),
      ]);
      return {
        status: 'ok',
        followerCount: followersCount,
        countries: facebookLocation(countryBody),
        cities: facebookLocation(cityBody),
        ages: [],
        genders: [],
      };
    }

    return emptyRow('unsupported', followersCount);
  } catch (err) {
    return emptyRow(statusOfError(err), followersCount);
  }
}
