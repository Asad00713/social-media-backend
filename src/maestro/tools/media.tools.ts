import { z } from 'zod';
import type {
  PexelsService,
  PexelsPhoto,
  PexelsVideo,
} from '../../pexels/pexels.service';
import type {
  UnsplashService,
  UnsplashPhoto,
} from '../../channels/services/unsplash.service';
import type { AgentToolDefinition } from '../maestro.types';

/** Unified media item the chat UI renders (images + videos, any source). */
export interface MaestroMediaItem {
  id: string;
  type: 'image' | 'video';
  source: 'pexels' | 'unsplash';
  thumbnailUrl: string;
  fullUrl: string;
  width: number;
  height: number;
  alt: string;
  photographer: string;
  photographerUrl?: string;
  sourceUrl?: string;
  duration?: number;
  /** Unsplash-only: ping on use (TOS download tracking). */
  downloadLocation?: string;
}

function mapUnsplash(p: UnsplashPhoto): MaestroMediaItem {
  return {
    id: `unsplash-img-${p.id}`,
    type: 'image',
    source: 'unsplash',
    thumbnailUrl: p.urls.small,
    fullUrl: p.urls.regular,
    width: p.width,
    height: p.height,
    alt: p.altDescription || p.description || '',
    photographer: p.user.name,
    photographerUrl: p.user.profileUrl,
    sourceUrl: p.links.html,
    downloadLocation: p.links.downloadLocation,
  };
}

function mapPexelsPhoto(p: PexelsPhoto): MaestroMediaItem {
  return {
    id: `pexels-img-${p.id}`,
    type: 'image',
    source: 'pexels',
    thumbnailUrl: p.src.medium || p.src.small,
    fullUrl: p.src.large || p.src.original,
    width: p.width,
    height: p.height,
    alt: p.alt,
    photographer: p.photographer,
    photographerUrl: p.photographerUrl,
    sourceUrl: p.url,
  };
}

function mapPexelsVideo(v: PexelsVideo): MaestroMediaItem {
  const file =
    v.videoFiles.find((f) => f.quality === 'hd') || v.videoFiles[0];
  return {
    id: `pexels-vid-${v.id}`,
    type: 'video',
    source: 'pexels',
    thumbnailUrl: v.image,
    fullUrl: file?.link || '',
    width: v.width,
    height: v.height,
    alt: '',
    photographer: v.user.name,
    sourceUrl: v.url,
    duration: v.duration,
  };
}

/** Round-robin the sources so the grid mixes Unsplash + Pexels. */
function interleaveBySource(items: MaestroMediaItem[]): MaestroMediaItem[] {
  const unsplash = items.filter((i) => i.source === 'unsplash');
  const pexels = items.filter((i) => i.source === 'pexels');
  const out: MaestroMediaItem[] = [];
  for (let i = 0; i < Math.max(unsplash.length, pexels.length); i++) {
    if (unsplash[i]) out.push(unsplash[i]);
    if (pexels[i]) out.push(pexels[i]);
  }
  return out;
}

export function createMediaTools(
  unsplash: UnsplashService,
  pexels: PexelsService,
): AgentToolDefinition[] {
  return [
    {
      name: 'search_media',
      description:
        'Search stock photos and videos for the user. If the user names a source ("from Unsplash"), use only that; otherwise mix Unsplash + Pexels. The UI renders the results as a grid — do NOT paste URLs in your reply, just briefly describe what you found. Set `selectable` true when the user is picking image(s) for a post.',
      inputSchema: {
        query: z
          .string()
          .describe('What to search for, e.g. "sunset over the ocean".'),
        type: z
          .enum(['image', 'video', 'any'])
          .optional()
          .describe('What to fetch. Default "image". Videos come from Pexels.'),
        source: z
          .enum(['pexels', 'unsplash'])
          .optional()
          .describe('Restrict to one source. Omit to mix both.'),
        count: z
          .number()
          .optional()
          .describe('How many results (1-12). Default 6.'),
        orientation: z
          .enum(['landscape', 'portrait', 'square'])
          .optional()
          .describe('Optional aspect filter for the target platform.'),
        selectable: z
          .boolean()
          .optional()
          .describe(
            'True when the user must choose image(s) for a post — renders a selectable grid with a confirm button.',
          ),
        maxSelect: z
          .number()
          .optional()
          .describe('Max images selectable (when selectable). Omit = no limit.'),
      },
      handler: async (args) => {
        const query = String(args.query || '').trim();
        const type = (['image', 'video', 'any'] as const).includes(
          args.type as 'image' | 'video' | 'any',
        )
          ? (args.type as 'image' | 'video' | 'any')
          : 'image';
        const source = (['pexels', 'unsplash'] as const).includes(
          args.source as 'pexels' | 'unsplash',
        )
          ? (args.source as 'pexels' | 'unsplash')
          : undefined;
        const count = Math.min(Math.max(Number(args.count) || 6, 1), 12);
        const orientation = (
          ['landscape', 'portrait', 'square'] as const
        ).includes(args.orientation as 'landscape' | 'portrait' | 'square')
          ? (args.orientation as 'landscape' | 'portrait' | 'square')
          : undefined;
        const selectable = Boolean(args.selectable);
        const maxSelect = args.maxSelect ? Number(args.maxSelect) : null;

        const wantImages = type === 'image' || type === 'any';
        const wantVideos = type === 'video' || type === 'any';
        const items: MaestroMediaItem[] = [];
        const failed: string[] = [];

        // Videos — Pexels only (Unsplash has no video).
        if (wantVideos && source !== 'unsplash') {
          try {
            const r = await pexels.searchVideos({
              query,
              orientation,
              perPage: type === 'video' ? count : Math.ceil(count / 2),
              page: 1,
            });
            items.push(...r.items.map(mapPexelsVideo));
          } catch {
            failed.push('Pexels videos');
          }
        }

        // Images — Unsplash and/or Pexels.
        if (wantImages) {
          const perSource = source ? count : Math.ceil(count / 2);
          if (source !== 'pexels') {
            try {
              const uOrientation =
                orientation === 'square' ? 'squarish' : orientation;
              const r = await unsplash.searchPhotos(
                query,
                1,
                perSource,
                uOrientation,
              );
              items.push(...r.results.map(mapUnsplash));
            } catch {
              failed.push('Unsplash');
            }
          }
          if (source !== 'unsplash') {
            try {
              const r = await pexels.searchPhotos({
                query,
                orientation,
                perPage: perSource,
                page: 1,
              });
              items.push(...r.items.map(mapPexelsPhoto));
            } catch {
              failed.push('Pexels');
            }
          }
        }

        const cap = type === 'any' ? count + 2 : count;
        const mixed = interleaveBySource(items)
          .filter((i) => i.fullUrl && i.thumbnailUrl)
          .slice(0, cap);

        return {
          kind: 'media' as const,
          items: mixed,
          selectable,
          maxSelect,
          query,
          ...(mixed.length === 0
            ? {
                note: failed.length
                  ? `No media found (sources unavailable: ${failed.join(', ')}).`
                  : 'No results for that query.',
              }
            : {}),
        };
      },
    },
  ];
}
