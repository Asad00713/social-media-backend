/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- test doubles are loosely typed */
import { BadRequestException } from '@nestjs/common';

jest.mock('../../drizzle/db', () => {
  const mkChain = (rows: unknown[]): any =>
    new Proxy(function () {}, {
      get: (_t, prop) =>
        prop === 'then'
          ? (resolve: (v: unknown) => void) => resolve(rows)
          : () => mkChain(rows),
    });
  return {
    db: {
      insert: () => mkChain([{ id: 'p-new', status: 'draft' }]),
      select: () => mkChain([{ id: 'p1', status: 'draft' }]),
      update: () => mkChain([{ id: 'p1', status: 'draft' }]),
      delete: () => mkChain([]),
      execute: () => mkChain([]),
    },
  };
});

import { db } from '../../drizzle/db';
import { PostService } from './post.service';

const WS = 'ws1';

function makeService(existing: Record<string, unknown>) {
  const noop = async () => undefined;
  const svc = new PostService(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { emit: jest.fn() } as any,
    { syncPost: noop, loadPostLinks: async () => [] } as any,
    {} as any,
    { enforceQueueLimit: noop } as any,
  );
  jest.spyOn(svc, 'getPost').mockResolvedValue(existing as any);
  jest.spyOn(svc as any, 'validateChannels').mockResolvedValue([]);
  jest.spyOn(svc as any, 'recordHistory').mockResolvedValue(undefined);
  jest.spyOn(svc as any, 'cancelPublishJobs').mockResolvedValue(undefined);
  jest.spyOn(svc as any, 'syncCalendarForPost').mockReturnValue(undefined);
  return svc;
}

async function bodyOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return (e as BadRequestException).getResponse() as Record<string, unknown>;
  }
  throw new Error('expected a refusal');
}

const post = (status: string, targets: unknown[] = []) => ({
  id: 'p1',
  status,
  createdById: 'u1',
  jobId: null,
  targets,
});

describe('PostService refusal codes', () => {
  it('update of a published post carries POST_ALREADY_PUBLISHED', async () => {
    const svc = makeService(post('published'));
    const body = await bodyOf(
      svc.updatePost('p1', WS, 'u1', { content: 'y' } as any, 'MEMBER'),
    );
    expect(body).toMatchObject({
      statusCode: 400,
      message: 'Cannot update a published post',
      code: 'POST_ALREADY_PUBLISHED',
    });
  });

  it('delete of a published post carries POST_ALREADY_PUBLISHED', async () => {
    const svc = makeService(
      post('published', [{ channelId: '1', status: 'published' }]),
    );
    const body = await bodyOf(svc.deletePost('p1', WS, 'u1', 'MEMBER'));
    expect(body).toMatchObject({
      message:
        'Cannot delete a published post. It must be deleted from each platform individually.',
      code: 'POST_ALREADY_PUBLISHED',
    });
  });

  it('a schedule time one minute ago carries SCHEDULE_IN_PAST', async () => {
    const svc = makeService(post('draft'));
    const body = await bodyOf(
      svc.updatePost(
        'p1',
        WS,
        'u1',
        { scheduledAt: new Date(Date.now() - 60_000) } as any,
        'MEMBER',
      ),
    );
    expect(body).toMatchObject({
      message: 'Cannot schedule a post in the past',
      code: 'SCHEDULE_IN_PAST',
    });
  });

  describe('deletePost on partly published posts', () => {
    const PARTLY =
      'Some channels already published this post. Delete it from each platform instead.';

    it('refuses status partially_published', async () => {
      const svc = makeService(
        post('partially_published', [
          { channelId: '1', status: 'published' },
          { channelId: '2', status: 'failed' },
        ]),
      );
      const body = await bodyOf(svc.deletePost('p1', WS, 'u1', 'MEMBER'));
      expect(body).toMatchObject({
        message: PARTLY,
        code: 'POST_PARTLY_PUBLISHED',
      });
    });

    it('refuses a failed-status row whose targets mix published and failed (publishStatus)', async () => {
      const svc = makeService(
        post('failed', [
          { channelId: '1', status: 'draft', publishStatus: 'published' },
          { channelId: '2', status: 'failed' },
        ]),
      );
      const body = await bodyOf(svc.deletePost('p1', WS, 'u1', 'MEMBER'));
      expect(body.code).toBe('POST_PARTLY_PUBLISHED');
    });

    it('refuses a published-status row whose targets mix published and failed', async () => {
      const svc = makeService(
        post('published', [
          { channelId: '1', status: 'published' },
          { channelId: '2', status: 'failed' },
        ]),
      );
      const body = await bodyOf(svc.deletePost('p1', WS, 'u1', 'MEMBER'));
      expect(body.code).toBe('POST_PARTLY_PUBLISHED');
    });

    it.each([
      [
        'failed',
        [
          { channelId: '1', status: 'failed' },
          { channelId: '2', publishStatus: 'failed' },
        ],
      ],
      ['scheduled', [{ channelId: '1', status: 'scheduled' }]],
    ])('still deletes a %s post', async (status, targets) => {
      const svc = makeService(post(status, targets));
      await expect(
        svc.deletePost('p1', WS, 'u1', 'MEMBER'),
      ).resolves.toBeUndefined();
    });
  });

  describe('a refused past schedule changes nothing', () => {
    const PAST = () => new Date(Date.now() - 60_000);

    function spies(svc: PostService) {
      return {
        update: jest.spyOn(db as any, 'update'),
        insert: jest.spyOn(db as any, 'insert'),
        execute: jest.spyOn(db as any, 'execute'),
        cancel: (svc as any).cancelPublishJobs as jest.Mock,
        history: (svc as any).recordHistory as jest.Mock,
      };
    }

    afterEach(() => jest.restoreAllMocks());

    it('updatePost: 400 SCHEDULE_IN_PAST, no cancel, write or history', async () => {
      const svc = makeService(post('scheduled'));
      const s = spies(svc);
      const body = await bodyOf(
        svc.updatePost(
          'p1',
          WS,
          'u1',
          { scheduledAt: PAST() } as any,
          'MEMBER',
        ),
      );
      expect(body).toMatchObject({
        statusCode: 400,
        message: 'Cannot schedule a post in the past',
        error: 'Bad Request',
        code: 'SCHEDULE_IN_PAST',
      });
      expect(s.cancel).not.toHaveBeenCalled();
      expect(s.update).not.toHaveBeenCalled();
      expect(s.execute).not.toHaveBeenCalled();
      expect(s.history).not.toHaveBeenCalled();
    });

    it('createPost: 400 SCHEDULE_IN_PAST, no insert or history', async () => {
      const svc = makeService(post('draft'));
      const s = spies(svc);
      const body = await bodyOf(
        svc.createPost(
          WS,
          'u1',
          { content: 'x', targetChannelIds: [], scheduledAt: PAST() } as any,
          'MEMBER',
        ),
      );
      expect(body).toMatchObject({
        statusCode: 400,
        code: 'SCHEDULE_IN_PAST',
      });
      expect(s.insert).not.toHaveBeenCalled();
      expect(s.history).not.toHaveBeenCalled();
    });
  });
});
