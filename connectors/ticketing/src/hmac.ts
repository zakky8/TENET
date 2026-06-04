import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time HMAC-SHA256 verification.
 *
 * Returns true iff `provided` equals HMAC-SHA256(secret, payload) when
 * decoded from `provided` as hex OR base64. Different vendors use
 * different encodings; verify against the one the vendor declares in
 * their docs.
 */
export function verifyHmacSha256(
  secret: string,
  payload: string,
  provided: string,
  encoding: 'hex' | 'base64' = 'hex',
): boolean {
  if (!secret || !provided) return false;
  let providedBuf: Buffer;
  try {
    providedBuf = Buffer.from(provided.trim(), encoding);
  } catch {
    return false;
  }
  const expectedBuf = createHmac('sha256', secret).update(payload).digest();
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}
