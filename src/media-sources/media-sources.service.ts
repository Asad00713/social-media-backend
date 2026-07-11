import { Injectable, BadRequestException } from '@nestjs/common';
import { ChannelService } from '../channels/services/channel.service';
import { DropboxService } from '../channels/services/dropbox.service';
import { GoogleDriveService } from '../channels/services/google-drive.service';
import { OneDriveService } from '../channels/services/onedrive.service';
import { GooglePhotosService } from '../channels/services/google-photos.service';
import { CloudinaryService } from '../media/cloudinary.service';
import { mapDropboxItem, mapDropboxFolder } from './mappers/dropbox.mapper';
import { mapDriveItem, mapDriveFolder } from './mappers/drive.mapper';
import { mapOneDriveItem, mapOneDriveFolder } from './mappers/onedrive.mapper';
import { mapPhotosItem, mapPhotosAlbum } from './mappers/photos.mapper';
import type {
  CloudBrowseResult,
  CloudImportResult,
  CloudStoragePlatform,
  BrowseKind,
} from './media-sources.types';

interface BrowseArgs {
  kind: BrowseKind;
  path?: string;
  query?: string;
  cursor?: string;
  limit?: number;
}

interface ImportArgs {
  fileId: string;
  kind: 'image' | 'video';
}

@Injectable()
export class MediaSourcesService {
  private readonly CLOUD = new Set<CloudStoragePlatform>([
    'dropbox',
    'google_drive',
    'onedrive',
    'google_photos',
  ]);

