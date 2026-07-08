import { NextResponse } from 'next/server';
import {
  registerBlobSong,
  sanitizeTitle,
  storageMode,
  isValidSongId,
  MAX_SONG_BYTES,
} from '@/lib/storage';
import type { SongMeta } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * POST /api/songs/register — after a direct-to-blob client upload finishes,
 * the client registers the song's metadata here so it appears in the library.
 */
export async function POST(request: Request) {
  if (storageMode() !== 'blob') {
    return NextResponse.json(
      { error: 'Blob storage is not configured' },
      { status: 501 }
    );
  }
  try {
    const body = (await request.json()) as Partial<SongMeta>;
    const id = String(body.id ?? '');
    const audioUrl = String(body.audioUrl ?? '');
    const duration = Number(body.duration ?? 0);
    const size = Number(body.size ?? 0);

    if (!isValidSongId(id)) {
      return NextResponse.json({ error: 'Invalid song id' }, { status: 400 });
    }
    // The audio URL must be a Vercel Blob URL for this song's path — prevents
    // registering arbitrary third-party URLs.
    let url: URL;
    try {
      url = new URL(audioUrl);
    } catch {
      return NextResponse.json({ error: 'Invalid audio URL' }, { status: 400 });
    }
    if (
      url.protocol !== 'https:' ||
      !url.hostname.endsWith('.public.blob.vercel-storage.com') ||
      !url.pathname.startsWith(`/songs/${id}/audio`)
    ) {
      return NextResponse.json({ error: 'Invalid audio URL' }, { status: 400 });
    }
    if (!Number.isFinite(duration) || duration <= 0 || duration > 60 * 20) {
      return NextResponse.json({ error: 'Invalid duration' }, { status: 400 });
    }
    if (!Number.isFinite(size) || size <= 0 || size > MAX_SONG_BYTES) {
      return NextResponse.json({ error: 'Invalid size' }, { status: 400 });
    }

    const meta: SongMeta = {
      id,
      title: sanitizeTitle(String(body.title ?? '')),
      duration: Math.round(duration * 100) / 100,
      audioUrl,
      size: Math.round(size),
      createdAt: new Date().toISOString(),
    };
    await registerBlobSong(meta);
    return NextResponse.json({ song: meta });
  } catch (err) {
    console.error('register failed', err);
    return NextResponse.json({ error: 'Register failed' }, { status: 500 });
  }
}
