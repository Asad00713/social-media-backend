export class FreshnessDto {
  lastSyncedAt!: string | null;
  dataFreshness!: 'realtime' | 'hourly' | 'daily';
  isPartial!: boolean;
  trackingSinceDate!: string | null;
  gapDays!: number;
}
