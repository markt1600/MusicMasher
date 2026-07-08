import { NextResponse } from 'next/server';
import {
  listSongs,
  saveLocalSong,
  sanitizeTitle,
  storageMode,
  isValidSongId,
  isValidExt,
  MAX_SONG_BYTES,
} from '@/lib/storage';

export const dynamic = 'force-dynamic';

/** GET /api/songs — list all uploaded songs. */
export async function GET() {
  try {
    const songs = await listSongs();
    return NextResponse.json({ songs, mode: storageMode() });
  } catch (err) {
    console.error('listSongs failed', err);
    return NextResponse.json({ error: 'Failed to list songs' }, { status: 500 });
  }
}

/**
 * POST /api/songs — multipart upload (local/dev mode only).
 * In blob mode clients upload directly to Vercel Blob instead (see
 * /api/songs/upload + /api/songs/register), which avoids the 4.5 MB
 * serverless request body limit.
 */
export async function POST(request: Request) {
  if (storageMode() === 'blob') {
    return NextResponse.json(
      { error: 'Use client upload in blob mode' },
      { status: 400 }
    );
  }
  try {
    const form = await request.formData();
    const file = form.get('file');
    const id = String(form.get('id') ?? '');
    const title = sanitizeTitle(String(form.get('title') ?? ''));
    const artist = sanitizeTitle(String(form.get('artist') ?? ''), '');
    const ext = String(form.get('ext') ?? '').toLowerCase();
    const duration = Number(form.get('duration') ?? 0);

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Missing file' }, { status: 400 });
    }
    if (!isValidSongId(id)) {
      return NextResponse.json({ error: 'Invalid song id' }, { status: 400 });
    }
    if (!isValidExt(ext)) {
      return NextResponse.json(
        { error: 'Unsupported format — use MP3, AAC, AIFF or WAV' },
        { status: 400 }
      );
    }
    if (file.size > MAX_SONG_BYTES) {
      return NextResponse.json({ error: 'File too large (50 MB max)' }, { status: 413 });
    }
    if (!Number.isFinite(duration) || duration <= 0 || duration > 60 * 20) {
      return NextResponse.json({ error: 'Invalid duration' }, { status: 400 });
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const meta = await saveLocalSong(
      {
        id,
        title,
        artist,
        ext,
        duration: Math.round(duration * 100) / 100,
        size: bytes.length,
        createdAt: new Date().toISOString(),
      },
      bytes
    );
    return NextResponse.json({ song: meta });
  } catch (err) {
    console.error('upload failed', err);
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}
