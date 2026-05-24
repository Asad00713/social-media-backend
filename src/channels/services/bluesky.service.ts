import { Injectable, Logger, BadRequestException } from '@nestjs/common';

export interface BlueskySession {
  did: string; // Decentralized Identifier
  handle: string;
  accessJwt: string;
  refreshJwt: string;
}

export interface BlueskyProfile {
  did: string;
  handle: string;
  displayName: string | null;
  description: string | null;
  avatar: string | null;
  banner: string | null;
  followersCount: number;
  followsCount: number;
  postsCount: number;
}

export interface BlueskyPost {
  uri: string;
  cid: string;
}

export interface BlueskyBlob {
  $type: 'blob';
  ref: {
    $link: string;
  };
  mimeType: string;
  size: number;
}

export interface BlueskyPostRef {
  uri: string;
  cid: string;
}

/**
 * Reply reference accepted by createTextPost / createImagePost.
 *
 * - Shorthand `{ uri, cid }` — used when replying directly to a top-level post
 *   (the same ref becomes both root and parent). Backward-compat for callers
 *   that don't track a thread root.
 * - Explicit `{ root, parent }` — required for multi-level thread chains
 *   (AT Protocol expects root = first post in the thread, parent = the
 *   immediately preceding post).
 */
export type BlueskyReplyRef =
  | BlueskyPostRef
  | { root: BlueskyPostRef; parent: BlueskyPostRef };

function normalizeReply(
  ref: BlueskyReplyRef | undefined,
): { root: BlueskyPostRef; parent: BlueskyPostRef } | undefined {
  if (!ref) return undefined;
  if ('root' in ref && 'parent' in ref) return { root: ref.root, parent: ref.parent };
  return { root: ref, parent: ref };
}

@Injectable()
export class BlueskyService {
  private readonly logger = new Logger(BlueskyService.name);
  private readonly apiBaseUrl = 'https://bsky.social/xrpc';

