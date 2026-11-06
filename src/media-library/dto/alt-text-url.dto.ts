import { IsUrl, MaxLength } from 'class-validator';

/** `POST alt-text` — a draft photo, by the URL our storage gave it. */
export class AltTextForUrlDto {
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2048)
  url: string;
}
