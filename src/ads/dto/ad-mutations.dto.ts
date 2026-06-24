import { IsIn, IsInt, Min } from 'class-validator';

export class UpdateCampaignStatusDto {
  @IsIn(['ACTIVE', 'PAUSED', 'ARCHIVED'])
  status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
}

export class UpdateAdSetBudgetDto {
  @IsInt()
  @Min(100)
  dailyBudgetMinor: number;
}
