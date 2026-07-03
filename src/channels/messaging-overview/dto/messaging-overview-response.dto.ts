export class MessagingChannelsDto {
  total!: number;
  public!: number;
  private!: number;
}

export class MessagingStatsDto {
  channels!: MessagingChannelsDto;
  members!: number;
  messages30d!: number;
  botActiveIn!: number;
}

export class MessagingActivityPointDto {
  label!: string;
  messages!: number;
}

export class MessagingTopChannelDto {
  id!: string;
  name!: string;
  isPrivate!: boolean;
  messages!: number;
}

export class MessagingChannelMixSliceDto {
  label!: string;
  value!: number;
}

export class MessagingOverviewResponseDto {
  stats!: MessagingStatsDto;
  activity!: MessagingActivityPointDto[];
  topChannels!: MessagingTopChannelDto[];
  channelMix!: MessagingChannelMixSliceDto[];
}
