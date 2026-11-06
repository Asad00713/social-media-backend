import { Test } from '@nestjs/testing';
import {
  PublishOrchestratorService,
  CHANNEL_CREDENTIALS_LOOKUP,
  type InlinePublishInput,
} from './publish-orchestrator.service';
import { PayloadResolverService } from './payload-resolver.service';
import { ComposerErrorMapperService } from './composer-error-mapper.service';
import { PublisherFactory } from '../../publishers/publisher.factory';
import { PartialPublishError } from '../../publishers/base.publisher';
import { AnalyticsEventEmitter } from '../../../realtime/analytics-event-emitter.service';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import type { Draft } from '../types/draft.types';

/**
 * A post sent as several platform posts (one Pin per image) keeps its
 * per-item results on the channel target. The client's copy of the channels
 * does not carry them and the upsert overwrites the stored targets with that
 * copy, so the orchestrator must read them from the row FIRST and hand them
 * to the publisher - or a retry posts the same Pins twice.
 */
describe('PublishOrchestratorService - per-item results', () => {
  let svc: PublishOrchestratorService;
  let publisher: { publish: jest.Mock };
  let storedTargets: unknown;
  let persisted: any[];

  const A = { mediaUrl: 'https://cdn.test/a.jpg', platformPostId: 'pin-a' };
  const B = { mediaUrl: 'https://cdn.test/b.jpg', platformPostId: 'pin-b' };

  const input = (
    over: Partial<InlinePublishInput> = {},
  ): InlinePublishInput => ({
    draftId: 'd1',
    base: { text: 'hi', mediaItems: [], hashtags: [], mentions: [] },
    perPlatform: {},
    channels: [
      {
        channelId: 'c1',
        platform: 'pinterest',
        publishStatus: 'failed',
        retryCount: 0,
      },
    ],
    schedule: { mode: 'now' },
    ...over,
  });

  beforeEach(async () => {
    publisher = { publish: jest.fn() };
    persisted = [];
    storedTargets = [];
    const db = {
      select: jest.fn(() => ({
        from: () => ({
          where: () => ({ limit: async () => [{ targets: storedTargets }] }),
        }),
      })),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
        }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn((v: any) => {
          persisted.push(v);
          return { where: jest.fn().mockResolvedValue(undefined) };
        }),
      }),
    };

    const mod = await Test.createTestingModule({
      providers: [
        PublishOrchestratorService,
        {
          provide: PayloadResolverService,
          useValue: {
            resolve: (d: Draft, c: any) => ({
              channelId: c.channelId,
              platform: c.platform,
              text: d.base.text,
              mediaItems: [],
              hashtags: [],
              mentions: [],
              platformSpecific: {},
            }),
          },
        },
        {
          provide: ComposerErrorMapperService,
          useValue: new ComposerErrorMapperService(),
        },
        {
          provide: PublisherFactory,
          useValue: { getPublisher: () => publisher },
        },
        { provide: AnalyticsEventEmitter, useValue: { emit: jest.fn() } },
        {
          provide: CHANNEL_CREDENTIALS_LOOKUP,
          useValue: {
            getCredentials: jest.fn().mockResolvedValue({
              accessToken: 'tok',
              platformAccountId: 'acct',
              channelMetadata: {},
            }),
          },
        },
        { provide: DRIZZLE, useValue: db },
      ],
    }).compile();
    svc = mod.get(PublishOrchestratorService);
  });

  /** The targets the LAST persist wrote for channel c1. */
  const lastStored = () =>
    persisted
      .filter((p) => Array.isArray(p.targets))
      .at(-1)
      .targets.find((t: any) => t.channelId === 'c1');

  it('hands the publisher what the stored row says already went out', async () => {
    storedTargets = [{ channelId: 'c1', itemResults: [A] }];
    publisher.publish.mockResolvedValue({
      platformPostId: 'pin-a',
      itemResults: [A, B],
    });

    await svc.publishInline('w1', 'u1', input({ retryChannelIds: ['c1'] }));

    expect(publisher.publish.mock.calls[0][0].previousItemResults).toEqual([A]);
  });

  it('reads them on a plain second Publish too, not only on Retry', async () => {
    storedTargets = [{ channelId: 'c1', itemResults: [A] }];
    publisher.publish.mockResolvedValue({ platformPostId: 'pin-a' });

    await svc.publishInline('w1', 'u1', input());

    expect(publisher.publish.mock.calls[0][0].previousItemResults).toEqual([A]);
  });

  it('sends no previous results for a fresh draft', async () => {
    publisher.publish.mockResolvedValue({ platformPostId: 'p' });
    await svc.publishInline('w1', 'u1', input());
    expect('previousItemResults' in publisher.publish.mock.calls[0][0]).toBe(
      false,
    );
  });

  it('stores every item on a published target, with the first as its post id', async () => {
    publisher.publish.mockResolvedValue({
      platformPostId: 'pin-a',
      itemResults: [A, B],
    });
    const result = await svc.publishInline('w1', 'u1', input());
    expect(result.channels[0]).toMatchObject({
      publishStatus: 'published',
      platformPostId: 'pin-a',
      itemResults: [A, B],
    });
    expect(lastStored().itemResults).toEqual([A, B]);
  });

  it('stores the items that went out on a target that failed part-way', async () => {
    publisher.publish.mockRejectedValue(
      new PartialPublishError('Rate limited', [A]),
    );
    const result = await svc.publishInline('w1', 'u1', input());
    expect(result.channels[0]).toMatchObject({
      publishStatus: 'failed',
      errorMessage: 'Rate limited',
      itemResults: [A],
    });
    expect(lastStored().itemResults).toEqual([A]);
  });

  it('keeps stored items on a channel this retry does not touch', async () => {
    storedTargets = [{ channelId: 'c2', itemResults: [B] }];
    publisher.publish.mockResolvedValue({ platformPostId: 'p' });
    await svc.publishInline(
      'w1',
      'u1',
      input({
        channels: [
          {
            channelId: 'c1',
            platform: 'pinterest',
            publishStatus: 'failed',
            retryCount: 0,
          },
          {
            channelId: 'c2',
            platform: 'pinterest',
            publishStatus: 'failed',
            retryCount: 0,
          },
        ],
        retryChannelIds: ['c1'],
      }),
    );
    const c2 = persisted
      .filter((p) => Array.isArray(p.targets))
      .at(-1)
      .targets.find((t: any) => t.channelId === 'c2');
    expect(c2.itemResults).toEqual([B]);
  });

  it('still publishes when the stored row cannot be read', async () => {
    const mod = (svc as any).db;
    mod.select.mockImplementationOnce(() => {
      throw new Error('db down');
    });
    publisher.publish.mockResolvedValue({ platformPostId: 'p' });
    const result = await svc.publishInline('w1', 'u1', input());
    expect(result.draftStatus).toBe('published');
  });
});
