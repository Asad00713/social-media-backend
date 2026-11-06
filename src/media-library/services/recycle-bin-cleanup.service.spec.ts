import { Logger } from '@nestjs/common';
import { RecycleBinCleanupService } from './recycle-bin-cleanup.service';
import type { MediaItemService } from './media-item.service';
import type { TemplateService } from './template.service';
import type { TextSnippetService } from './text-snippet.service';
import type { SavedLinkService } from './saved-link.service';

function make() {
  const kinds = {
    media: {
      cleanupRecycleBin: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    },
    template: {
      cleanupRecycleBin: jest.fn().mockResolvedValue({ deletedCount: 2 }),
    },
    snippet: {
      cleanupRecycleBin: jest.fn().mockResolvedValue({ deletedCount: 3 }),
    },
    link: {
      cleanupRecycleBin: jest.fn().mockResolvedValue({ deletedCount: 4 }),
    },
  };
  const service = new RecycleBinCleanupService(
    kinds.media as unknown as MediaItemService,
    kinds.template as unknown as TemplateService,
    kinds.snippet as unknown as TextSnippetService,
    kinds.link as unknown as SavedLinkService,
  );
  return { service, kinds };
}

describe('RecycleBinCleanupService', () => {
  let errorSpy: jest.SpyInstance;
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('runs every kind and totals what they deleted', async () => {
    const { service, kinds } = make();

    const r = await service.handleRecycleBinCleanup();

    for (const k of Object.values(kinds)) {
      expect(k.cleanupRecycleBin).toHaveBeenCalledTimes(1);
    }
    expect(r).toEqual({ deleted: 10, failedKinds: [] });
  });

  it('a media purge that throws does not stop templates, snippets or links', async () => {
    const { service, kinds } = make();
    kinds.media.cleanupRecycleBin.mockRejectedValue(new Error('storage down'));

    const r = await service.handleRecycleBinCleanup();

    expect(kinds.template.cleanupRecycleBin).toHaveBeenCalledTimes(1);
    expect(kinds.snippet.cleanupRecycleBin).toHaveBeenCalledTimes(1);
    expect(kinds.link.cleanupRecycleBin).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ deleted: 9, failedKinds: ['media'] });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('media'),
      expect.any(Error),
    );
  });

  it('each kind is isolated: a failing snippet purge still runs links', async () => {
    const { service, kinds } = make();
    kinds.template.cleanupRecycleBin.mockRejectedValue(new Error('t'));
    kinds.snippet.cleanupRecycleBin.mockRejectedValue(new Error('s'));

    const r = await service.handleRecycleBinCleanup();

    expect(kinds.link.cleanupRecycleBin).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ deleted: 5, failedKinds: ['template', 'snippet'] });
  });
});
