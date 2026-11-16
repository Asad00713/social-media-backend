import { ne, sql, type SQL } from 'drizzle-orm';
import { socialMediaChannels } from '../../drizzle/schema/channels.schema';

/**
 * A disconnected channel (soft disconnect, migration 0081) is a row kept as
 * HISTORY: it never publishes, syncs, polls, ingests or counts toward the
 * channel limit, and no picker offers it. Every read that USES a channel
 * filters it out with one of these; reads that show history (insights of
 * past posts, the Channels page, the Planner) keep it.
 */
export const DISCONNECTED_STATUS = 'disconnected' as const;

/** Drizzle condition: the channel is not disconnected. */
export function liveChannel(): SQL {
  return ne(socialMediaChannels.connectionStatus, DISCONNECTED_STATUS);
}

/**
 * The same condition for raw SQL. `alias` is the table alias the query uses
 * for social_media_channels (omit it when the column is unqualified).
 */
export function liveChannelSql(alias?: string): SQL {
  const column = alias ? `${alias}.connection_status` : 'connection_status';
  return sql.raw(`${column} <> '${DISCONNECTED_STATUS}'`);
}

/** True when a channel row is disconnected. */
export function isDisconnected(channel: {
  connectionStatus: string | null;
}): boolean {
  return channel.connectionStatus === DISCONNECTED_STATUS;
}
