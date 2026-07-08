import fs from 'fs/promises';
import path from 'path';
import { list, put } from '@vercel/blob';
import type { SongMeta } from './types';

export const MAX_SONG_BYTES = 25 * 1024 * 1024; // 25 MB
export const MAX_TITLE_LENGTH = 80;

export type StorageMode = 'blob' | 'local';

export function storageMode(): StorageMode {
  return process.env.BLOB_READ_WRITE_TOKEN ? 'blob' : 'local';
}

const LOCAL_DIR = path.join(process.cwd(), '.data', 'songs');

export function sanitizeTitle(raw: string): string {
  const cleaned = raw.replace(/[\u0000-\u001f<>]/g, '').trim();
  return (cleaned || 'Untitled').slice(0, MAX_TITLE_LENGTH);
}

export function isValidSongId(id: string): boolean {
  return /^[a-z0-9]{8,32}$/.test(id);
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export async function listSongs(): Promise<SongMeta[]> {
  const songs =
    storageMode() === 'blob' ? await listSongsBlob() : await listSongsLocal();
  return songs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function listSongsBlob(): Promise<SongMeta[]> {
  const metas: SongMeta[] = [];
  let cursor: string | undefined;
  do {
    const res = await list({ prefix: 'songs/', cursor, limit: 1000 });
    cursor = res.cursor;
    const metaBlobs = res.blobs.filter((b) => b.pathname.endsWith('/meta.json'));
    const fetched = await Promise.all(
      metaBlobs.map(async (b) => {
        try {
          const r = await fetch(b.url, { cache: 'no-store' });
          if (!r.ok) return null;
          return (await r.json()) as SongMeta;
        } catch {
          return null;
        }
      })
    );
    for (const m of fetched) {
      if (m && m.id && m.audioUrl) metas.push(m);
    }
  } while (cursor);
  return metas;
}

async function listSongsLocal(): Promise<SongMeta[]> {
  try {
    const files = await fs.readdir(LOCAL_DIR);
    const metas: SongMeta[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(LOCAL_DIR, f), 'utf8');
        metas.push(JSON.parse(raw) as SongMeta);
      } catch {
        // skip corrupt entries
      }
    }
    return metas;
  } catch {
    return []; // directory does not exist yet
  }
}

// ---------------------------------------------------------------------------
// Single song
// ---------------------------------------------------------------------------

export async function getSong(id: string): Promise<SongMeta | null> {
  if (!isValidSongId(id)) return null;
  if (storageMode() === 'blob') {
    const res = await list({ prefix: `songs/${id}/`, limit: 10 });
    const metaBlob = res.blobs.find((b) => b.pathname.endsWith('/meta.json'));
    if (!metaBlob) return null;
    try {
      const r = await fetch(metaBlob.url, { cache: 'no-store' });
      if (!r.ok) return null;
      return (await r.json()) as SongMeta;
    } catch {
      return null;
    }
  }
  try {
    const raw = await fs.readFile(path.join(LOCAL_DIR, `${id}.json`), 'utf8');
    return JSON.parse(raw) as SongMeta;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

/** Blob mode: write meta.json after the client has uploaded the MP3 directly. */
export async function registerBlobSong(meta: SongMeta): Promise<void> {
  await put(`songs/${meta.id}/meta.json`, JSON.stringify(meta), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

/** Local mode: persist the MP3 bytes and metadata to disk. */
export async function saveLocalSong(
  meta: Omit<SongMeta, 'audioUrl'>,
  bytes: Buffer
): Promise<SongMeta> {
  await fs.mkdir(LOCAL_DIR, { recursive: true });
  await fs.writeFile(path.join(LOCAL_DIR, `${meta.id}.mp3`), bytes);
  const full: SongMeta = { ...meta, audioUrl: `/api/songs/${meta.id}/audio` };
  await fs.writeFile(
    path.join(LOCAL_DIR, `${meta.id}.json`),
    JSON.stringify(full, null, 2)
  );
  return full;
}

export async function readLocalAudio(id: string): Promise<Buffer | null> {
  if (!isValidSongId(id)) return null;
  try {
    return await fs.readFile(path.join(LOCAL_DIR, `${id}.mp3`));
  } catch {
    return null;
  }
}
