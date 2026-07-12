import { BadRequestException } from '@nestjs/common';
import { CanvaComposerController } from './canva-composer.controller';

function makeController(overrides?: {
  getByWorkspace?: jest.Mock;
  getValidAccessToken?: jest.Mock;
  listDesigns?: jest.Mock;
  exportDesign?: jest.Mock;
  waitForExport?: jest.Mock;
  uploadFromBuffer?: jest.Mock;
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

  const cloudinary = {
    uploadFromBuffer:
      overrides?.uploadFromBuffer ??
      jest.fn().mockResolvedValue({
        secureUrl: 'https://res.cloudinary.com/img.png',
        width: 800,
        height: 600,
        bytes: 12345,
        resourceType: 'image',
      }),
  } as any;

  const controller = new CanvaComposerController(
    connectionService,
    canvaService,
    cloudinary,
  );

  return { controller, connectionService, canvaService, cloudinary };
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
      getByWorkspace: jest
        .fn()
        .mockResolvedValue({ displayName: 'Jane Doe' }),
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

    const { controller, connectionService, canvaService, cloudinary } =
      makeController();

    const result = await controller.import('ws-1', { designId: 'd1' });

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
    expect(cloudinary.uploadFromBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      { folder: 'composer/canva', resourceType: 'image' },
    );
    expect(result).toEqual({
      url: 'https://res.cloudinary.com/img.png',
      type: 'image',
      width: 800,
      height: 600,
      sizeBytes: 12345,
    });
  });

  it('throws BadRequestException when the export has no download URLs', async () => {
    const { controller } = makeController({
      waitForExport: jest.fn().mockResolvedValue([]),
    });

    await expect(
      controller.import('ws-1', { designId: 'd1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws BadRequestException when the export download fetch fails', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false }) as any;
    const { controller } = makeController();

    await expect(
      controller.import('ws-1', { designId: 'd1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
