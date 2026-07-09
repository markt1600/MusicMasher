import { NextResponse } from 'next/server';
import {
  handleUploadPresigned,
  type HandleUploadPresignedBody,
} from '@vercel/blob/client';
import { issueSignedToken } from '@vercel/blob';
import { storageMode, AUDIO_TYPES, MAX_SONG_BYTES } from '@/lib/storage';

export const dynamic = 'force-dynamic';

/**
 * POST /api/songs/upload — issues presigned upload URLs for direct
 * client → Vercel Blob uploads. The audio bytes never pass through this
 * function, so uploads are not limited by the serverless request body cap.
 *
 * Uses the presigned flow (rather than handleUpload's client tokens)
 * because it works with both credential styles: OIDC stores
 * (BLOB_STORE_ID + VERCEL_OIDC_TOKEN — the current default, which never
 * gets a static BLOB_READ_WRITE_TOKEN) and classic token stores.
 */
export async function POST(request: Request) {
  if (storageMode() !== 'blob') {
    return NextResponse.json(
      { error: 'Blob storage is not configured' },
      { status: 501 }
    );
  }
  try {
    const body = (await request.json()) as HandleUploadPresignedBody;
    const jsonResponse = await handleUploadPresigned({
      body,
      request,
      getSignedToken: async (pathname) => {
        const isAudio = /^songs\/[a-z0-9]{8,32}\/audio\.(mp3|aac|m4a|aiff|aif|wav)$/.test(pathname);
        const isArt = /^songs\/[a-z0-9]{8,32}\/art\.jpg$/.test(pathname);
        if (!isAudio && !isArt) {
          throw new Error('Invalid upload path');
        }
        const token = await issueSignedToken({
          pathname,
          operations: ['put'],
          allowedContentTypes: isArt
            ? ['image/jpeg']
            : [...new Set(Object.values(AUDIO_TYPES))],
          maximumSizeInBytes: isArt ? 2 * 1024 * 1024 : MAX_SONG_BYTES,
          validUntil: Date.now() + 15 * 60 * 1000,
        });
        return { token };
      },
    });
    return NextResponse.json(jsonResponse);
  } catch (err) {
    console.error('handleUploadPresigned failed', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Upload failed' },
      { status: 400 }
    );
  }
}
