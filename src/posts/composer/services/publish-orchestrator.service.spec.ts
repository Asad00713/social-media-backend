import { Test } from '@nestjs/testing';
import { PublishOrchestratorService, CHANNEL_CREDENTIALS_LOOKUP } from './publish-orchestrator.service';
import { ComposerService } from './composer.service';
import { PayloadResolverService } from './payload-resolver.service';
import { ComposerErrorMapperService } from './composer-error-mapper.service';
import { PublisherFactory } from '../../publishers/publisher.factory';
import { AnalyticsEventEmitter } from '../../../realtime/analytics-event-emitter.service';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import type { Draft } from '../types/draft.types';

const baseDraft = (): Draft => ({
  id: 'd1',
  workspaceId: 'w1',
  createdById: 'u1',
  status: 'draft',
  base: { text: 'hello world', mediaItems: [], hashtags: [], mentions: [] },
  perPlatform: {},
  channels: [
    { channelId: 'c1', platform: 'twitter', publishStatus: 'queued', retryCount: 0 },
  ],
  schedule: { mode: 'now' },
  createdAt: '2026-05-17T00:00:00Z',
  updatedAt: '2026-05-17T00:00:00Z',
});

describe('PublishOrchestratorService', () => {
  let svc: PublishOrchestratorService;
  let composer: { findById: jest.Mock };
  let publisher: { publish: jest.Mock };
  let factory: { getPublisher: jest.Mock };
  let emitter: { emit: jest.Mock };
  let credentials: { getCredentials: jest.Mock };
  let dbUpdate: jest.Mock;

  const makeDb = () => {
    dbUpdate = jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(undefined),
      }),
    });
    return { update: dbUpdate };
  };

  beforeEach(async () => {
    composer = { findById: jest.fn().mockResolvedValue(baseDraft()) };
    publisher = { publish: jest.fn() };
    factory = { getPublisher: jest.fn().mockReturnValue(publisher) };
    emitter = { emit: jest.fn() };
    credentials = {
      getCredentials: jest.fn().mockResolvedValue({
        accessToken: 'tok',
        platformAccountId: 'tw-1',
        channelMetadata: {},
      }),
    };

    const mod = await Test.createTestingModule({
      providers: [
        PublishOrchestratorService,
        { provide: ComposerService, useValue: composer },
        {
          provide: PayloadResolverService,
          useValue: {
            resolve: (d: Draft, c: any) => ({
              channelId: c.channelId, platform: c.platform,
              text: d.base.text, mediaItems: [], hashtags: [], mentions: [], platformSpecific: {},
            }),
          },
        },
        { provide: ComposerErrorMapperService, useValue: new ComposerErrorMapperService() },
        { provide: PublisherFactory, useValue: factory },
        { provide: AnalyticsEventEmitter, useValue: emitter },
        { provide: CHANNEL_CREDENTIALS_LOOKUP, useValue: credentials },
        { provide: DRIZZLE, useValue: makeDb() },
      ],
    }).compile();

    svc = mod.get(PublishOrchestratorService);
  });

  it('publishes a single Twitter channel successfully and emits state events', async () => {
    publisher.publish.mockResolvedValue({ platformPostId: 'tid_1', platformPostUrl: 'https://x.com/i/web/status/tid_1' });

    const result = await svc.publishDraft('w1', 'd1');

    expect(result.draftStatus).toBe('published');
    expect(result.channels[0]).toMatchObject({
      channelId: 'c1',
      publishStatus: 'published',
      platformPostId: 'tid_1',
    });
    const stateEvents = emitter.emit.mock.calls.filter((c) => c[1] === 'composer.publish.state.changed');
    expect(stateEvents.length).toBe(2);
    expect(stateEvents[0][2].status).toBe('publishing');
    expect(stateEvents[1][2].status).toBe('published');
  });

  it('marks channel failed with classified error and overall failed', async () => {
    publisher.publish.mockRejectedValue(new Error('Request failed with status 401: invalid_token'));

    const result = await svc.publishDraft('w1', 'd1');

    expect(result.draftStatus).toBe('failed');
    expect(result.channels[0]).toMatchObject({
      publishStatus: 'failed',
      errorCode: 'auth_failed',
    });
  });

  it('mixed success/failure -> partial_success', async () => {
    composer.findById.mockResolvedValue({
      ...baseDraft(),
      channels: [
        { channelId: 'c1', platform: 'twitter', publishStatus: 'queued', retryCount: 0 },
        { channelId: 'c2', platform: 'twitter', publishStatus: 'queued', retryCount: 0 },
      ],
    });
    publisher.publish
      .mockResolvedValueOnce({ platformPostId: 'tid_1', platformPostUrl: 'u1' })
      .mockRejectedValueOnce(new Error('429 rate limit'));

    const result = await svc.publishDraft('w1', 'd1');

    expect(result.draftStatus).toBe('partial_success');
    expect(result.channels[0].publishStatus).toBe('published');
    expect(result.channels[1].publishStatus).toBe('failed');
    expect(result.channels[1].errorCode).toBe('rate_limited');
  });

  it('retry filters to specified channelIds and increments retryCount', async () => {
    composer.findById.mockResolvedValue({
      ...baseDraft(),
      channels: [
        { channelId: 'c1', platform: 'twitter', publishStatus: 'published', retryCount: 0, platformPostId: 'tid_1' },
        { channelId: 'c2', platform: 'twitter', publishStatus: 'failed', retryCount: 1, errorCode: 'rate_limited' },
      ],
    });
    publisher.publish.mockResolvedValue({ platformPostId: 'tid_2', platformPostUrl: 'u2' });

    const result = await svc.publishDraft('w1', 'd1', { channelIds: ['c2'] });

    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(result.channels.find((c) => c.channelId === 'c2')?.retryCount).toBe(2);
    expect(result.channels.find((c) => c.channelId === 'c2')?.publishStatus).toBe('published');
    expect(result.channels.find((c) => c.channelId === 'c1')?.publishStatus).toBe('published');
  });

  it('throws if draft has no channels', async () => {
    composer.findById.mockResolvedValue({ ...baseDraft(), channels: [] });
    await expect(svc.publishDraft('w1', 'd1')).rejects.toThrow(/no channels/i);
  });
});
