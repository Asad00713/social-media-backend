import { CanvaService } from './canva.service';

// The body `POST /exports` gets for each format. Canva's JPG format object
// REQUIRES `quality`, an integer 1-100; PNG's takes none (an unknown field
// is rejected by the strict endpoint).
describe('CanvaService.exportDesign request body', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  async function bodyFor(options: Parameters<CanvaService['exportDesign']>[2]) {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ job: { id: 'j1' } })),
    });
    global.fetch = fetchMock as any;
    await new CanvaService().exportDesign('token', 'd1', options);
    const init = fetchMock.mock.calls[0][1] as { body: string };
    return JSON.parse(init.body) as { format: Record<string, unknown> };
  }

  it('sends a JPG with an integer quality', async () => {
    expect((await bodyFor({ format: 'jpg', quality: 90 })).format).toEqual({
      type: 'jpg',
      quality: 90,
    });
  });

  it('turns a named quality into an integer for a JPG', async () => {
    expect((await bodyFor({ format: 'jpg', quality: 'high' })).format).toEqual({
      type: 'jpg',
      quality: 90,
    });
  });

  it('sends a PNG with no quality', async () => {
    expect((await bodyFor({ format: 'png', quality: 'high' })).format).toEqual({
      type: 'png',
    });
  });
});
