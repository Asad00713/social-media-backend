/** A channel as the Workspaces hub shows it: a logo in the card's footer. */
export interface HubChannelDto {
  id: number;
  platform: string;
  accountName: string;
  avatarUrl: string | null;
}

/** A member as the Workspaces hub shows it: an avatar in the card's footer. */
export interface HubMemberDto {
  id: string;
  /** The person's name, or the part of their email before the @. */
  name: string;
  avatarUrl: string | null;
  avatarColor: string | null;
}

export interface WorkspaceHubSummaryDto {
  workspaceId: string;
  /** Active social channels. Messaging channels and integrations are left out. */
  channelCount: number;
  /** The oldest few of those channels, for the logo stack. */
  channels: HubChannelDto[];
  /** Every active social channel that has to be reconnected. */
  reconnect: HubChannelDto[];
  /** The owner plus everyone who accepted an invitation. */
  memberCount: number;
  /** The owner first, then members in the order they joined. */
  members: HubMemberDto[];
  /** Posts still scheduled to go out in the next 7 days. */
  scheduledNext7Days: number;
}

export interface WorkspaceHubDto {
  workspaces: WorkspaceHubSummaryDto[];
}
