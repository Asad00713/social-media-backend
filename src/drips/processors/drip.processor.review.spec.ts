/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment -- db double */
import type { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { dripCampaigns, dripPosts } from '../../drizzle/schema/drips.schema';
import { users } from '../../drizzle/schema/users.schema';
import { workspace } from '../../drizzle/schema/workspace.schema';

let historyRows: Record<string, unknown>[];
let dripStatus: string;

const rowsFor = (table: unknown): unknown[] => {
  if (table === dripPosts) {
    return [
      {
        id: 'dp1',
        status: dripStatus,
        scheduledAt: new Date('2026-11-20T04:00:00Z'),
        generatedContent: 'Cold brew is just patience in a jar.',
        platformContent: {
          instagram: { text: 'Cold brew', hashtags: ['#coffee'] },
          twitter: { text: 'Cold brew' },
        },
      },
    ];
  }
  if (table === dripCampaigns) {
    return [
      {
        id: 'c1',
        name: 'Weekly "coffee" tips',
        workspaceId: 'ws-1',
        createdById: 'u1',
      },
    ];
  }
  if (table === users) {
    return [{ id: 'u1', email: 'creator@x.test', name: 'Creator' }];
  }
  if (table === workspace) return [{ timezone: 'Asia/Karachi' }];
  return [];
};

const mockDb = {
  select: jest.fn(() => ({
    from: (table: unknown) => ({
      where: async () => rowsFor(table),
    }),
  })),
  insert: jest.fn(() => ({
    values: async (v: Record<string, unknown>) => {
      historyRows.push(v);
    },
  })),
};

jest.mock('../../drizzle/db', () => ({ db: mockDb }));
jest.mock('../../drizzle/db-utils', () => ({
  withRetry: (fn: () => unknown) => fn(),
}));

import { AppLinks } from '../../email/links/app-links';
import { renderEmail } from '../../email/render/render-email';
import { dripReview } from '../../email/templates/publishing/drip-review';
import type { DripReviewProps } from '../../email/templates/publishing/drip-review';
import type { NotifyInput } from '../../notifications/notify.service';
import { DripProcessor } from './drip.processor';

function make(frontendUrl?: string) {
  const notify = {
    notify: jest.fn<Promise<void>, [NotifyInput<DripReviewProps>]>(() =>
      Promise.resolve(),
    ),
  };
  const config = {
    get: (key: string) => (key === 'FRONTEND_URL' ? frontendUrl : undefined),
  } as unknown as ConfigService;
  const links = new AppLinks(config);
  const processor = new DripProcessor(
    {} as never,
    {} as never,
    notify as never,
    links,
  );
  return { processor, notify, links };
}

const job = {
  name: 'drip-send-notification',
  data: { dripPostId: 'dp1', campaignId: 'c1' },
} as never;

beforeEach(() => {
  historyRows = [];
  dripStatus = 'pending_review';
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

function queued(notify: ReturnType<typeof make>['notify']) {
  const [input] = notify.notify.mock.calls[0];
  const email = input.email as NonNullable<
    NotifyInput<DripReviewProps>['email']
  >;
  return { input, email };
}

describe('DripProcessor review email', () => {
  it('links the review to the frontend planner, never to the backend', async () => {
    const { processor, notify, links } = make();
    await processor.process(job);

    const { email } = queued(notify);
    expect(email.props.reviewUrl).toBe('http://localhost:3001/w/ws-1/planner');
    expect(email.props.reviewUrl).not.toContain('/drips/posts/');
    expect(email.props.reviewUrl).not.toContain('localhost:3000');

    const rendered = await renderEmail(dripReview, email.props, {
      assetBaseUrl: links.assetBase(),
      footer: { reason: 'why', links: [] },
    });
    expect(rendered.html).toContain(
      'href="http://localhost:3001/w/ws-1/planner"',
    );
    expect(rendered.html).not.toContain('/drips/posts/');
    expect(rendered.text).not.toContain('/drips/posts/');
  });

  it('follows FRONTEND_URL when it is set', async () => {
    const { processor, notify } = make('https://app.schedura.ai/');
    await processor.process(job);
    expect(queued(notify).email.props.reviewUrl).toBe(
      'https://app.schedura.ai/w/ws-1/planner',
    );
  });

  it('queues drip_review to the campaign creator, keyed by the drip post', async () => {
    const { processor, notify } = make();
    await processor.process(job);

    const { input, email } = queued(notify);
    expect(notify.notify).toHaveBeenCalledTimes(1);
    expect(input).toMatchObject({
      userId: 'u1',
      workspaceId: 'ws-1',
      event: 'drip_review',
    });
    expect(input.bell).toBeUndefined();
    expect(email.template).toBe(dripReview);
    expect(email.to).toBe('creator@x.test');
    expect(email.idempotencyKey).toBe('drip-review.dp1');
    expect(email.idempotencyKey).toMatch(/^[A-Za-z0-9._-]{1,200}$/);
  });

  it('shows the post, its networks and the publish time in the workspace zone', async () => {
    const { processor, notify } = make();
    await processor.process(job);
    expect(queued(notify).email.props).toMatchObject({
      campaignName: 'Weekly "coffee" tips',
      when: 'Nov 20, 2026 at 9:00 AM GMT+5',
      caption: 'Cold brew is just patience in a jar.',
      platforms: ['Instagram', 'X'],
    });
  });

  it('has the new subject, without [Action Required]', async () => {
    const { processor, notify, links } = make();
    await processor.process(job);
    const { email } = queued(notify);
    const rendered = await renderEmail(dripReview, email.props, {
      assetBaseUrl: links.assetBase(),
      footer: { reason: 'why', links: [] },
    });
    expect(rendered.subject).toBe(
      'Review your post for "Weekly "coffee" tips"',
    );
    expect(rendered.subject).not.toContain('[Action Required]');
  });

  it('records the notification in the campaign history, without a result', async () => {
    const { processor } = make();
    const result = await processor.process(job);
    expect(result).toEqual({ success: true, notificationQueued: true });
    expect(historyRows).toHaveLength(1);
    expect(historyRows[0]).toMatchObject({
      action: 'notification_sent',
      details: { notificationType: 'email', emailQueued: true },
    });
  });

  it('sends nothing for a post that is no longer pending review', async () => {
    dripStatus = 'approved';
    const { processor, notify } = make();
    await expect(processor.process(job)).resolves.toEqual({
      skipped: true,
      reason: 'Status is approved',
    });
    expect(notify.notify).not.toHaveBeenCalled();
  });
});
