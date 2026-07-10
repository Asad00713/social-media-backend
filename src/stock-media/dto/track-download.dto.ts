import { IsUrl } from 'class-validator';

export class TrackDownloadDto {
  @IsUrl({ protocols: ['https'], require_protocol: true })
  downloadTriggerUrl: string;
}