  /**
   * Create a session using identifier (handle/email) and app password
   * This is the primary authentication method for Bluesky
   */
  async createSession(
    identifier: string,
    appPassword: string,
  ): Promise<BlueskySession> {
    const response = await fetch(
      `${this.apiBaseUrl}/com.atproto.server.createSession`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          identifier,
          password: appPassword,
        }),
      },
    );

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to create Bluesky session: ${errorData}`);

      if (response.status === 401) {
        throw new BadRequestException('Invalid Bluesky credentials. Make sure you\'re using an App Password, not your account password.');
      }

      throw new BadRequestException(`Failed to authenticate with Bluesky: ${errorData}`);
    }

    const data = await response.json();

    return {
      did: data.did,
      handle: data.handle,
      accessJwt: data.accessJwt,
      refreshJwt: data.refreshJwt,
    };
  }

  /**
   * Refresh the session using a refresh token
   */
  async refreshSession(refreshJwt: string): Promise<BlueskySession> {
    const response = await fetch(
      `${this.apiBaseUrl}/com.atproto.server.refreshSession`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${refreshJwt}`,
        },
      },
    );

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to refresh Bluesky session: ${errorData}`);
      throw new BadRequestException('Failed to refresh Bluesky session. Please reconnect your account.');
    }

    const data = await response.json();

    return {
      did: data.did,
      handle: data.handle,
      accessJwt: data.accessJwt,
      refreshJwt: data.refreshJwt,
    };
  }

  /**
   * Get the authenticated user's profile
   */
  async getProfile(accessJwt: string, actor: string): Promise<BlueskyProfile> {
    const response = await fetch(
      `${this.apiBaseUrl}/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`,
      {
        headers: {
          Authorization: `Bearer ${accessJwt}`,
        },
      },
    );

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to get Bluesky profile: ${errorData}`);
      throw new BadRequestException('Failed to fetch Bluesky profile');
    }

    const data = await response.json();

    return {
      did: data.did,
      handle: data.handle,
      displayName: data.displayName || null,
      description: data.description || null,
      avatar: data.avatar || null,
      banner: data.banner || null,
      followersCount: data.followersCount || 0,
      followsCount: data.followsCount || 0,
      postsCount: data.postsCount || 0,
    };
  }

  /**
   * Create a text-only post
   */
  async createTextPost(
    accessJwt: string,
    did: string,
    text: string,
    replyTo?: BlueskyReplyRef,
  ): Promise<BlueskyPost> {
    const record: Record<string, any> = {
      $type: 'app.bsky.feed.post',
      text,
      createdAt: new Date().toISOString(),
    };

    // Parse facets (mentions, links, hashtags)
    const facets = await this.parseFacets(text);
    if (facets.length > 0) {
      record.facets = facets;
    }

    // Add reply reference if replying to another post
    const reply = normalizeReply(replyTo);
    if (reply) record.reply = reply;

    return this.createRecord(accessJwt, did, 'app.bsky.feed.post', record);
  }

  /**
   * Create a post with images
   */
  async createImagePost(
    accessJwt: string,
    did: string,
    text: string,
    imageUrls: string[],
    altTexts?: string[],
    replyTo?: BlueskyReplyRef,
  ): Promise<BlueskyPost> {
    // Upload all images first
    const images: Array<{ alt: string; image: BlueskyBlob }> = [];

    for (let i = 0; i < imageUrls.length && i < 4; i++) {
      const imageUrl = imageUrls[i];
      const altText = altTexts?.[i] || '';

      // Download image from URL
      const imageResponse = await fetch(imageUrl);
      if (!imageResponse.ok) {
        throw new BadRequestException(`Failed to fetch image: ${imageUrl}`);
      }

      const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
      const mimeType = imageResponse.headers.get('content-type') || 'image/jpeg';

      // Upload to Bluesky
      const blob = await this.uploadBlob(accessJwt, imageBuffer, mimeType);
      images.push({
        alt: altText,
        image: blob,
      });
    }

    const record: Record<string, any> = {
      $type: 'app.bsky.feed.post',
      text,
      createdAt: new Date().toISOString(),
      embed: {
        $type: 'app.bsky.embed.images',
        images,
      },
    };

    // Parse facets (mentions, links, hashtags)
    const facets = await this.parseFacets(text);
    if (facets.length > 0) {
      record.facets = facets;
    }

    // Add reply reference if this post is part of a thread/reply chain
    const reply = normalizeReply(replyTo);
    if (reply) record.reply = reply;

    return this.createRecord(accessJwt, did, 'app.bsky.feed.post', record);
  }

  /**
   * Create a post with a video
   */
  async createVideoPost(
    accessJwt: string,
    did: string,
    text: string,
    videoUrl: string,
    altText?: string,
    replyTo?: BlueskyReplyRef,
  ): Promise<BlueskyPost> {
    // 1. Download the source video bytes.
    const videoResponse = await fetch(videoUrl);
    if (!videoResponse.ok) {
      throw new BadRequestException(`Failed to fetch video: ${videoUrl}`);
    }
    const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
    // Strip codec parameters from the content-type. Cloudinary and many CDNs
    // return values like "video/mp4; codecs=avc1" but Bluesky's video service
    // only accepts the base MIME (video/mp4 / video/mpeg / video/webm /
    // video/quicktime / image/gif) and rejects anything with parameters.
    const rawType = videoResponse.headers.get('content-type') || 'video/mp4';
    const mimeType = rawType.split(';')[0].trim().toLowerCase();

    // 2. Upload through the AT Protocol VIDEO SERVICE (video.bsky.app),
    //    not directly via uploadBlob. The direct uploadBlob path technically
    //    works but causes a race where the post hits the firehose before
    //    Bluesky's video service learns about the blob — the user sees a
    //    "Video not found" placeholder on the post for up to several minutes.
    //    The proper flow:
    //      a. Resolve the user's actual PDS host (Bluesky distributes users
    //         across many PDS instances like `stropharia.us-west.host.bsky.network`
    //         — hardcoding `bsky.social` produces a token audience mismatch).
    //      b. Get a service-auth token whose audience matches the user's PDS DID
    //      c. POST the video to video.bsky.app/xrpc/app.bsky.video.uploadVideo
    //      d. Poll getJobStatus until the video service returns a blob ref
    //      e. Embed that blob ref in the post record
    const pdsHost = await this.resolvePdsHost(did);
    const blob = await this.uploadVideoViaService(
      accessJwt,
      did,
      videoBuffer,
      mimeType,
      videoUrl,
      pdsHost,
    );

    const record: Record<string, any> = {
      $type: 'app.bsky.feed.post',
      text,
      createdAt: new Date().toISOString(),
      embed: {
        $type: 'app.bsky.embed.video',
        video: blob,
        alt: altText || '',
      },
    };

    const facets = await this.parseFacets(text);
    if (facets.length > 0) {
      record.facets = facets;
    }

    const reply = normalizeReply(replyTo);
    if (reply) record.reply = reply;

    return this.createRecord(accessJwt, did, 'app.bsky.feed.post', record);
  }

  /**
   * Uploads a video through Bluesky's dedicated video service (video.bsky.app)
   * and returns the blob ref once the video is fully processed.
   *
   * This is the production-grade path per AT Protocol docs — it guarantees
   * the video is ready before the post is published, avoiding the "Video
   * not found" placeholder that the simpler uploadBlob path produces.
   */
  /**
   * Resolve a user's DID to their PDS hostname. Bluesky now distributes
   * users across many PDS instances (e.g., `stropharia.us-west.host.bsky.network`,
   * `boletus.us-east.host.bsky.network`), so we cannot assume `bsky.social`.
   *
   *  - `did:web:domain` → host is the domain itself
   *  - `did:plc:xxx`    → fetch DID document from plc.directory and read the
   *                       `#atproto_pds` service entry's serviceEndpoint
   */
  private async resolvePdsHost(did: string): Promise<string> {
    if (did.startsWith('did:web:')) {
      // did:web:example.com → example.com
      // did:web:example.com:user → example.com/user (rare; legal but unusual)
      return did.slice('did:web:'.length).split(':')[0];
    }
    if (!did.startsWith('did:plc:')) {
      throw new BadRequestException(`Unsupported DID method: ${did}`);
    }
    const res = await fetch(`https://plc.directory/${did}`);
    if (!res.ok) {
      throw new BadRequestException(
        `Failed to resolve DID document for ${did}: HTTP ${res.status}`,
      );
    }
    const doc = (await res.json()) as {
      service?: Array<{ id: string; type: string; serviceEndpoint: string }>;
    };
    const pds = doc.service?.find(
      (s) => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer',
    );
    if (!pds?.serviceEndpoint) {
      throw new BadRequestException(
        `PDS service endpoint not found in DID document for ${did}`,
      );
    }
    try {
      return new URL(pds.serviceEndpoint).host;
    } catch {
      throw new BadRequestException(
        `Invalid PDS service endpoint URL: ${pds.serviceEndpoint}`,
      );
    }
  }

  /**
   * Bluesky's video API returns the JobStatus object in TWO different shapes
   * across different endpoints / states:
   *   - Wrapped:  { jobStatus: { jobId, state, blob?, error?, ... } }
   *   - Flat:     { jobId, state, blob?, error?, did?, ... }
   * Both are valid; normalize to a flat object so downstream code is shape-
   * agnostic.
   */
  private normalizeJobStatus(raw: Record<string, unknown> | null | undefined): {
    jobId?: string;
    state?: string;
    blob?: BlueskyBlob;
    error?: string;
    message?: string;
    did?: string;
  } {
    if (!raw || typeof raw !== 'object') return {};
    const inner =
      raw.jobStatus && typeof raw.jobStatus === 'object'
        ? (raw.jobStatus as Record<string, unknown>)
        : raw;
    return {
      jobId: typeof inner.jobId === 'string' ? inner.jobId : undefined,
      state: typeof inner.state === 'string' ? inner.state : undefined,
      blob: (inner.blob as BlueskyBlob | undefined) ?? undefined,
      error: typeof inner.error === 'string' ? inner.error : undefined,
      message: typeof inner.message === 'string' ? inner.message : undefined,
      did: typeof inner.did === 'string' ? inner.did : undefined,
    };
  }

  private async uploadVideoViaService(
    accessJwt: string,
    did: string,
    videoBuffer: Buffer,
    mimeType: string,
    videoUrl: string,
    pdsHost: string,
  ): Promise<BlueskyBlob> {
    // Step 1: get a service-auth token. We're authorizing the video service
    // to call uploadBlob on the user's PDS on the user's behalf. The
    // getServiceAuth endpoint must be called on the user's actual PDS
    // (e.g. stropharia.us-west.host.bsky.network), not the bsky.social
    // entryway — the access JWT is scoped to that specific PDS.
    const serviceAuthUrl = new URL(
      `https://${pdsHost}/xrpc/com.atproto.server.getServiceAuth`,
    );
    serviceAuthUrl.searchParams.set('aud', `did:web:${pdsHost}`);
    serviceAuthUrl.searchParams.set('lxm', 'com.atproto.repo.uploadBlob');
    serviceAuthUrl.searchParams.set(
      'exp',
      String(Math.floor(Date.now() / 1000) + 1800), // 30 min
    );

    const authRes = await fetch(serviceAuthUrl.toString(), {
      headers: { Authorization: `Bearer ${accessJwt}` },
    });
    if (!authRes.ok) {
      const errText = await authRes.text();
      this.logger.error(`getServiceAuth failed: ${errText}`);
      throw new BadRequestException(
        'Bluesky service-auth fetch failed (needed for video upload)',
      );
    }
    const { token: serviceToken } = (await authRes.json()) as { token: string };

    // Step 2: POST the video bytes to the video service.
    const filename = (() => {
      try {
        return new URL(videoUrl).pathname.split('/').pop() || 'video.mp4';
      } catch {
        return 'video.mp4';
      }
    })();
    const uploadUrl = new URL(
      'https://video.bsky.app/xrpc/app.bsky.video.uploadVideo',
    );
    uploadUrl.searchParams.set('did', did);
    uploadUrl.searchParams.set('name', filename);

    const uploadRes = await fetch(uploadUrl.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceToken}`,
        'Content-Type': mimeType,
        'Content-Length': String(videoBuffer.byteLength),
      },
      body: videoBuffer as unknown as BodyInit,
    });
    // Always parse the response body — Bluesky's video service uses non-2xx
    // status codes (e.g. HTTP 409 for `already_exists`) but those still carry
    // a meaningful jobStatus payload we can use. Don't short-circuit on
    // !res.ok; inspect the parsed shape.
    const uploadRaw = (await uploadRes
      .clone()
      .json()
      .catch(async () => {
        // Body wasn't valid JSON — fall back to raw text for diagnostics
        const text = await uploadRes.text().catch(() => '');
        return text ? { __rawText: text } : ({} as Record<string, unknown>);
      })) as Record<string, unknown>;

    if (uploadRaw.__rawText) {
      this.logger.error(
        `uploadVideo returned non-JSON body (HTTP ${uploadRes.status}): ${uploadRaw.__rawText as string}`,
      );
      throw new BadRequestException(
        `Bluesky video upload failed: HTTP ${uploadRes.status}`,
      );
    }
    // Bluesky's video API returns the JobStatus object either WRAPPED under
    // `jobStatus` (most polling responses) OR FLAT at the top level (initial
    // uploadVideo responses on a successful start). Normalize both shapes.
    const job = this.normalizeJobStatus(uploadRaw);

    // `already_exists` is NOT a real failure — Bluesky deduplicates by content
    // hash, so re-uploading the same bytes returns the original jobId with
    // state=JOB_STATE_COMPLETED. Reuse that jobId via getJobStatus.
    const isAlreadyProcessed =
      job.error === 'already_exists' &&
      job.state === 'JOB_STATE_COMPLETED' &&
      !!job.jobId;

    if (job.error && !isAlreadyProcessed) {
      if (job.error === 'unconfirmed_email') {
        throw new BadRequestException(
          'Bluesky requires email verification before video uploads. Sign in to bsky.app, go to Settings → Account → Email, and confirm your email — then RECONNECT your Bluesky channel here (the cached session token needs to be refreshed after verification), then retry.',
        );
      }
      throw new BadRequestException(`Bluesky video upload failed: ${job.error}`);
    }

    if (isAlreadyProcessed) {
      this.logger.log(
        `Bluesky already_exists — reusing existing jobId ${job.jobId}`,
      );
    }

    if (!job.jobId) {
      this.logger.error(
        `Unexpected uploadVideo response shape: ${JSON.stringify(uploadRaw)}`,
      );
      throw new BadRequestException(
        'Bluesky video upload returned an unexpected response — try again',
      );
    }

    let blob = job.blob;
    const jobId = job.jobId;

    // Step 3: poll getJobStatus until the video service returns a blob ref.
    const MAX_POLL_ATTEMPTS = 60; // 60s @ 1s interval — generous for large files
    let attempts = 0;
    while (!blob && attempts < MAX_POLL_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 1000));
      const statusUrl = new URL(
        'https://video.bsky.app/xrpc/app.bsky.video.getJobStatus',
      );
      statusUrl.searchParams.set('jobId', jobId);
      const statusRes = await fetch(statusUrl.toString(), {
        headers: { Authorization: `Bearer ${serviceToken}` },
      });
      if (!statusRes.ok) {
        const errText = await statusRes.text();
        this.logger.error(`getJobStatus failed: ${errText}`);
        throw new BadRequestException(
          'Bluesky video status check failed during processing',
        );
      }
      const statusRaw = (await statusRes.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const js = this.normalizeJobStatus(statusRaw);
      if (!js.jobId && !js.state && !js.blob) {
        this.logger.error(
          `Unexpected getJobStatus response shape: ${JSON.stringify(statusRaw)}`,
        );
        throw new BadRequestException(
          'Bluesky video processing returned an unexpected status — try again',
        );
      }
      if (js.state === 'JOB_STATE_FAILED') {
        const reason = js.message ?? js.error ?? 'unknown reason';
        if (reason === 'unconfirmed_email') {
          throw new BadRequestException(
            'Bluesky requires email verification before video uploads. Confirm your email at bsky.app, then RECONNECT the channel here.',
          );
        }
        throw new BadRequestException(`Bluesky video processing failed: ${reason}`);
      }
      if (js.blob) {
        blob = js.blob;
        break;
      }
      attempts++;
    }

    if (!blob) {
      throw new BadRequestException(
        'Bluesky video processing timed out after 60 seconds — try a smaller / shorter clip',
      );
    }

    this.logger.log(
      `Bluesky video uploaded via video service (jobId=${jobId}, attempts=${attempts})`,
    );
    return blob;
  }

  /**
   * Create a post with an external link (link card)
   */
  async createLinkPost(
    accessJwt: string,
    did: string,
    text: string,
    linkUrl: string,
    linkTitle: string,
    linkDescription?: string,
    linkThumbUrl?: string,
  ): Promise<BlueskyPost> {
    const external: Record<string, any> = {
      uri: linkUrl,
      title: linkTitle,
      description: linkDescription || '',
    };

    // Upload thumbnail if provided
    if (linkThumbUrl) {
      try {
        const thumbResponse = await fetch(linkThumbUrl);
        if (thumbResponse.ok) {
          const thumbBuffer = Buffer.from(await thumbResponse.arrayBuffer());
          const mimeType = thumbResponse.headers.get('content-type') || 'image/jpeg';
          const blob = await this.uploadBlob(accessJwt, thumbBuffer, mimeType);
          external.thumb = blob;
        }
      } catch (error) {
        this.logger.warn(`Failed to upload link thumbnail: ${error}`);
        // Continue without thumbnail
      }
    }

    const record: Record<string, any> = {
      $type: 'app.bsky.feed.post',
      text,
      createdAt: new Date().toISOString(),
      embed: {
        $type: 'app.bsky.embed.external',
        external,
      },
    };

    // Parse facets
    const facets = await this.parseFacets(text);
    if (facets.length > 0) {
      record.facets = facets;
    }

    return this.createRecord(accessJwt, did, 'app.bsky.feed.post', record);
  }

  /**
   * Upload a blob (image/video) to Bluesky
   */
  async uploadBlob(
    accessJwt: string,
    data: Buffer,
    mimeType: string,
  ): Promise<BlueskyBlob> {
    const response = await fetch(
      `${this.apiBaseUrl}/com.atproto.repo.uploadBlob`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessJwt}`,
          'Content-Type': mimeType,
        },
        body: data as unknown as BodyInit,
      },
    );

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to upload blob to Bluesky: ${errorData}`);
      throw new BadRequestException(`Failed to upload media to Bluesky: ${errorData}`);
    }

    const result = await response.json();
    return result.blob;
  }

  /**
   * Create a record (generic method for creating posts and other records)
   */
  private async createRecord(
    accessJwt: string,
    did: string,
    collection: string,
    record: Record<string, any>,
  ): Promise<BlueskyPost> {
    const response = await fetch(
      `${this.apiBaseUrl}/com.atproto.repo.createRecord`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessJwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          repo: did,
          collection,
          record,
        }),
      },
    );

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to create Bluesky record: ${errorData}`);
      throw new BadRequestException(`Failed to create post on Bluesky: ${errorData}`);
    }

    const data = await response.json();

    return {
      uri: data.uri,
      cid: data.cid,
    };
  }

  /**
   * Delete a post
   */
  async deletePost(accessJwt: string, did: string, postUri: string): Promise<void> {
    // Extract rkey from URI: at://did:plc:xxx/app.bsky.feed.post/rkey
    const parts = postUri.split('/');
    const rkey = parts[parts.length - 1];

    const response = await fetch(
      `${this.apiBaseUrl}/com.atproto.repo.deleteRecord`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessJwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          repo: did,
          collection: 'app.bsky.feed.post',
          rkey,
        }),
      },
    );

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to delete Bluesky post: ${errorData}`);
      throw new BadRequestException('Failed to delete post from Bluesky');
    }
  }

  /**
   * Get user's recent posts
   */
  async getAuthorFeed(
    accessJwt: string,
    actor: string,
    limit: number = 25,
    cursor?: string,
  ): Promise<{
    posts: Array<{
      uri: string;
      cid: string;
      text: string;
      createdAt: string;
      likeCount: number;
      repostCount: number;
      replyCount: number;
    }>;
    cursor?: string;
  }> {
    const url = new URL(`${this.apiBaseUrl}/app.bsky.feed.getAuthorFeed`);
    url.searchParams.set('actor', actor);
    url.searchParams.set('limit', Math.min(limit, 100).toString());
    if (cursor) {
      url.searchParams.set('cursor', cursor);
    }

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessJwt}`,
      },
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to get Bluesky feed: ${errorData}`);
      throw new BadRequestException('Failed to fetch Bluesky feed');
    }

    const data = await response.json();

    return {
      posts: (data.feed || []).map((item: any) => ({
        uri: item.post.uri,
        cid: item.post.cid,
        text: item.post.record?.text || '',
        createdAt: item.post.record?.createdAt || item.post.indexedAt,
        likeCount: item.post.likeCount || 0,
        repostCount: item.post.repostCount || 0,
        replyCount: item.post.replyCount || 0,
      })),
      cursor: data.cursor,
    };
  }

  /**
   * Parse facets (mentions, links, hashtags) from text
   * Bluesky requires explicit byte positions for rich text features
   */
  private async parseFacets(text: string): Promise<any[]> {
    const facets: any[] = [];
    const encoder = new TextEncoder();
    const textBytes = encoder.encode(text);

    // Parse URLs
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    let match;
    while ((match = urlRegex.exec(text)) !== null) {
      const url = match[1];
      const start = encoder.encode(text.slice(0, match.index)).length;
      const end = start + encoder.encode(url).length;

      facets.push({
        index: { byteStart: start, byteEnd: end },
        features: [
          {
            $type: 'app.bsky.richtext.facet#link',
            uri: url,
          },
        ],
      });
    }

    // Parse mentions (@handle or @handle.bsky.social)
    const mentionRegex = /@([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?/g;
    while ((match = mentionRegex.exec(text)) !== null) {
      const mention = match[0];
      const handle = mention.slice(1); // Remove @
      const start = encoder.encode(text.slice(0, match.index)).length;
      const end = start + encoder.encode(mention).length;

      try {
        // Resolve handle to DID
        const did = await this.resolveHandle(handle);
        if (did) {
          facets.push({
            index: { byteStart: start, byteEnd: end },
            features: [
              {
                $type: 'app.bsky.richtext.facet#mention',
                did,
              },
            ],
          });
        }
      } catch {
        // Skip invalid mentions
      }
    }

    // Parse hashtags
    const hashtagRegex = /#([a-zA-Z0-9_]+)/g;
    while ((match = hashtagRegex.exec(text)) !== null) {
      const hashtag = match[0];
      const tag = match[1];
      const start = encoder.encode(text.slice(0, match.index)).length;
      const end = start + encoder.encode(hashtag).length;

      facets.push({
        index: { byteStart: start, byteEnd: end },
        features: [
          {
            $type: 'app.bsky.richtext.facet#tag',
            tag,
          },
        ],
      });
    }

    return facets;
  }

  /**
   * Resolve a handle to a DID
   */
  async resolveHandle(handle: string): Promise<string | null> {
    try {
      const response = await fetch(
        `${this.apiBaseUrl}/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
      );

      if (!response.ok) {
        return null;
      }

      const data = await response.json();
      return data.did || null;
    } catch {
      return null;
    }
  }

  /**
   * Verify that credentials are valid
   */
  async verifyCredentials(accessJwt: string, did: string): Promise<boolean> {
    try {
      await this.getProfile(accessJwt, did);
      return true;
    } catch {
      return false;
    }
  }

  // ==========================================================================
  // Inbox — read thread / fetch single post (for CID lookup before replying)
  // ==========================================================================

  /**
   * Fetch the full thread under a Bluesky post (including nested replies).
   * Public XRPC endpoint, no auth required — but we still pass the JWT in case
   * the user has restricted who can see their replies (Bluesky doesn't do that
   * yet but the field is allowed).
   *
   * `depth` is how many levels of nested replies to include (max 6 — server cap).
   */
  async getPostThread(
    accessJwt: string,
    postUri: string,
    depth: number = 6,
  ): Promise<BlueskyThreadNode> {
    const url =
      `${this.apiBaseUrl}/app.bsky.feed.getPostThread` +
      `?uri=${encodeURIComponent(postUri)}&depth=${depth}`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessJwt}` },
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to fetch Bluesky thread: ${errorData}`);
      throw new BadRequestException('Failed to fetch Bluesky thread');
    }

    const data = await response.json();
    // Response shape: { thread: { $type: 'app.bsky.feed.defs#threadViewPost', post, replies } }
    return data.thread;
  }

  /**
   * Fetch one or more posts by URI. Used to look up a post's CID before posting
   * a reply (the reply API needs both uri + cid of root/parent).
   */
  async getPosts(
    accessJwt: string,
    uris: string[],
  ): Promise<Array<{ uri: string; cid: string; record: Record<string, any>; author: BlueskyAuthor }>> {
    if (uris.length === 0) return [];
    const qs = uris.map((u) => `uris=${encodeURIComponent(u)}`).join('&');
    const response = await fetch(`${this.apiBaseUrl}/app.bsky.feed.getPosts?${qs}`, {
      headers: { Authorization: `Bearer ${accessJwt}` },
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to fetch Bluesky posts: ${errorData}`);
      throw new BadRequestException('Failed to fetch Bluesky posts');
    }

    const data = await response.json();
    return data.posts ?? [];
  }
}

// ---------------------------------------------------------------------------
// Bluesky thread shapes — only what we need from app.bsky.feed.getPostThread.
// The full lexicon has more fields but these are stable.
// ---------------------------------------------------------------------------

export interface BlueskyAuthor {
  did: string;
  handle: string;
  displayName?: string;
  avatar?: string;
}

export interface BlueskyThreadPost {
  uri: string;
  cid: string;
  author: BlueskyAuthor;
  record: {
    $type: string;
    text?: string;
    createdAt: string;
    reply?: {
      root: { uri: string; cid: string };
      parent: { uri: string; cid: string };
    };
  };
  indexedAt: string;
  /** AT Protocol AppView surfaces aggregate counts on the post view. */
  likeCount?: number;
  replyCount?: number;
  repostCount?: number;
}

export interface BlueskyThreadNode {
  $type: string;
  post: BlueskyThreadPost;
  parent?: BlueskyThreadNode;
  replies?: BlueskyThreadNode[];
}
