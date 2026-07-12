import { Test } from '@nestjs/testing';
import { MediaSourcesController } from './media-sources.controller';
import { MediaSourcesService } from './media-sources.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

describe('MediaSourcesController', () => {
  it('browse route delegates to service with parsed channelId', async () => {
    const service = {
      browse: jest.fn().mockResolvedValue({ items: [], folders: [] }),
      import: jest.fn(),
    };
    const mod = await Test.createTestingModule({
      controllers: [MediaSourcesController],
      providers: [{ provide: MediaSourcesService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    const ctrl = mod.get(MediaSourcesController);
    await ctrl.browse('ws', '7', { kind: 'media' } as any);
    expect(service.browse).toHaveBeenCalledWith('ws', 7, { kind: 'media' });
  });

  it('import route delegates to service with parsed channelId', async () => {
    const service = {
      browse: jest.fn(),
      import: jest.fn().mockResolvedValue({
        url: 'https://example.com/a.jpg',
        type: 'image',
        sizeBytes: 123,
      }),
    };
    const mod = await Test.createTestingModule({
      controllers: [MediaSourcesController],
      providers: [{ provide: MediaSourcesService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    const ctrl = mod.get(MediaSourcesController);
    await ctrl.import('ws', '9', { fileId: 'abc', kind: 'image' } as any);
    expect(service.import).toHaveBeenCalledWith('ws', 9, {
      fileId: 'abc',
      kind: 'image',
    });
  });
});
