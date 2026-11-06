import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { WorkspaceRoleService } from '../workspace-members/workspace-role.service';
import { AiController, type TranscribeResponse } from './ai.controller';
import { GroqService } from './groq.service';
import { AiTokenService } from './services/ai-token.service';
import { ElevenLabsSttService } from './services/elevenlabs-stt.service';
import { ComposerAiService } from './composer-ai.service';
import { InboxAiService } from './inbox-ai.service';

const WS = '11111111-1111-4111-8111-111111111111';
const URL = `/ai/workspaces/${WS}/transcribe`;

/**
 * `POST /ai/workspaces/:id/transcribe` over real HTTP, with the REAL speech
 * service behind it and only ElevenLabs' network call faked.
 *
 * The route used to drop `words` between the service and the reply, so the
 * captions panel received a paragraph with no timings. Nothing checked what
 * the route put on the wire; this does, from the speech API's own response
 * shape through to the JSON the browser reads.
 */
describe('AiController transcribe over HTTP', () => {
  let app: INestApplication<App>;
  let fetchMock: jest.SpyInstance;

  const roles = { getRole: jest.fn(), isPlatformSuperAdmin: jest.fn() };
  // Runs the operation the way the real metering wrapper does, so the reply
  // is built from the real speech service's result.
  const executeWithTokens = jest.fn();
  const usage = { tokensUsed: 5, remaining: 95 };

  // ElevenLabs' documented response: a `type` on every entry, `spacing`
  // entries between words, an `audio_event` for non-speech, and per-entry
  // bookkeeping (`logprob`, `speaker_id`) the browser never needs.
  const scribe = {
    language_code: 'eng',
    duration: 4.2,
    text: 'Pour it slow (laughter)',
    words: [
      {
        text: 'Pour',
        type: 'word',
        start: 0.1,
        end: 0.4,
        logprob: -0.01,
        speaker_id: 'speaker_0',
      },
      { text: ' ', type: 'spacing', start: 0.4, end: 0.5, logprob: 0 },
      {
        text: 'it',
        type: 'word',
        start: 0.5,
        end: 0.6,
        logprob: -0.02,
        speaker_id: 'speaker_0',
      },
      { text: ' ', type: 'spacing', start: 0.6, end: 0.7, logprob: 0 },
      {
        text: 'slow',
        type: 'word',
        start: 0.7,
        end: 1.2,
        logprob: -0.03,
        speaker_id: 'speaker_0',
      },
      {
        text: '(laughter)',
        type: 'audio_event',
        start: 1.3,
        end: 2.0,
        logprob: -0.5,
      },
    ],
  };

  const send = () =>
    request(app.getHttpServer())
      .post(URL)
      .field('durationSeconds', '4')
      .attach('audio', Buffer.from('fake-audio'), {
        filename: 'voice-note.webm',
        contentType: 'audio/webm',
      });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AiController],
      providers: [
        WorkspaceRoleGuard,
        { provide: WorkspaceRoleService, useValue: roles },
        { provide: GroqService, useValue: {} },
        { provide: AiTokenService, useValue: { executeWithTokens } },
        ElevenLabsSttService,
        { provide: ConfigService, useValue: { get: () => 'test-key' } },
        { provide: ComposerAiService, useValue: {} },
        { provide: InboxAiService, useValue: {} },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: {
          switchToHttp: () => { getRequest: () => { user?: unknown } };
        }) => {
          ctx.switchToHttp().getRequest().user = { userId: 'user-1' };
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });
  afterAll(() => app.close());

  beforeEach(() => {
    jest.clearAllMocks();
    roles.getRole.mockResolvedValue('MEMBER');
    roles.isPlatformSuperAdmin.mockResolvedValue(false);
    executeWithTokens.mockImplementation(
      async (
        _ws: string,
        _user: string,
        _op: string,
        _platform: string | undefined,
        _summary: string,
        run: () => Promise<{ result: unknown; outputLength?: number }>,
      ) => ({ result: (await run()).result, usage }),
    );
    // supertest talks to the app over node's http, not `fetch`, so this only
    // ever catches the call the speech service makes to ElevenLabs.
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(scribe),
    } as unknown as Response);
  });
  afterEach(() => fetchMock.mockRestore());

  it('replies with the spoken words and their timings, beside the text', async () => {
    const res = await send().expect(200);

    // The whole body, so a field added or dropped later is a visible change.
    expect(res.body as TranscribeResponse).toEqual({
      text: 'Pour it slow (laughter)',
      language: 'eng',
      durationSeconds: 4.2,
      words: [
        { text: 'Pour', start: 0.1, end: 0.4 },
        { text: 'it', start: 0.5, end: 0.6 },
        { text: 'slow', start: 0.7, end: 1.2 },
      ],
      usage,
    });
  });

  it('sends each word as exactly text, start and end', async () => {
    const res = await send().expect(200);
    for (const word of (res.body as TranscribeResponse).words) {
      expect(Object.keys(word).sort()).toEqual(['end', 'start', 'text']);
    }
  });

  it('replies with an empty list, not a missing field, when nothing was timed', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ text: '', language_code: 'eng' }),
    } as unknown as Response);

    const body = (await send().expect(200)).body as TranscribeResponse;

    expect(body.words).toEqual([]);
    expect(body.text).toBe('');
  });

  it('still meters the call as one speech_to_text, sized by the text', async () => {
    await send().expect(200);

    expect(executeWithTokens).toHaveBeenCalledTimes(1);
    const call = executeWithTokens.mock.calls[0] as [
      string,
      string,
      string,
      unknown,
      unknown,
      () => Promise<{ outputLength?: number }>,
    ];
    expect(call.slice(0, 3)).toEqual([WS, 'user-1', 'speech_to_text']);
    // The output length the usage log records is the text, not the words
    // array: returning timings must not change what a call is logged as.
    await expect(call[5]()).resolves.toMatchObject({
      outputLength: scribe.text.length,
    });
  });

  it('does not reach the speech service when the metering refuses', async () => {
    executeWithTokens.mockRejectedValue(new Error('out of tokens'));
    await send().expect(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is closed to someone who is not in the workspace', async () => {
    roles.getRole.mockResolvedValue(null);
    await send().expect(403);
    expect(executeWithTokens).not.toHaveBeenCalled();
  });

  it('refuses a request with no audio before spending anything', async () => {
    await request(app.getHttpServer())
      .post(URL)
      .field('durationSeconds', '4')
      .expect(400);
    expect(executeWithTokens).not.toHaveBeenCalled();
  });
});
