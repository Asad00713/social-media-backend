import { IsUrl, MaxLength } from 'class-validator';

/** Query for `GET .../link-preview` - one page to read, https only. */
export class LinkPreviewQueryDto {
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2048)
  url!: string;
}
