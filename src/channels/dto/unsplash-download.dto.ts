import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * POST /channels/unsplash/download. The value is Unsplash's own
 * `links.download_location`; UnsplashService.trackDownload refuses anything
 * that is not an https://api.unsplash.com URL.
 */
export class TrackUnsplashDownloadDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  downloadLocation!: string;
}
