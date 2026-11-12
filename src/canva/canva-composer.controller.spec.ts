import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { CanvaComposerController } from './canva-composer.controller';

function makeController(overrides?: {
  getByWorkspace?: jest.Mock;
  getValidAccessToken?: jest.Mock;
  listDesigns?: jest.Mock;
  exportDesign?: jest.Mock;
  waitForExport?: jest.Mock;
  ingestBuffer?: jest.Mock;
  assertCanStore?: jest.Mock;
}) {
  const connectionService = {
    getByWorkspace: overrides?.getByWorkspace ?? jest.fn(),
    getValidAccessToken:
      overrides?.getValidAccessToken ??
      jest.fn().mockResolvedValue('access-token'),
  } as any;

  const canvaService = {
    listDesigns: overrides?.listDesigns ?? jest.fn(),
    exportDesign:
      overrides?.exportDesign ??
      jest.fn().mockResolvedValue({ id: 'job-1', status: 'in_progress' }),
    waitForExport:
      overrides?.waitForExport ??
      jest.fn().mockResolvedValue(['https://export.canva.com/file.png']),
  } as any;

  const quota = {
    assertCanStore:
      overrides?.assertCanStore ?? jest.fn().mockResolvedValue({}),
  } as any;

  const ingest = {
    ingestBuffer:
      overrides?.ingestBuffer ??
      jest.fn().mockResolvedValue({
        upload: {
          secureUrl: 'https://res.cloudinary.com/img.png',
          width: 800,
          height: 600,
          bytes: 12345,
          resourceType: 'image',
        },
        libraryItem: { id: 'item-1' },
      }),
  } as any;

  const controller = new CanvaComposerController(
    connectionService,
    canvaService,
    quota,
    ingest,
  );

  return { controller, connectionService, canvaService, quota, ingest };
}

describe('CanvaComposerController.status', () => {
  it('reports connected: false when no connection exists', async () => {
    const { controller } = makeController({
      getByWorkspace: jest.fn().mockResolvedValue(null),
    });
    await expect(controller.status('ws-1')).resolves.toEqual({
      connected: false,
    });
  });

  it('reports connected: true with the stored display name', async () => {
    const { controller } = makeController({
      getByWorkspace: jest.fn().mockResolvedValue({ displayName: 'Jane Doe' }),
    });
    await expect(controller.status('ws-1')).resolves.toEqual({
      connected: true,
      displayName: 'Jane Doe',
    });
  });
});

describe('CanvaComposerController.designs', () => {
  it('maps CanvaDesign items to the composer envelope and skips designs without a thumbnail', async () => {
    const listDesigns = jest.fn().mockResolvedValue({
      designs: [
        {
          id: 'd1',
          title: 'Design One',
          url: 'https://canva.com/d1',
          thumbnail: { url: 'https://thumb/d1.png', width: 100, height: 200 },
          createdAt: '2026-01-01',
          updatedAt: '2026-01-02',
        },
        {
          id: 'd2',
          title: 'No Thumbnail Design',
          url: 'https://canva.com/d2',
          createdAt: '2026-01-01',
          updatedAt: '2026-01-02',
        },
      ],
      continuation: 'cont-token',
    });
    const { controller, connectionService, canvaService } = makeController({
      listDesigns,
    });

    const result = await controller.designs('ws-1', {
      limit: 10,
      continuation: 'prev',
      query: 'logo',
    });

    expect(connectionService.getValidAccessToken).toHaveBeenCalledWith('ws-1');
    // The search term is forwarded to the Canva client as the 4th argument.
    expect(canvaService.listDesigns).toHaveBeenCalledWith(
      'access-token',
      10,
      'prev',
      'logo',
    );
    expect(result).toEqual({
      items: [
        {
          id: 'd1',
          title: 'Design One',
          thumbnailUrl: 'https://thumb/d1.png',
          width: 100,
          height: 200,
          updatedAt: '2026-01-02',
        },
      ],
      continuation: 'cont-token',
    });
  });

  it('defaults the limit when none is provided', async () => {
    const listDesigns = jest
      .fn()
      .mockResolvedValue({ designs: [], continuation: undefined });
    const { controller, canvaService } = makeController({ listDesigns });

    await controller.designs('ws-1', {});

    expect(canvaService.listDesigns).toHaveBeenCalledWith(
      'access-token',
      30,
      undefined,
      undefined,
    );
  });
});

const USER = { userId: 'user-1' };

describe('CanvaComposerController.import', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('exports, downloads, and re-uploads the design, returning a permanent-URL shape', async () => {
    const arrayBuffer = new TextEncoder().encode('fake-png-bytes').buffer;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(arrayBuffer),
    }) as any;

    const { controller, connectionService, canvaService, quota, ingest } =
      makeController();

    const result = await controller.import('ws-1', { designId: 'd1' }, USER);

    expect(connectionService.getValidAccessToken).toHaveBeenCalledWith('ws-1');
    expect(canvaService.exportDesign).toHaveBeenCalledWith(
      'access-token',
      'd1',
      { format: 'png', quality: 'high' },
    );
    expect(canvaService.waitForExport).toHaveBeenCalledWith(
      'access-token',
      'd1',
      'job-1',
    );
    expect(global.fetch).toHaveBeenCalledWith(
      'https://export.canva.com/file.png',
    );
    expect(quota.assertCanStore).toHaveBeenCalledWith('ws-1', 1);
    expect(ingest.ingestBuffer).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      userId: 'user-1',
      buffer: expect.any(Buffer),
      mimeType: 'image/png',
      originalName: 'canva-d1.png',
      resourceType: 'image',
    });
    expect(result).toEqual({
      libraryItem: { id: 'item-1' },
      url: 'https://res.cloudinary.com/img.png',
      type: 'image',
      width: 800,
      height: 600,
      sizeBytes: 12345,
    });
  });

  // Instagram Post/Story and TikTok Photo publish JPEG only: the composer
  // asks for a JPG, which Canva exports with a numeric quality.
  it('exports and stores a JPG when asked for one', async () => {
    const arrayBuffer = new TextEncoder().encode('fake-jpg-bytes').buffer;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(arrayBuffer),
    }) as any;
    const { controller, canvaService, ingest } = makeController();

    await controller.import('ws-1', { designId: 'd1', format: 'jpg' }, USER);

    expect(canvaService.exportDesign).toHaveBeenCalledWith(
      'access-token',
      'd1',
      { format: 'jpg', quality: 90 },
    );
    expect(ingest.ingestBuffer).toHaveBeenCalledWith(
      expect.objectContaining({
        mimeType: 'image/jpeg',
        originalName: 'canva-d1.jpg',
      }),
    );
  });

  it('throws BadRequestException when the export has no download URLs', async () => {
    const { controller } = makeController({
      waitForExport: jest.fn().mockResolvedValue([]),
    });

    await expect(
      controller.import('ws-1', { designId: 'd1' }, USER),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws BadRequestException when the export download fetch fails', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false }) as any;
    const { controller } = makeController();

    await expect(
      controller.import('ws-1', { designId: 'd1' }, USER),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('CanvaComposerController.import on a full workspace', () => {
  it('refuses with 413 before exporting anything', async () => {
    const { controller, canvaService, ingest } = makeController({
      assertCanStore: jest
        .fn()
        .mockRejectedValue(new PayloadTooLargeException('full')),
    });

    await expect(
      controller.import('ws-1', { designId: 'd1' }, USER),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(canvaService.exportDesign).not.toHaveBeenCalled();
    expect(ingest.ingestBuffer).not.toHaveBeenCalled();
  });
});
