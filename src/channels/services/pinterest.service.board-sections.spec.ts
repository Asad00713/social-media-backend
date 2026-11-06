import { BadRequestException } from '@nestjs/common';
import { PinterestService } from './pinterest.service';

/**
 * A board's sections: the list the composer's picker reads, and the create
 * behind its "create one" row.
 *
 * `board_section_id` was already forwarded on the pin, but nothing could
 * LIST a board's sections, so nothing could choose one. These pin the
 * request itself — URL, query and body — because a wrong path or an
 * un-followed bookmark fails quietly (an empty or truncated picker).
 */
describe('PinterestService — board sections', () => {
  let service: PinterestService;
  let fetchMock: jest.Mock;
  const originalSandbox = process.env.PINTEREST_USE_SANDBOX;

  const page = (items: Array<{ id: string; name: string }>, bookmark?: string) => ({
    ok: true,
    json: async () => ({ items, bookmark: bookmark ?? null }),
  });

  beforeEach(() => {
    delete process.env.PINTEREST_USE_SANDBOX;
    service = new PinterestService();
    fetchMock = jest.fn().mockResolvedValue(page([]));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    if (originalSandbox === undefined) delete process.env.PINTEREST_USE_SANDBOX;
    else process.env.PINTEREST_USE_SANDBOX = originalSandbox;
  });

  describe('listBoardSections', () => {
    it('asks the board-sections endpoint for the largest page', async () => {
      await service.listBoardSections('tok', 'board-1');

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(
        'https://api.pinterest.com/v5/boards/board-1/sections?page_size=250',
      );
      expect(init.headers.Authorization).toBe('Bearer tok');
      // A read: no method override, no body.
      expect(init.method).toBeUndefined();
      expect(init.body).toBeUndefined();
    });

    it('keeps the sandbox base URL when the service is in sandbox mode', async () => {
      process.env.PINTEREST_USE_SANDBOX = 'true';
      service = new PinterestService();

      await service.listBoardSections('tok', 'board-1');

      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://api-sandbox.pinterest.com/v5/boards/board-1/sections?page_size=250',
      );
    });

    it('returns each section as { id, name }', async () => {
      fetchMock.mockResolvedValueOnce(
        page([
          { id: '1', name: 'Iced drinks' },
          { id: '2', name: 'Hot drinks' },
        ]),
      );

      await expect(service.listBoardSections('tok', 'b')).resolves.toEqual([
        { id: '1', name: 'Iced drinks' },
        { id: '2', name: 'Hot drinks' },
      ]);
    });

    it('follows the bookmark until Pinterest stops returning one', async () => {
      fetchMock
        .mockResolvedValueOnce(page([{ id: '1', name: 'A' }], 'cursor-2'))
        .mockResolvedValueOnce(page([{ id: '2', name: 'B' }]));

      const sections = await service.listBoardSections('tok', 'b');

      expect(sections.map((s) => s.id)).toEqual(['1', '2']);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0]).toBe(
        'https://api.pinterest.com/v5/boards/b/sections?page_size=250&bookmark=cursor-2',
      );
    });

    it('stops at the page bound rather than looping on a bookmark that never ends', async () => {
      fetchMock.mockResolvedValue(page([{ id: 'x', name: 'X' }], 'again'));

      await service.listBoardSections('tok', 'b');

      expect(fetchMock).toHaveBeenCalledTimes(10);
    });

    it('encodes the board id so it cannot address another endpoint', async () => {
      await service.listBoardSections('tok', '../../user_account');

      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://api.pinterest.com/v5/boards/..%2F..%2Fuser_account/sections?page_size=250',
      );
    });

    it('drops an entry that has no id or name rather than offering a blank row', async () => {
      fetchMock.mockResolvedValueOnce(
        page([
          { id: '1', name: 'Kept' },
          { id: '2' } as unknown as { id: string; name: string },
          { name: 'No id' } as unknown as { id: string; name: string },
        ]),
      );

      await expect(service.listBoardSections('tok', 'b')).resolves.toEqual([
        { id: '1', name: 'Kept' },
      ]);
    });

    it("surfaces Pinterest's message when the list is refused", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ message: 'Board not found' }),
      });

      await expect(service.listBoardSections('tok', 'b')).rejects.toThrow(
        new BadRequestException('Board not found'),
      );
    });

    it('still reports a refusal whose body is not JSON', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        json: async () => {
          throw new Error('not json');
        },
      });

      await expect(service.listBoardSections('tok', 'b')).rejects.toThrow(
        'Failed to list board sections',
      );
    });
  });

  describe('createBoardSection', () => {
    beforeEach(() => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ id: '77', name: 'Iced drinks' }),
      });
    });

    it('POSTs the name to the board-sections endpoint', async () => {
      await service.createBoardSection('tok', 'board-1', 'Iced drinks');

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.pinterest.com/v5/boards/board-1/sections');
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe('Bearer tok');
      expect(JSON.parse(init.body)).toEqual({ name: 'Iced drinks' });
    });

    it('keeps the sandbox base URL when the service is in sandbox mode', async () => {
      process.env.PINTEREST_USE_SANDBOX = 'true';
      service = new PinterestService();

      await service.createBoardSection('tok', 'board-1', 'Iced drinks');

      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://api-sandbox.pinterest.com/v5/boards/board-1/sections',
      );
    });

    it('caps the name at the 180 characters the API allows', async () => {
      await service.createBoardSection('tok', 'b', 'x'.repeat(400));

      expect(JSON.parse(fetchMock.mock.calls[0][1].body).name).toHaveLength(180);
    });

    it('returns the section Pinterest created', async () => {
      await expect(
        service.createBoardSection('tok', 'b', 'Iced drinks'),
      ).resolves.toEqual({ id: '77', name: 'Iced drinks' });
    });

    it('encodes the board id here too', async () => {
      await service.createBoardSection('tok', 'a/b', 'N');

      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://api.pinterest.com/v5/boards/a%2Fb/sections',
      );
    });

    it("surfaces Pinterest's message when the create is refused", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ message: 'Section name already exists' }),
      });

      await expect(
        service.createBoardSection('tok', 'b', 'Dup'),
      ).rejects.toThrow('Section name already exists');
    });
  });
});
