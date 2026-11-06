import type { FacebookPageLocation } from './services/facebook.service';

/** One of the workspace's Facebook Pages, for the composer's pickers. */
export interface FacebookWorkspacePage {
  channelId: number;
  /** The Page id - what `place` and a Reel collaborator's `target_id` take. */
  pageId: string;
  name: string;
  /**
   * "City, Country" when the Page has a location, else null. Only a Page
   * with one can be a post's `place` ("only pages with valid locations can
   * be used", Reels publishing guide).
   */
  location: string | null;
  /** The Page this draft posts from: a place, but never its own collaborator. */
  isSelf: boolean;
}

interface Deps {
  listFacebookChannels: () => Promise<
    { id: number; platformAccountId: string; accountName: string }[]
  >;
  getAccessToken: (channelId: number) => Promise<string>;
  getPageLocation: (
    pageId: string,
    accessToken: string,
  ) => Promise<FacebookPageLocation>;
}

/**
 * The workspace's connected Facebook Pages, each with its location.
 *
 * Why only these: a `place` is a Page id, and choosing ANY place means the
 * Pages Search API, which needs a user token we do not keep. Every Page here
 * has its own token, so its location can be read without one. A Page whose
 * location cannot be read is still listed (it can be a collaborator), with
 * `location: null`, rather than failing the whole list.
 */
export async function listFacebookWorkspacePages(
  selfChannelId: number,
  deps: Deps,
): Promise<FacebookWorkspacePage[]> {
  const channels = await deps.listFacebookChannels();
  return Promise.all(
    channels.map(async (channel) => {
      let location: string | null = null;
      try {
        const token = await deps.getAccessToken(channel.id);
        location = (
          await deps.getPageLocation(channel.platformAccountId, token)
        ).location;
      } catch {
        location = null;
      }
      return {
        channelId: channel.id,
        pageId: channel.platformAccountId,
        name: channel.accountName,
        location,
        isSelf: channel.id === selfChannelId,
      };
    }),
  );
}
