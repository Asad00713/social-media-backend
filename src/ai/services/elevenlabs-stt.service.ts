import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * One spoken word with where it sits in the audio, in seconds.
 *
 * This is also the wire shape of `POST /ai/workspaces/:id/transcribe`'s
 * `words` field — kept to the three fields captions need, so the speech
 * service's own bookkeeping (log-probabilities, speaker ids, per-character
 * timings) never reaches the browser.
 */
export interface TranscribedWord {
  text: string;
  start: number;
  end: number;
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  durationSeconds?: number;
  /** Spoken words only, in the order spoken. Empty when none were timed. */
  words: TranscribedWord[];
}

export interface TranscriptionOptions {
  languageCode?: string; // ISO 639-1 code, e.g., 'en', 'es', 'fr'
}

// ElevenLabs' speech-to-text model. `scribe_v1` is the accurate one; the
// `_experimental` variant is faster but less so, and dictation is read back
// before it is sent, so accuracy is worth more than latency here.
const STT_MODEL_ID = 'scribe_v1';

// Duration limits in seconds
const MAX_DURATION_SECONDS = 180; // 3 minutes max
const MIN_DURATION_SECONDS = 1; // At least 1 second

// Supported audio formats
const SUPPORTED_FORMATS = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/m4a',
];

@Injectable()
export class ElevenLabsSttService {
  private readonly logger = new Logger(ElevenLabsSttService.name);
  private readonly apiKey: string | undefined;
  private readonly baseUrl = 'https://api.elevenlabs.io/v1';

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.get<string>('ELEVENLABS_API_KEY');
    if (!this.apiKey) {
      this.logger.warn(
        'ELEVENLABS_API_KEY not configured - STT features will be unavailable',
      );
    } else {
      this.logger.log('ElevenLabs STT service initialized');
    }
  }

  /**
   * Check if the service is ready
   */
  isReady(): boolean {
    return !!this.apiKey;
  }

  /**
   * Validate audio file before transcription
   */
  validateAudioFile(
    file: Express.Multer.File,
    durationSeconds?: number,
  ): { valid: boolean; error?: string } {
    // Check if file exists
    if (!file) {
      return { valid: false, error: 'No audio file provided' };
    }

    // Check file type
    if (!SUPPORTED_FORMATS.includes(file.mimetype)) {
      return {
        valid: false,
        error: `Unsupported audio format: ${file.mimetype}. Supported formats: ${SUPPORTED_FORMATS.join(', ')}`,
      };
    }

    // Check file size (max 25MB)
    const maxSizeBytes = 25 * 1024 * 1024;
    if (file.size > maxSizeBytes) {
      return {
        valid: false,
        error: `File too large: ${(file.size / 1024 / 1024).toFixed(2)}MB. Maximum size is 25MB`,
      };
    }

    // Check duration if provided
    if (durationSeconds !== undefined) {
      if (durationSeconds < MIN_DURATION_SECONDS) {
        return {
          valid: false,
          error: `Audio too short: ${durationSeconds}s. Minimum duration is ${MIN_DURATION_SECONDS} second`,
        };
      }

      if (durationSeconds > MAX_DURATION_SECONDS) {
        return {
          valid: false,
          error: `Audio too long: ${durationSeconds}s. Maximum duration is ${MAX_DURATION_SECONDS} seconds (3 minutes)`,
        };
      }
    }

    return { valid: true };
  }

  /**
   * Transcribe audio file using ElevenLabs Scribe API
   */
  async transcribe(
    audioBuffer: Buffer,
    filename: string,
    mimeType: string,
    options?: TranscriptionOptions,
  ): Promise<TranscriptionResult> {
    if (!this.apiKey) {
      throw new BadRequestException('ElevenLabs API is not configured');
    }

    try {
      this.logger.log(`Transcribing audio file: ${filename}`);

      // Create form data
      const formData = new FormData();
      // Convert Buffer to Uint8Array for Blob compatibility
      const uint8Array = new Uint8Array(audioBuffer);
      const blob = new Blob([uint8Array], { type: mimeType });
      formData.append('file', blob, filename);
      // Required by the API, not optional: without it every request comes back
      // 422 {"loc":["body","model_id"],"msg":"Field required"} and the caller
      // sees "Transcription failed: unknown".
      formData.append('model_id', STT_MODEL_ID);

      // Add optional language code
      if (options?.languageCode) {
        formData.append('language_code', options.languageCode);
      }

      // Call ElevenLabs Speech-to-Text API
      const response = await fetch(`${this.baseUrl}/speech-to-text`, {
        method: 'POST',
        headers: {
          'xi-api-key': this.apiKey,
        },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(
          `ElevenLabs STT error: ${response.status} - ${errorText}`,
        );
        // `statusText` is empty over HTTP/2, which rendered every failure as
        // "Transcription failed: unknown" and sent whoever was debugging to
        // the logs to find out what actually went wrong.
        throw new BadRequestException(
          `Transcription failed: ${describeSttError(errorText, response.status)}`,
        );
      }

      const data = await response.json();

      this.logger.log(`Transcription completed successfully`);

      return {
        text: data.text || '',
        language: data.language_code,
        durationSeconds: data.duration,
        words: toTranscribedWords(data.words),
      };
    } catch (error) {
      this.logger.error(`Transcription error: ${error}`);
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException('Failed to transcribe audio');
    }
  }

  /**
   * Transcribe audio from a file upload
   */
  async transcribeFile(
    file: Express.Multer.File,
    options?: TranscriptionOptions,
  ): Promise<TranscriptionResult> {
    // Validate file first
    const validation = this.validateAudioFile(file);
    if (!validation.valid) {
      throw new BadRequestException(validation.error);
    }

    return this.transcribe(
      file.buffer,
      file.originalname,
      file.mimetype,
      options,
    );
  }

  /**
   * Get supported audio formats
   */
  getSupportedFormats(): string[] {
    return [...SUPPORTED_FORMATS];
  }

  /**
   * Get max duration in seconds
   */
  getMaxDuration(): number {
    return MAX_DURATION_SECONDS;
  }
}

