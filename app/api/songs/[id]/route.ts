import { NextResponse } from 'next/server';
import { deleteSong, getSong } from '@/lib/storage';
import { checkAdminPassword } from '@/lib/admin';

export const dynamic = 'force-dynamic';

/** GET /api/songs/:id — song metadata. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const song = await getSong(id);
  if (!song) {
    return NextResponse.json({ error: 'Song not found' }, { status: 404 });
  }
  return NextResponse.json({ song });
}

/** DELETE /api/songs/:id — remove a song (admin only). */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!checkAdminPassword(request.headers.get('x-admin-password'))) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
  }
  const { id } = await params;
  try {
    const ok = await deleteSong(id);
    if (!ok) {
      return NextResponse.json({ error: 'Song not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('delete failed', err);
    return NextResponse.json({ error: 'Delete failed' }, { status: 500 });
  }
}
