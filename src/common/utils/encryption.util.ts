import * as crypto from 'crypto';

/**
 * Encryption utility for securely storing sensitive data like OAuth tokens.
 * Uses AES-256-GCM for authenticated encryption.
 *
 * IMPORTANT: Set ENCRYPTION_KEY in your .env file (32 bytes / 64 hex characters)
 * Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16; // 128 bits
const AUTH_TAG_LENGTH = 16; // 128 bits
const SALT_LENGTH = 32;

/**
 * Get encryption key from environment
 */
function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;

  if (!key) {
    throw new Error(
      'ENCRYPTION_KEY environment variable is required. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }

  // Key should be 64 hex characters (32 bytes)
  if (key.length !== 64) {
    throw new Error(
      'ENCRYPTION_KEY must be 64 hex characters (32 bytes). ' +
        `Current length: ${key.length}`,
    );
  }

  return Buffer.from(key, 'hex');
}

/**
 * Encrypt sensitive data (like OAuth tokens)
 *
 * @param plaintext - The data to encrypt
 * @returns Encrypted string in format: iv:authTag:ciphertext (all base64)
 */
export function encrypt(plaintext: string): string {
  if (!plaintext) {
    return plaintext;
  }

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:ciphertext (all base64 encoded)
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;
}

/**
 * Decrypt sensitive data
 *
 * @param ciphertext - The encrypted data in format: iv:authTag:ciphertext
 * @returns Decrypted plaintext string
 */
export function decrypt(ciphertext: string): string {
  if (!ciphertext) {
    return ciphertext;
  }

  // Handle non-encrypted values gracefully (for migration)
  if (!ciphertext.includes(':')) {
    console.warn('Attempting to decrypt non-encrypted value. Returning as-is.');
    return ciphertext;
  }

  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted data format');
  }

  const key = getEncryptionKey();
  const iv = Buffer.from(parts[0], 'base64');
  const authTag = Buffer.from(parts[1], 'base64');
  const encrypted = parts[2];

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Hash sensitive data (one-way, for comparison only)
 * Use this when you don't need to retrieve the original value
 *
 * @param data - The data to hash
 * @returns SHA-256 hash as hex string
 */
export function hash(data: string): string {
  if (!data) {
    return data;
  }

  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Generate a secure random token
 *
 * @param length - Length of the token in bytes (default: 32)
 * @returns Random token as hex string
 */
export function generateSecureToken(length: number = 32): string {
  return crypto.randomBytes(length).toString('hex');
}

/**
 * Generate a PKCE code verifier for OAuth 2.0
 *
 * @returns Code verifier string (43-128 characters)
 */
export function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Generate a PKCE code challenge from a code verifier
 *
 * @param codeVerifier - The code verifier
 * @returns Code challenge (base64url encoded SHA-256 hash)
 */
export function generateCodeChallenge(codeVerifier: string): string {
  return crypto.createHash('sha256').update(codeVerifier).digest('base64url');
}

/**
 * Encrypt an object (converts to JSON first)
 *
 * @param obj - Object to encrypt
 * @returns Encrypted string
 */
export function encryptObject<T extends object>(obj: T): string {
  return encrypt(JSON.stringify(obj));
}

/**
 * Decrypt an object (parses JSON after decryption)
 *
 * @param ciphertext - Encrypted string
 * @returns Decrypted object
 */
export function decryptObject<T extends object>(ciphertext: string): T {
  const decrypted = decrypt(ciphertext);
  return JSON.parse(decrypted) as T;
}

/**
 * Mask sensitive data for logging (show first and last 4 chars)
 *
 * @param data - Data to mask
 * @returns Masked string
 */
export function maskSensitiveData(data: string): string {
  if (!data || data.length < 12) {
    return '***';
  }
  return `${data.substring(0, 4)}...${data.substring(data.length - 4)}`;
}

/**
 * Compare two strings in constant time (prevents timing attacks)
 *
 * @param a - First string
 * @param b - Second string
 * @returns True if equal
 */
export function secureCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
