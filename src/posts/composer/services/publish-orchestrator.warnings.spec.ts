/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await -- test doubles are loosely typed */

import { Test } from '@nestjs/testing';
import {
  PublishOrchestratorService,
  CHANNEL_CREDENTIALS_LOOKUP,
  type InlinePublishInput,
} from './publish-orchestrator.service';
import { PayloadResolverService } from './payload-resolver.service';
import { ComposerErrorMapperService } from './composer-error-mapper.service';
import { PublisherFactory } from '../../publishers/publisher.factory';
import { AnalyticsEventEmitter } from '../../../realtime/analytics-event-emitter.service';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import { PostReminderService } from '../../services/post-reminder.service';
import type { Draft } from '../types/draft.types';

/**
 * D4: a soft step that failed after the post went live (first comment,
 * cover, alt text...) comes back as `result.metadata.*Warning`. "Publish
 * now" used to drop it, so the post read "Published" with the setting
 * silently missing. It is now stored on the channel target as `warnings`.
 */
describe('PublishOrchestratorService - publish warnings', () => {
  let svc: PublishOrchestratorService;
  let publisher: { publish: jest.Mock };
  let storedTargets: unknown;
  let persisted: any[];

  const input = (
    over: Partial<InlinePublishInput> = {},
  ): InlinePublishInput => ({
    draftId: 'd1',
    base: { text: 'hi', mediaItems: [], hashtags: [], mentions: [] },
    perPlatform: {},
    channels: [
      {
        channelId: 'c1',
        platform: 'facebook',
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
        { provide: PostReminderService, useValue: { send: jest.fn() } },
      ],
    }).compile();
    svc = mod.get(PublishOrchestratorService);
  });

  /** The target the LAST persist wrote for a channel. */
  const lastStored = (channelId = 'c1') =>
    persisted
      .filter((p) => Array.isArray(p.targets))
      .at(-1)
      .targets.find((t: any) => t.channelId === channelId);

  const twoChannels = () => [
    {
      channelId: 'c1',
      platform: 'facebook' as const,
      publishStatus: 'failed' as const,
      retryCount: 0,
    },
    {
      channelId: 'c2',
      platform: 'facebook' as const,
      publishStatus: 'published' as const,
      retryCount: 0,
    },
  ];

  it('stores a soft-step failure on the published target and returns it', async () => {
    publisher.publish.mockResolvedValue({
      platformPostId: 'p1',
      metadata: { firstCommentWarning: '(#100) Comments are off' },
    });

    const result = await svc.publishInline('w1', 'u1', input());

    expect(result.draftStatus).toBe('published');
    expect(result.channels[0]).toMatchObject({
      publishStatus: 'published',
      warnings: ['First comment was not posted: (#100) Comments are off'],
    });
    expect(lastStored().warnings).toEqual([
      'First comment was not posted: (#100) Comments are off',
    ]);
  });

  it("keeps LinkedIn's mediaWarning (PR #208) too", async () => {
    publisher.publish.mockResolvedValue({
      platformPostId: 'p1',
      metadata: {
        mediaWarning: 'published 20 images, left out 2 other items',
      },
    });
    await svc.publishInline('w1', 'u1', input());
    expect(lastStored().warnings).toEqual([
      'Some media was left out: published 20 images, left out 2 other items',
    ]);
  });

  it('stores no warnings key for a clean publish', async () => {
    publisher.publish.mockResolvedValue({
      platformPostId: 'p1',
      metadata: { firstCommentId: 'c9' },
    });
    await svc.publishInline('w1', 'u1', input());
    // Undefined is dropped when the targets are written as jsonb.
    expect(lastStored().warnings).toBeUndefined();
    expect(JSON.parse(JSON.stringify(lastStored()))).not.toHaveProperty(
      'warnings',
    );
  });

  it("a re-publish reports its own warnings, never the last attempt's", async () => {
    storedTargets = [{ channelId: 'c1', warnings: ['Cover was not set: old'] }];
    publisher.publish.mockResolvedValue({ platformPostId: 'p1' });
    const result = await svc.publishInline(
      'w1',
      'u1',
      input({ retryChannelIds: ['c1'] }),
    );
    expect(result.channels[0].warnings).toBeUndefined();
    expect(lastStored().warnings).toBeUndefined();
  });

  it('keeps the warnings of a channel this retry does not touch', async () => {
    storedTargets = [
      { channelId: 'c2', warnings: ['Cover was not set: too big'] },
    ];
    publisher.publish.mockResolvedValue({ platformPostId: 'p1' });
    await svc.publishInline(
      'w1',
      'u1',
      input({ channels: twoChannels(), retryChannelIds: ['c1'] }),
    );
    expect(lastStored('c2').warnings).toEqual(['Cover was not set: too big']);
  });

  it('emits the warnings on the publish state event', async () => {
    publisher.publish.mockResolvedValue({
      platformPostId: 'p1',
      metadata: { altTextWarning: 'X refused the alt text (HTTP 403)' },
    });
    const emitter = (svc as any).emitter as { emit: jest.Mock };
    await svc.publishInline('w1', 'u1', input());
    const published = emitter.emit.mock.calls
      .filter(([, name]) => name === 'composer.publish.state.changed')
      .map(([, , payload]) => payload)
      .find((p) => p.status === 'published');
    expect(published.warnings).toEqual([
      'Alt text was not added: X refused the alt text (HTTP 403)',
    ]);
  });
});
