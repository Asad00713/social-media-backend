import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import {
  ElevenLabsSttService,
  toTranscribedWords,
} from './elevenlabs-stt.service';

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

  describe('the words it hands back', () => {
    it('returns each spoken word with its start and end, as text', async () => {
      fetchMock.mockResolvedValue(
        ok({
          text: 'pour it',
          language_code: 'eng',
          duration: 2,
          words: [
            { text: 'pour', type: 'word', start: 0.1, end: 0.5, logprob: -0.1 },
            { text: ' ', type: 'spacing', start: 0.5, end: 0.6, logprob: 0 },
            { text: 'it', type: 'word', start: 0.6, end: 0.9, logprob: -0.1 },
          ],
        }),
      );
      const result = await transcribe();
      expect(result.words).toEqual([
        { text: 'pour', start: 0.1, end: 0.5 },
        { text: 'it', start: 0.6, end: 0.9 },
      ]);
      expect(result.text).toBe('pour it');
      expect(result.language).toBe('eng');
      expect(result.durationSeconds).toBe(2);
    });

    it('returns an empty list when the response carries no words', async () => {
      // Always an array, so a caller never has to tell "absent" from "none".
      fetchMock.mockResolvedValue(ok({ text: '' }));
      const result = await transcribe();
      expect(result.words).toEqual([]);
    });
  });

  describe('toTranscribedWords', () => {
    const word = (over: Record<string, unknown> = {}) => ({
      text: 'hello',
      type: 'word',
      start: 1,
      end: 2,
      logprob: -0.1,
      ...over,
    });

    it('keeps only text, start and end', () => {
      const [first] = toTranscribedWords([
        word({ speaker_id: 'speaker_0', characters: [] }),
      ]);
      expect(Object.keys(first).sort()).toEqual(['end', 'start', 'text']);
    });

    it('drops the gaps between words', () => {
      expect(
        toTranscribedWords([word({ type: 'spacing', text: ' ' })]),
      ).toEqual([]);
    });

    it('drops non-speech tags such as laughter', () => {
      // "(laughter)" would otherwise be cut into a caption line of its own.
      expect(
        toTranscribedWords([word({ type: 'audio_event', text: '(laughter)' })]),
      ).toEqual([]);
    });

    it('keeps a word whose type is not stated', () => {
      expect(toTranscribedWords([word({ type: undefined })])).toHaveLength(1);
    });

    it('drops a word with no usable timing rather than inventing one', () => {
      // start and end are optional and nullable in the API's own schema.
      expect(toTranscribedWords([word({ start: null })])).toEqual([]);
      expect(toTranscribedWords([word({ end: undefined })])).toEqual([]);
      expect(toTranscribedWords([word({ start: Number.NaN })])).toEqual([]);
      expect(toTranscribedWords([word({ end: 'soon' })])).toEqual([]);
    });

    it('drops a word that ends before it starts or starts below zero', () => {
      expect(toTranscribedWords([word({ start: 3, end: 2 })])).toEqual([]);
      expect(toTranscribedWords([word({ start: -1, end: 1 })])).toEqual([]);
    });

    it('keeps an instantaneous word, whose start equals its end', () => {
      expect(toTranscribedWords([word({ start: 2, end: 2 })])).toHaveLength(1);
    });

    it('drops an empty or blank word and trims the rest', () => {
      expect(
        toTranscribedWords([word({ text: '' }), word({ text: '   ' })]),
      ).toEqual([]);
      expect(toTranscribedWords([word({ text: ' hi ' })])[0].text).toBe('hi');
    });

    it('keeps the order it was given', () => {
      const out = toTranscribedWords([
        word({ text: 'a', start: 0, end: 1 }),
        word({ text: 'b', start: 1, end: 2 }),
        word({ text: 'c', start: 2, end: 3 }),
      ]);
      expect(out.map((w) => w.text)).toEqual(['a', 'b', 'c']);
    });

    it('survives anything that is not an array of objects', () => {
      expect(toTranscribedWords(undefined)).toEqual([]);
      expect(toTranscribedWords(null)).toEqual([]);
      expect(toTranscribedWords('words')).toEqual([]);
      expect(toTranscribedWords({ words: [] })).toEqual([]);
      expect(toTranscribedWords([null, 7, 'x', undefined])).toEqual([]);
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
