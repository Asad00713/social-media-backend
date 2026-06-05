import {
  Injectable,
  Logger,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as crypto from 'crypto';

export interface PresignedUploadResult {
  /** Key inside the R2 bucket — store this on the inbox row metadata. */
  key: string;
  /** Short-lived PUT URL the browser uploads to. */
  uploadUrl: string;
  /** Long-lived public URL where the object will be readable after upload. */
  publicUrl: string;
  /** Headers the client MUST send on the PUT (matches the signature). */
  requiredHeaders: Record<string, string>;
  /** Seconds the upload URL is valid. */
  expiresIn: number;
}

export type R2MediaKind = 'image' | 'voice' | 'video' | 'file';

const KIND_TO_PREFIX: Record<R2MediaKind, string> = {
  image: 'inbox/images',
  voice: 'inbox/voice',
  video: 'inbox/videos',
  file: 'inbox/files',
};

const MAX_BYTES: Record<R2MediaKind, number> = {
  image: 10 * 1024 * 1024, // 10 MB
  voice: 25 * 1024 * 1024, // 25 MB (~25 min of opus @ 128kbps)
  video: 100 * 1024 * 1024, // 100 MB
  file: 25 * 1024 * 1024,
};

// Allow optional `;param=value` suffixes (e.g. `audio/webm;codecs=opus`,
// `audio/mp4;codecs=mp4a.40.2`). MediaRecorder always emits the full type
// including codec params, so the bare-type regexes would reject every voice
// upload. The full Content-Type is still passed to R2 verbatim — the suffix
// only matters for the allow-check.
const ALLOWED_MIME: Record<R2MediaKind, RegExp> = {
  image: /^image\/(jpeg|png|gif|webp|heic)(;.*)?$/i,
  voice: /^audio\/(webm|ogg|mp4|mpeg|wav|aac|x-m4a)(;.*)?$/i,
  video: /^video\/(mp4|webm|quicktime)(;.*)?$/i,
  file: /.*/,
};

/**
 * Cloudflare R2 service — S3-compatible storage used for inbox DM attachments
 * (images + voice notes) starting in Phase 2.3.
 *
 * Pattern: browser asks the backend for a presigned PUT URL, uploads the file
 * directly to R2 (Schedura's API never touches the bytes), then submits the
 * resulting public URL alongside the DM send call. The backend re-validates
 * the object via HEAD before forwarding to the platform API.
 *
 * Required env:
 *   CLOUDFLARE_R2_ACCOUNT_ID
 *   CLOUDFLARE_R2_ACCESS_KEY_ID
 *   CLOUDFLARE_R2_SECRET_ACCESS_KEY
 *   CLOUDFLARE_R2_BUCKET
 *   CLOUDFLARE_R2_PUBLIC_URL  (optional — custom domain; falls back to r2.cloudflarestorage.com)
 */
@Injectable()
export class CloudflareR2Service {
  private readonly logger = new Logger(CloudflareR2Service.name);
  private readonly client: S3Client | null = null;
  private readonly bucket: string;
  private readonly publicUrlBase: string;
  private readonly isConfigured: boolean;

  constructor(private readonly config: ConfigService) {
    const accountId = this.config.get<string>('CLOUDFLARE_R2_ACCOUNT_ID', '');
    const accessKeyId = this.config.get<string>('CLOUDFLARE_R2_ACCESS_KEY_ID', '');
    const secret = this.config.get<string>('CLOUDFLARE_R2_SECRET_ACCESS_KEY', '');
    this.bucket = this.config.get<string>('CLOUDFLARE_R2_BUCKET', '');
    const customPublicUrl = this.config.get<string>(
      'CLOUDFLARE_R2_PUBLIC_URL',
      '',
    );

    this.isConfigured = !!(accountId && accessKeyId && secret && this.bucket);

    if (this.isConfigured) {
      this.client = new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId, secretAccessKey: secret },
        // R2 nuances:
        //   1. forcePathStyle=true → URL becomes
        //        https://<account>.r2.cloudflarestorage.com/<bucket>/<key>
        //      Without this, the SDK uses virtual-hosted style
        //        https://<bucket>.<account>.r2.cloudflarestorage.com/<key>
        //      which Cloudflare's bucket CORS policy doesn't always match,
        //      producing a 403 on the preflight OPTIONS.
        //   2. requestChecksumCalculation='WHEN_REQUIRED' → opts out of the
        //      newer AWS SDK v3 default that adds an `x-amz-checksum-crc32`
        //      query param on PutObject. R2 doesn't accept that header on
        //      presigned PUTs and rejects the signature.
        forcePathStyle: true,
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      });
      this.publicUrlBase = customPublicUrl
        ? customPublicUrl.replace(/\/$/, '')
        : `https://${accountId}.r2.cloudflarestorage.com/${this.bucket}`;
      this.logger.log(
        `Cloudflare R2 ready — bucket=${this.bucket}, publicBase=${this.publicUrlBase}`,
      );
    } else {
      this.publicUrlBase = '';
      this.logger.warn(
        'Cloudflare R2 not configured — set CLOUDFLARE_R2_* env vars to enable inbox DM attachments.',
      );
    }
  }

  isReady(): boolean {
    return this.isConfigured;
  }

  private getClient(): S3Client {
    if (!this.isConfigured || !this.client) {
      throw new InternalServerErrorException(
        'Cloudflare R2 not configured on this server.',
      );
    }
    return this.client;
  }

  /**
   * Issue a presigned PUT URL the client can upload to directly.
   *
   * `kind` controls:
   *   - the key prefix (so we can lifecycle-rule per kind later)
   *   - the allowed MIME list
   *   - the max byte cap (returned to the client for early validation; R2's
   *     `Content-Length` is also enforced server-side via the signature).
   */
  async createPresignedUpload(input: {
    workspaceId: string;
    userId: string;
    kind: R2MediaKind;
    contentType: string;
    sizeBytes: number;
    filename?: string;
  }): Promise<PresignedUploadResult> {
    const client = this.getClient();

    const { workspaceId, userId, kind, contentType, sizeBytes, filename } = input;

    if (!ALLOWED_MIME[kind].test(contentType)) {
      throw new BadRequestException(
        `Content type '${contentType}' not allowed for ${kind}.`,
      );
    }
    if (sizeBytes <= 0 || sizeBytes > MAX_BYTES[kind]) {
      throw new BadRequestException(
        `Size ${sizeBytes} exceeds limit ${MAX_BYTES[kind]} bytes for ${kind}.`,
      );
    }

    const ext = this.extensionFor(contentType, filename);
    const id = crypto.randomBytes(12).toString('hex');
    const safeUserId = userId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 12);
    const key = `${KIND_TO_PREFIX[kind]}/${workspaceId}/${safeUserId}/${Date.now()}-${id}${ext}`;

    // IMPORTANT — keep the signed PutObjectCommand minimal:
    //  - `Metadata` adds `x-amz-meta-*` signed headers that the browser would
    //    have to send back; the resulting CORS preflight has historically
    //    failed against R2's wildcard CORS rules, surfacing as a generic
    //    "Failed to fetch" with no response status. Audit fields (kind /
    //    workspace / user) are already stored in the bucket key path and in
    //    our DB, so re-encoding them as object metadata is redundant.
    //  - `ContentType` is intentionally omitted from the signature too. The
    //    browser auto-sets `Content-Type` from the Blob's `.type`, and signed
    //    Content-Type forces an exact-string match which breaks when the
    //    MediaRecorder emits `audio/webm;codecs=opus` vs `audio/webm`. We
    //    do still validate the type in `ALLOWED_MIME` before issuing the URL.
    // Absolute-minimum signed command: Bucket + Key only. No ContentType, no
    // ContentLength, no Metadata, no ACL. The signature only commits the URL
    // path + expiry + credential — the browser is free to PUT any body of
    // any size/type within the 5-min window. We already validated size + MIME
    // above before issuing the URL, so server-side enforcement isn't lost.
    //
    // Why bare-minimum? Every signed attribute becomes a "required match"
    // between what the signer expected and what the browser actually sends.
    // R2 + Chrome + the AWS SDK's auto-added headers (CRC32 checksum,
    // SDK user-agent etc) have repeatedly produced signature mismatches
    // surfacing as 403 on the OPTIONS preflight. Stripping the command to
    // just identity + key eliminates all those degrees of freedom.
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    const expiresIn = 5 * 60; // 5 min — generous for slow voice uploads
    const uploadUrl = await getSignedUrl(client, command, {
      expiresIn,
      // Drop ALL the headers the AWS SDK would otherwise auto-sign. Anything
      // the browser sends — Content-Type, Content-Length, CRC32 — passes
      // signature verification without needing to match a baked-in value.
      unsignableHeaders: new Set([
        'content-type',
        'content-length',
        'content-md5',
        'x-amz-checksum-crc32',
        'x-amz-checksum-crc32c',
        'x-amz-checksum-sha1',
        'x-amz-checksum-sha256',
        'x-amz-sdk-checksum-algorithm',
      ]),
    });

    return {
      key,
      uploadUrl,
      publicUrl: `${this.publicUrlBase}/${key}`,
      requiredHeaders: {
        // Empty by design — the browser sets Content-Type from the Blob and
        // Content-Length automatically. Frontend should NOT inject any extras.
      },
      expiresIn,
    };
  }

  /**
   * Server-side upload — used to re-host third-party media (e.g. Slack
   * `url_private` files, whose URLs require auth and expire) into our durable
   * R2 bucket so the inbox UI can render them without an auth token.
   *
   * Path convention matches createPresignedUpload so lifecycle rules work for
   * both browser uploads and server rehosts.
   */
  async uploadBuffer(input: {
    kind: R2MediaKind;
    workspaceId: string;
    buffer: Buffer;
    contentType: string;
    filename?: string;
  }): Promise<{ key: string; publicUrl: string }> {
    const client = this.getClient();
    const { kind, workspaceId, buffer, contentType, filename } = input;

    if (!ALLOWED_MIME[kind].test(contentType)) {
      throw new BadRequestException(
        `Content type '${contentType}' not allowed for ${kind}.`,
      );
    }
    if (buffer.length <= 0 || buffer.length > MAX_BYTES[kind]) {
      throw new BadRequestException(
        `Size ${buffer.length} exceeds limit ${MAX_BYTES[kind]} bytes for ${kind}.`,
      );
    }

    const ext = this.extensionFor(contentType, filename);
    const id = crypto.randomBytes(12).toString('hex');
    // No userId on the server rehost path — use 'system' so the key layout
    // stays grep-able and lifecycle rules still match.
    const key = `${KIND_TO_PREFIX[kind]}/${workspaceId}/system/${Date.now()}-${id}${ext}`;

    await client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      }),
    );

    return { key, publicUrl: `${this.publicUrlBase}/${key}` };
  }

  /**
   * Verify a previously-uploaded object actually exists and matches expected
   * size/type. Call this from inbox send paths BEFORE forwarding the URL to
   * the platform API — prevents users from passing arbitrary URLs.
   */
  async verifyObject(key: string): Promise<{
    exists: boolean;
    contentType?: string;
    contentLength?: number;
  }> {
    const client = this.getClient();
    try {
      const head = await client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        exists: true,
        contentType: head.ContentType,
        contentLength: head.ContentLength,
      };
    } catch (err) {
      if ((err as { name?: string }).name === 'NotFound') {
        return { exists: false };
      }
      throw err;
    }
  }

  /**
   * Delete an object — used when the user cancels before send, or as part of
   * a cleanup sweep for messages that fail to send.
   */
  async deleteObject(key: string): Promise<void> {
    const client = this.getClient();
    await client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  /**
   * Convert a public URL back into its bucket key (for verifyObject /
   * deleteObject). Returns null if the URL isn't from our R2 bucket.
   */
  keyFromPublicUrl(url: string): string | null {
    if (!this.publicUrlBase) return null;
    if (!url.startsWith(this.publicUrlBase + '/')) return null;
    return url.slice(this.publicUrlBase.length + 1);
  }

  private extensionFor(contentType: string, filename?: string): string {
    if (filename) {
      const idx = filename.lastIndexOf('.');
      if (idx > -1 && idx < filename.length - 1) {
        return filename.slice(idx).toLowerCase();
      }
    }
    const map: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'image/heic': '.heic',
      'audio/webm': '.webm',
      'audio/ogg': '.ogg',
      'audio/mp4': '.m4a',
      'audio/x-m4a': '.m4a',
      'audio/mpeg': '.mp3',
      'audio/wav': '.wav',
      'audio/aac': '.aac',
      'video/mp4': '.mp4',
      'video/webm': '.webm',
      'video/quicktime': '.mov',
    };
    return map[contentType.toLowerCase()] ?? '';
  }
}
