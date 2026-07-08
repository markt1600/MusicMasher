import { NextResponse } from 'next/server';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { storageMode, MAX_SONG_BYTES } from '@/lib/storage';

export const dynamic = 'force-dynamic';

/**
 * POST /api/songs/upload — token exchange for direct client → Vercel Blob
 * uploads. The MP3 bytes never pass through this function, so uploads are
 * not limited by the serverless request body cap.
 */
export async function POST(request: Request) {
  if (storageMode() !== 'blob') {
    return NextResponse.json(
      { error: 'Blob storage is not configured' },
      { status: 501 }
    );
  }
  try {
    const body = (await request.json()) as HandleUploadBody;
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (!/^songs\/[a-z0-9]{8,32}\/audio\.mp3$/.test(pathname)) {
          throw new Error('Invalid upload path');
        }
        return {
          allowedContentTypes: ['audio/mpeg', 'audio/mp3'],
          maximumSizeInBytes: MAX_SONG_BYTES,
          addRandomSuffix: false,
        };
      },
      onUploadCompleted: async () => {
        // Metadata is registered by the client via /api/songs/register,
        // because this webhook does not fire on localhost.
      },
    });
    return NextResponse.json(jsonResponse);
  } catch (err) {
    console.error('handleUpload failed', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Upload failed' },
      { status: 400 }
    );
  }
}
