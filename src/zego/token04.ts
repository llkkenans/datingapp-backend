/**
 * ZEGOCLOUD Token04 generator — Node.js implementation.
 *
 * Follows the official ZEGOCLOUD server-side token specification:
 *   https://github.com/ZEGOCLOUD/zego_server_assistant
 *
 * Token binary layout (before base64):
 *   [8 bytes]  expire_time — int64 big-endian (Unix seconds)
 *   [2 bytes]  iv_length   — int16 big-endian (always 16 for AES)
 *   [16 bytes] IV          — random bytes
 *   [N bytes]  ciphertext  — AES-256-CBC(PKCS7, key=serverSecret ASCII bytes, iv=IV)
 *
 * Final token string: "04" + base64(binary)
 *
 * The AES key is the serverSecret treated as raw ASCII bytes (32 chars → 32 bytes → AES-256).
 * Do NOT hex-decode the serverSecret before using it as the key.
 */

import * as crypto from 'crypto';

export interface TokenPayload {
  app_id: number;
  user_id: string;
  nonce: number;
  ctime: number;   // creation time (Unix seconds)
  expire: number;  // expiry time (Unix seconds)
  payload: string; // room restriction or empty string
}

/**
 * Generates a ZEGOCLOUD Token04.
 *
 * @param appId             - ZEGOCLOUD App ID (numeric)
 * @param userId            - the user this token is issued for
 * @param serverSecret      - 32-character hex string from ZEGOCLOUD console
 * @param effectiveSeconds  - token lifetime in seconds
 * @param payload           - optional JSON string for privilege/room restriction; empty = no restriction
 */
export function generateToken04(
  appId: number,
  userId: string,
  serverSecret: string,
  effectiveSeconds: number,
  payload = '',
): string {
  const now = Math.floor(Date.now() / 1000);
  const expire = now + effectiveSeconds;

  const tokenInfo: TokenPayload = {
    app_id: appId,
    user_id: userId,
    nonce: (Math.random() * 0x7fffffff) | 0,
    ctime: now,
    expire,
    payload,
  };

  const plaintext = Buffer.from(JSON.stringify(tokenInfo), 'utf8');

  // Key: serverSecret as ASCII bytes — 32 chars → 32 bytes → AES-256-CBC
  const key = Buffer.from(serverSecret, 'ascii');
  if (key.length !== 32) {
    throw new Error(`ZEGO server secret must be 32 ASCII characters, got ${key.length}`);
  }

  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  // Pack binary: expire(8) + ivLen(2) + iv(16) + ciphertext
  const buf = Buffer.allocUnsafe(8 + 2 + iv.length + ciphertext.length);
  let offset = 0;

  buf.writeBigInt64BE(BigInt(expire), offset);
  offset += 8;

  buf.writeInt16BE(iv.length, offset);
  offset += 2;

  iv.copy(buf, offset);
  offset += iv.length;

  ciphertext.copy(buf, offset);

  return '04' + buf.toString('base64');
}

/** Derives the ZEGOCLOUD room ID for a voice match session. */
export function deriveRoomId(sessionId: string): string {
  return `voice-${sessionId}`;
}
