import { ComposerValidatorService } from './composer-validator.service';
import { MediaValidatorService } from './media-validator.service';
import type { PublicationPayload } from '../types/publication-payload.types';
import type { ComposerCapabilities } from '../types/composer-capabilities.types';

describe('ComposerValidatorService', () => {
  let service: ComposerValidatorService;

  const twitterCaps: ComposerCapabilities = {
    supportsTitle: false,
    supportsBody: true,
    supportsDescription: false,
    supportsHashtags: true,
    supportsFirstComment: false,
    supportsThread: true,
    supportsPoll: true,
    supportsLocation: false,
    supportsMentions: true,
    supportsLinkPreview: true,
    postTypes: ['post'],
    visibilityOptions: [],
    replyControlOptions: [],
    maxCharsBody: 280,
    mediaConstraints: {
      imageMaxCount: 4, imageMaxSizeMB: 5, imageAllowedTypes: [], imageAspectRatios: [],
      videoMaxCount: 1, videoMaxSizeMB: 512, videoMaxDurationSec: 140,
      videoAllowedTypes: [], videoAspectRatios: [],
    },
    requiredFields: ['body'],
  };

  const ytCaps: ComposerCapabilities = {
    ...twitterCaps,
    supportsTitle: true,
    supportsBody: false,
    supportsDescription: true,
    maxCharsTitle: 100,
    maxCharsBody: 0,
    maxCharsDescription: 5000,
    requiredFields: ['title', 'description'],
  };

  function payload(text: string): PublicationPayload {
    return {
      channelId: '1',
      platform: 'twitter',
      text,
      mediaItems: [],
      hashtags: [],
      mentions: [],
      platformSpecific: {},
    };
  }

  beforeEach(() => {
    service = new ComposerValidatorService(new MediaValidatorService());
  });

  it('passes valid Twitter body', () => {
    const r = service.validate(payload('Hello world'), twitterCaps);
    expect(r.ok).toBe(true);
  });

  it('rejects body over char limit', () => {
    const r = service.validate(payload('x'.repeat(281)), twitterCaps);
    expect(r.ok).toBe(false);
    expect(r.errors).toContainEqual(expect.objectContaining({ kind: 'body_too_long' }));
  });

  it('warns near char limit (>=90%)', () => {
    const r = service.validate(payload('x'.repeat(260)), twitterCaps);
    expect(r.ok).toBe(true);
    expect(r.warnings).toContainEqual(expect.objectContaining({ kind: 'body_near_limit' }));
  });

  it('rejects empty body when required', () => {
    const r = service.validate(payload(''), twitterCaps);
    expect(r.ok).toBe(false);
    expect(r.errors).toContainEqual(expect.objectContaining({ kind: 'required_field_missing', field: 'body' }));
  });

  it('rejects YT payload missing title', () => {
    const r = service.validate(
      { ...payload(''), platformSpecific: { description: 'desc' } },
      ytCaps,
    );
    expect(r.ok).toBe(false);
    expect(r.errors).toContainEqual(
      expect.objectContaining({ kind: 'required_field_missing', field: 'title' }),
    );
  });

  it('rejects YT title over 100 chars', () => {
    const r = service.validate(
      { ...payload(''), platformSpecific: { title: 'x'.repeat(101), description: 'd' } },
      ytCaps,
    );
    expect(r.errors).toContainEqual(expect.objectContaining({ kind: 'title_too_long' }));
  });
});
