import { NextResponse } from 'next/server';
import { checkAdminPassword } from '@/lib/admin';

export const dynamic = 'force-dynamic';

/** POST /api/admin — verify the admin password (sent via x-admin-password). */
export async function POST(request: Request) {
  if (!checkAdminPassword(request.headers.get('x-admin-password'))) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
  }
  return NextResponse.json({ ok: true });
}
