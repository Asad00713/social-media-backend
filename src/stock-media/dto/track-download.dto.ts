import { IsUrl } from 'class-validator';

export class TrackDownloadDto {
  @IsUrl({ require_protocol: true })
  downloadTriggerUrl: string;
}
