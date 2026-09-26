import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import { ElevenLabsSttService } from './elevenlabs-stt.service';

/**
 * These tests exist because transcription was broken from the day it was
 * written: the request left out `model_id`, which ElevenLabs requires, so
 * every call came back 422 and every caller saw "Transcription failed:
 * unknown". Nothing checked what we actually put on the wire.
 */
describe('ElevenLabsSttService', () => {
  let service: ElevenLabsSttService;
  let fetchMock: jest.SpyInstance;

  // `key: null` means "not configured". A default parameter cannot express
  // that — passing `undefined` re-triggers the default, which is what made an
  // earlier version of this test see a configured service and a real call.
  const build = async ({ key }: { key: string | null } = { key: 'test-key' }) => {
    const apiKey = key ?? undefined;
    const mod = await Test.createTestingModule({
      providers: [
        ElevenLabsSttService,
        { provide: ConfigService, useValue: { get: () => apiKey } },
      ],
    }).compile();
    return mod.get(ElevenLabsSttService);
  };

  const ok = (body: unknown) =>
    ({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    }) as unknown as Response;

  const fail = (status: number, body: string) =>
    ({
      ok: false,
      status,
      // Empty over HTTP/2 — the reason failures used to read as "unknown".
      statusText: '',
      text: () => Promise.resolve(body),
    }) as unknown as Response;

  beforeEach(async () => {
    service = await build();
    // Given an implementation up front: a bare spyOn calls THROUGH to the real
    // fetch, so a test that forgets to stub would quietly hit ElevenLabs and
    // leave a late-settling call in the record for the next test to trip over.
    fetchMock = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('unstubbed fetch'));
  });

  afterEach(() => jest.restoreAllMocks());

  const transcribe = () =>
    service.transcribe(Buffer.from('audio'), 'note.webm', 'audio/webm');

  const sentForm = (): FormData =>
    fetchMock.mock.calls[0][1].body as FormData;

  describe('the request it sends', () => {
    it('includes model_id, which the API requires', async () => {
      // Without this the API answers 422 {"loc":["body","model_id"]} and
      // transcription fails for every caller, every time.
      fetchMock.mockResolvedValue(ok({ text: 'hello' }));
      await transcribe();
      expect(sentForm().get('model_id')).toBe('scribe_v1');
    });

    it('sends the audio under the field name the API reads', async () => {
      fetchMock.mockResolvedValue(ok({ text: 'hello' }));
      await transcribe();
      expect(sentForm().get('file')).toBeInstanceOf(Blob);
    });

    it('passes a language hint only when given one', async () => {
      fetchMock.mockResolvedValue(ok({ text: 'hola' }));
      await service.transcribe(Buffer.from('a'), 'n.webm', 'audio/webm', {
        languageCode: 'es',
      });
      expect(sentForm().get('language_code')).toBe('es');

      fetchMock.mockClear();
      fetchMock.mockResolvedValue(ok({ text: 'hello' }));
      await transcribe();
      // Omitted rather than sent empty, so the model detects the language.
      expect(sentForm().get('language_code')).toBeNull();
    });
  });

  describe('what it tells the caller when it fails', () => {
    it('surfaces the reason rather than "unknown"', async () => {
      fetchMock.mockResolvedValue(
        fail(400, '{"detail":{"message":"File is corrupted."}}'),
      );
      await expect(transcribe()).rejects.toThrow(/File is corrupted/);
    });

    it('surfaces a schema complaint, which arrives as a list', async () => {
      fetchMock.mockResolvedValue(
        fail(422, '{"detail":[{"loc":["body","model_id"],"msg":"Field required"}]}'),
      );
      await expect(transcribe()).rejects.toThrow(/Field required/);
    });

    it('falls back to the status code when the body is not JSON', async () => {
      fetchMock.mockResolvedValue(fail(502, '<html>bad gateway</html>'));
      await expect(transcribe()).rejects.toThrow(/HTTP 502/);
    });

    it('refuses before calling out when no key is configured', async () => {
      const unconfigured = await build({ key: null });
      expect(unconfigured.isReady()).toBe(false);
      fetchMock.mockClear();
      await expect(
        unconfigured.transcribe(Buffer.from('a'), 'n.webm', 'audio/webm'),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Never reaches the network: an unconfigured key is our problem to
      // report, not a request worth making.
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('what it refuses to upload', () => {
    const file = (over: Partial<Express.Multer.File> = {}) =>
      ({
        mimetype: 'audio/webm',
        size: 1024,
        originalname: 'note.webm',
        buffer: Buffer.from('a'),
        ...over,
      }) as Express.Multer.File;

    it('rejects a format the API cannot read', () => {
      expect(service.validateAudioFile(file({ mimetype: 'video/mp4' })).valid)
        .toBe(false);
    });

    it('rejects audio longer than the API accepts', () => {
      // The cap is the API's 3 minutes; sending more wastes the upload.
      expect(service.validateAudioFile(file(), 181).valid).toBe(false);
      expect(service.validateAudioFile(file(), 179).valid).toBe(true);
    });

    it('rejects a file too large to upload', () => {
      expect(service.validateAudioFile(file({ size: 26 * 1024 * 1024 })).valid)
        .toBe(false);
    });
  });
});
