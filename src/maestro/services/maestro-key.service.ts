import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import type { DbType } from '../../drizzle/db';
import { workspace } from '../../drizzle/schema/workspace.schema';
import { encrypt, decrypt } from '../../common/utils/encryption.util';

/** What settings/the wizard may safely see about a stored key. */
export interface MaestroKeyStatus {
  /** True when the workspace has its own key (BYOK) configured. */
  hasOwnKey: boolean;
  /** Masked tail for display, e.g. "sk-ant-…4f2a". Null when no key is set. */
  hint: string | null;
  /** When the key was last saved. Null when no key is set. */
  setAt: string | null;
  /** True once the first-run Maestro wizard has been completed. */
  onboarded: boolean;
}

/** Anthropic keys look like `sk-ant-…`; length varies, so keep the check loose. */
const KEY_PREFIX = 'sk-ant-';
const MIN_KEY_LENGTH = 20;

/** Anthropic endpoint used to prove a key works before we store it. */
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models?limit=1';
const ANTHROPIC_VERSION = '2023-06-01';
const VALIDATION_TIMEOUT_MS = 10_000;

/**
 * Stores and resolves a workspace's own Anthropic API key (BYOK).
 *
 * The key is encrypted at rest with the same AES-256-GCM helper that protects
 * OAuth/channel tokens, and is NEVER returned to the client — callers get a
 * masked `hint` instead. It is decrypted only at the moment a Maestro turn
 * hands it to the Agent SDK.
 *
 * A key is validated against Anthropic BEFORE it is stored, so a typo fails at
 * save time (where the user can fix it) rather than on their first chat turn.
 */
@Injectable()
export class MaestroKeyService {
  private readonly logger = new Logger(MaestroKeyService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  /** Non-sensitive key/onboarding state for settings + the first-run wizard. */
  async getStatus(workspaceId: string): Promise<MaestroKeyStatus> {
    const row = await this.db.query.workspace.findFirst({
      where: eq(workspace.id, workspaceId),
      columns: {
        maestroAnthropicKey: true,
        maestroAnthropicKeyHint: true,
        maestroAnthropicKeySetAt: true,
        maestroOnboardedAt: true,
      },
    });
    const hint = row?.maestroAnthropicKeyHint ?? null;
    return {
      hasOwnKey: Boolean(row?.maestroAnthropicKey),
      hint: hint ? `${KEY_PREFIX}…${hint}` : null,
      setAt: row?.maestroAnthropicKeySetAt
        ? row.maestroAnthropicKeySetAt.toISOString()
        : null,
      onboarded: Boolean(row?.maestroOnboardedAt),
    };
  }

  /**
   * The workspace's decrypted key, or null when it has none (→ platform key).
   * Called on every Maestro turn, so a corrupt/undecryptable value must not
   * break chat: we log and fall back to null rather than throwing.
   */
  async getDecryptedKey(workspaceId: string): Promise<string | null> {
    const row = await this.db.query.workspace.findFirst({
      where: eq(workspace.id, workspaceId),
      columns: { maestroAnthropicKey: true },
    });
    if (!row?.maestroAnthropicKey) return null;
    try {
      return decrypt(row.maestroAnthropicKey) || null;
    } catch (err) {
      // Usually a rotated ENCRYPTION_KEY. Never log the ciphertext itself.
      this.logger.error(
        `Failed to decrypt Maestro key for workspace ${workspaceId}: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
      return null;
    }
  }

  /**
   * Validate a key against Anthropic, then store it encrypted.
   * @throws BadRequestException when the key is malformed or rejected.
   */
  async setKey(workspaceId: string, rawKey: string): Promise<MaestroKeyStatus> {
    const key = (rawKey ?? '').trim();
    if (!key.startsWith(KEY_PREFIX) || key.length < MIN_KEY_LENGTH) {
      throw new BadRequestException(
        'That does not look like an Anthropic API key. It should start with "sk-ant-".',
      );
    }

    await this.assertKeyWorks(key);

    await this.db
      .update(workspace)
      .set({
        maestroAnthropicKey: encrypt(key),
        maestroAnthropicKeyHint: key.slice(-4),
        maestroAnthropicKeySetAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(workspace.id, workspaceId));

    this.logger.log(`Maestro BYOK key set for workspace ${workspaceId}`);
    return this.getStatus(workspaceId);
  }

  /** Remove the workspace's key — Maestro reverts to the platform key. */
  async removeKey(workspaceId: string): Promise<MaestroKeyStatus> {
    await this.db
      .update(workspace)
      .set({
        maestroAnthropicKey: null,
        maestroAnthropicKeyHint: null,
        maestroAnthropicKeySetAt: null,
        updatedAt: new Date(),
      })
      .where(eq(workspace.id, workspaceId));

    this.logger.log(`Maestro BYOK key removed for workspace ${workspaceId}`);
    return this.getStatus(workspaceId);
  }

  /** Mark the first-run wizard complete so it does not show again. */
  async markOnboarded(workspaceId: string): Promise<MaestroKeyStatus> {
    await this.db
      .update(workspace)
      .set({ maestroOnboardedAt: new Date(), updatedAt: new Date() })
      .where(eq(workspace.id, workspaceId));
    return this.getStatus(workspaceId);
  }

  /**
   * Prove a key works by making one cheap authenticated call. Distinguishes a
   * rejected key (401/403) from Anthropic being unreachable — we refuse to
   * store a key we could not verify either way, so the user is never left
   * believing a broken key is active.
   */
  private async assertKeyWorks(key: string): Promise<void> {
    let res: Response;
    try {
      res = await fetch(ANTHROPIC_MODELS_URL, {
        method: 'GET',
        headers: {
          'x-api-key': key,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
      });
    } catch {
      throw new BadRequestException(
        "Couldn't reach Anthropic to verify that key. Please try again in a moment.",
      );
    }

    if (res.ok) return;

    if (res.status === 401 || res.status === 403) {
      throw new BadRequestException(
        'Anthropic rejected that API key. Check that you copied it correctly and that it is still active.',
      );
    }
    if (res.status === 429) {
      throw new BadRequestException(
        'That key is currently rate-limited by Anthropic, so we could not verify it. Try again shortly.',
      );
    }
    throw new BadRequestException(
      `Anthropic could not verify that key (HTTP ${res.status}). Please try again.`,
    );
  }
}