  constructor(
    private readonly channelService: ChannelService,
    private readonly dropbox: DropboxService,
    private readonly drive: GoogleDriveService,
    private readonly onedrive: OneDriveService,
    private readonly photos: GooglePhotosService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  async browse(
    workspaceId: string,
    channelId: number,
    args: BrowseArgs,
  ): Promise<CloudBrowseResult> {
    const channel = await this.channelService.getChannelById(
      channelId,
      workspaceId,
    );
    const platform = channel.platform as CloudStoragePlatform;
    if (!this.CLOUD.has(platform)) {
      throw new BadRequestException('Channel is not a cloud storage source');
    }
    const token = await this.channelService.getAccessToken(
      channelId,
      workspaceId,
    );

    switch (platform) {
      case 'dropbox':
        return this.browseDropbox(token, args);
      case 'google_drive':
        return this.browseDrive(token, args);
      case 'onedrive':
        return this.browseOneDrive(token, args);
      case 'google_photos':
        return this.browsePhotos(token, args);
    }
  }

  async import(
    workspaceId: string,
    channelId: number,
    args: ImportArgs,
  ): Promise<CloudImportResult> {
    const channel = await this.channelService.getChannelById(
      channelId,
      workspaceId,
    );
    const platform = channel.platform as CloudStoragePlatform;
    if (!this.CLOUD.has(platform)) {
      throw new BadRequestException('Channel is not a cloud storage source');
    }
    const token = await this.channelService.getAccessToken(
      channelId,
      workspaceId,
    );

    const buffer = await this.downloadBuffer(platform, token, args.fileId);
    const up = await this.cloudinary.uploadFromBuffer(buffer, {
      folder: 'composer/cloud',
      resourceType: 'auto',
    });
    const type = up.resourceType === 'video' ? 'video' : 'image';

    return {
      url: up.secureUrl,
      type,
      width: up.width,
      height: up.height,
      durationSec: up.duration,
      sizeBytes: up.bytes,
    };
  }

  private async downloadBuffer(
    platform: CloudStoragePlatform,
    token: string,
    fileId: string,
  ): Promise<Buffer> {
    switch (platform) {
      case 'dropbox':
        return this.dropbox.downloadFile(token, fileId);
      case 'google_drive':
        return this.drive.downloadFile(token, fileId);
      case 'onedrive':
        return this.onedrive.downloadFile(token, fileId);
      case 'google_photos': {
        const mediaItem = await this.photos.getMediaItem(token, fileId);
        return this.photos.downloadMediaItem(token, mediaItem);
      }
    }
  }

  private async browseDropbox(
    token: string,
    a: BrowseArgs,
  ): Promise<CloudBrowseResult> {
    if (a.kind === 'folders') {
      const res = await this.dropbox.listFolders(token, {
        path: a.path,
        limit: a.limit,
        cursor: a.cursor,
      });
      return {
        items: [],
        folders: res.entries.map(mapDropboxFolder),
        nextCursor: res.has_more ? res.cursor : undefined,
      };
    }

    if (a.kind === 'search') {
      const res = await this.dropbox.searchFiles(token, a.query ?? '', {
        path: a.path,
        maxResults: a.limit,
        cursor: a.cursor,
      });
      return {
        items: res.matches
          .filter((e) => !!e && e['.tag'] === 'file')
          .map(mapDropboxItem),
        folders: [],
        nextCursor: res.has_more ? res.cursor : undefined,
      };
    }

    const options = { path: a.path, limit: a.limit, cursor: a.cursor };
    const res =
      a.kind === 'images'
        ? await this.dropbox.listImages(token, options)
        : a.kind === 'videos'
          ? await this.dropbox.listVideos(token, options)
          : await this.dropbox.listMedia(token, options);
    return {
      items: res.entries.map(mapDropboxItem),
      folders: [],
      nextCursor: res.has_more ? res.cursor : undefined,
    };
  }

  private async browseDrive(
    token: string,
    a: BrowseArgs,
  ): Promise<CloudBrowseResult> {
    if (a.kind === 'folders') {
      const res = await this.drive.listFolders(token, {
        parentId: a.path,
        pageSize: a.limit,
        pageToken: a.cursor,
      });
      return {
        items: [],
        folders: res.folders.map(mapDriveFolder),
        nextCursor: res.nextPageToken,
      };
    }

    const options = {
      folderId: a.path,
      pageSize: a.limit,
      pageToken: a.cursor,
    };
    const res =
      a.kind === 'images'
        ? await this.drive.listImages(token, options)
        : a.kind === 'videos'
          ? await this.drive.listVideos(token, options)
          : await this.drive.listMedia(token, {
              ...options,
              query: a.kind === 'search' ? a.query : undefined,
            });
    return {
      items: res.files.map(mapDriveItem),
      folders: [],
      nextCursor: res.nextPageToken,
    };
  }

  /**
   * OneDrive's browse relays Microsoft Graph's raw `@odata.nextLink` URL to the
   * client as `nextCursor`, and the client sends it back as `cursor`. Since
   * OneDriveService uses that value verbatim as the fetch URL (with the
   * user's OAuth bearer token attached), an unvalidated cursor lets a
   * malicious client redirect the server's OneDrive access token to an
   * arbitrary host (SSRF + token exfiltration). Only forward cursors that
   * are well-formed URLs pointing at the real Graph API host.
   */
  private assertGraphCursor(cursor?: string): void {
    if (!cursor) return;
    let url: URL;
    try {
      url = new URL(cursor);
    } catch {
      throw new BadRequestException('Invalid OneDrive pagination cursor');
    }
    if (url.origin !== 'https://graph.microsoft.com') {
      throw new BadRequestException('Invalid OneDrive pagination cursor');
    }
  }

  private async browseOneDrive(
    token: string,
    a: BrowseArgs,
  ): Promise<CloudBrowseResult> {
    this.assertGraphCursor(a.cursor);
    if (a.kind === 'folders') {
      const res = await this.onedrive.listFolders(token, {
        parentId: a.path,
        pageSize: a.limit,
        nextLink: a.cursor,
      });
      return {
        items: [],
        folders: res.items.map(mapOneDriveFolder),
        nextCursor: res.nextLink,
      };
    }

    if (a.kind === 'search') {
      const res = await this.onedrive.searchFiles(token, a.query ?? '', {
        pageSize: a.limit,
        nextLink: a.cursor,
      });
      return {
        items: res.items.filter((i) => !!i.file).map(mapOneDriveItem),
        folders: [],
        nextCursor: res.nextLink,
      };
    }

    const options = {
      folderId: a.path,
      pageSize: a.limit,
      nextLink: a.cursor,
    };
    const res =
      a.kind === 'images'
        ? await this.onedrive.listImages(token, options)
        : a.kind === 'videos'
          ? await this.onedrive.listVideos(token, options)
          : await this.onedrive.listMedia(token, options);
    return {
      items: res.items.map(mapOneDriveItem),
      folders: [],
      nextCursor: res.nextLink,
    };
  }

  private async browsePhotos(
    token: string,
    a: BrowseArgs,
  ): Promise<CloudBrowseResult> {
    if (a.kind === 'folders') {
      const res = await this.photos.listAlbums(token, {
        pageSize: a.limit,
        pageToken: a.cursor,
      });
      return {
        items: [],
        folders: res.albums.map(mapPhotosAlbum),
        nextCursor: res.nextPageToken,
      };
    }

    // 'search' has no text-filter concept for Photos; treat as listMediaItems.
    const options = {
      pageSize: a.limit,
      pageToken: a.cursor,
      albumId: a.path,
    };
    const res =
      a.kind === 'images'
        ? await this.photos.listPhotos(token, options)
        : a.kind === 'videos'
          ? await this.photos.listVideos(token, options)
          : await this.photos.listMediaItems(token, options);
    return {
      items: res.mediaItems.map(mapPhotosItem),
      folders: [],
      nextCursor: res.nextPageToken,
    };
  }
}
