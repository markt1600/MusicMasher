import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { getSong, isValidSongId, storageMode } from '@/lib/storage';

export const dynamic = 'force-dynamic';

/** GET /api/songs/:id/art — album art (local mode serves bytes; blob redirects). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isValidSongId(id)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (storageMode() === 'blob') {
    const song = await getSong(id);
    if (!song?.artUrl) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.redirect(song.artUrl, 302);
  }
  try {
    const bytes = await fs.readFile(
      path.join(process.cwd(), '.data', 'songs', `${id}.jpg`)
    );
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
}
