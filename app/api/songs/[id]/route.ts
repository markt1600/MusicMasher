import { NextResponse } from 'next/server';
import { deleteSong, getSong, updateSongMeta } from '@/lib/storage';
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

/** PATCH /api/songs/:id — edit title/artist (admin only). */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!checkAdminPassword(request.headers.get('x-admin-password'))) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
  }
  const { id } = await params;
  try {
    const body = (await request.json()) as { title?: string; artist?: string };
    const fields: { title?: string; artist?: string } = {};
    if (typeof body.title === 'string') {
      if (!body.title.trim()) {
        return NextResponse.json({ error: 'Title cannot be empty' }, { status: 400 });
      }
      fields.title = body.title;
    }
    if (typeof body.artist === 'string') fields.artist = body.artist;
    const meta = await updateSongMeta(id, fields);
    if (!meta) {
      return NextResponse.json({ error: 'Song not found' }, { status: 404 });
    }
    return NextResponse.json({ song: meta });
  } catch (err) {
    console.error('update failed', err);
    return NextResponse.json({ error: 'Update failed' }, { status: 500 });
  }
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
