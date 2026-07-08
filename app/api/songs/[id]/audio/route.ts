import { NextResponse } from 'next/server';
import { getSong, readLocalAudio, storageMode } from '@/lib/storage';

export const dynamic = 'force-dynamic';

/**
 * GET /api/songs/:id/audio — serve MP3 bytes in local mode; in blob mode
 * redirect to the public blob URL.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (storageMode() === 'blob') {
    const song = await getSong(id);
    if (!song) {
      return NextResponse.json({ error: 'Song not found' }, { status: 404 });
    }
    return NextResponse.redirect(song.audioUrl, 302);
  }
  const bytes = await readLocalAudio(id);
  if (!bytes) {
    return NextResponse.json({ error: 'Song not found' }, { status: 404 });
  }
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': 'audio/mpeg',
      'Content-Length': String(bytes.length),
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
