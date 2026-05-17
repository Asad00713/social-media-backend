import type { InferSelectModel } from 'drizzle-orm';
import type { socialMediaChannels } from '../../../drizzle/schema/channels.schema';

export type ChannelEntity = InferSelectModel<typeof socialMediaChannels>;
