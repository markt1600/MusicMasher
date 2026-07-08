import { timingSafeEqual } from 'crypto';

/**
 * Admin password check for song moderation. The password comes exclusively
 * from the ADMIN_PASSWORD environment variable — if it isn't set, admin
 * features are disabled entirely (every check fails).
 */
export function checkAdminPassword(provided: string | null): boolean {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