/**
 * The timed words out of a Scribe response's `words` array.
 *
 * What ElevenLabs documents for each entry (api-reference/speech-to-text/
 * convert): `type` is `word`, `spacing` or `audio_event`; `start` and `end`
 * are seconds and both are optional and nullable. Captions need the words
 * and nothing else, so:
 *
 * - the gaps between words (`spacing`) and the non-speech tags such as
 *   "(laughter)" (`audio_event`) are dropped — they would otherwise be cut
 *   into a caption line of their own;
 * - an entry with no usable start and end is dropped, not given invented
 *   times: a cue is only as good as its timing.
 *
 * An entry with no `type` at all is kept, so a response from a model that
 * omits it still yields captions.
 */
export function toTranscribedWords(raw: unknown): TranscribedWord[] {
  if (!Array.isArray(raw)) return [];
  const words: TranscribedWord[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { text, type, start, end } = entry as Record<string, unknown>;
    if (type !== undefined && type !== null && type !== 'word') continue;
    if (typeof text !== 'string' || text.trim() === '') continue;
    if (typeof start !== 'number' || !Number.isFinite(start)) continue;
    if (typeof end !== 'number' || !Number.isFinite(end)) continue;
    if (start < 0 || end < start) continue;
    words.push({ text: text.trim(), start, end });
  }
  return words;
}

/**
 * The readable half of an ElevenLabs error body.
 *
 * Their errors arrive in two shapes: `{detail: {message}}` for rejections we
 * can act on ("File is corrupted"), and `{detail: [{loc, msg}]}` for schema
 * complaints. Anything else falls back to the status code, which at least says
 * whether it was us or them.
 */
function describeSttError(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as {
      detail?: { message?: string } | Array<{ msg?: string }>;
    };
    const detail = parsed.detail;
    if (Array.isArray(detail)) {
      const msgs = detail.map((d) => d?.msg).filter(Boolean);
      if (msgs.length) return msgs.join('; ');
    } else if (detail?.message) {
      return detail.message;
    }
  } catch {
    // Not JSON — fall through to the status code.
  }
  return `HTTP ${status}`;
}
