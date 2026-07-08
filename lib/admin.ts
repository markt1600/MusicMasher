import { timingSafeEqual } from 'crypto';

/**
 * Admin password check for song moderation. Override the default with the
 * ADMIN_PASSWORD environment variable in production.
 */
export function checkAdminPassword(provided: string | null): boolean {
  const expected = process.env.ADMIN_PASSWORD || 'yippy';
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
