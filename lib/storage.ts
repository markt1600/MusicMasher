import fs from 'fs/promises';
import path from 'path';
import { del, list, put } from '@vercel/blob';
import type { SongMeta } from './types';

export const MAX_SONG_BYTES = 50 * 1024 * 1024; // 50 MB (WAV/AIFF are uncompressed)
export const MAX_TITLE_LENGTH = 80;

/** Supported upload formats and the content types they're served with. */
export const AUDIO_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
  wav: 'audio/wav',
};

export function isValidExt(ext: string): boolean {
  return Object.prototype.hasOwnProperty.call(AUDIO_TYPES, ext);
}

export type StorageMode = 'blob' | 'local';

export function storageMode(): StorageMode {
  // Classic stores inject a static BLOB_READ_WRITE_TOKEN; newer stores use
  // OIDC and inject BLOB_STORE_ID instead (the runtime provides
  // VERCEL_OIDC_TOKEN). The SDK handles either automatically.
  return process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID
    ? 'blob'
    : 'local';
}

const LOCAL_DIR = path.join(process.cwd(), '.data', 'songs');

export function sanitizeTitle(raw: string, fallback = 'Untitled'): string {
  const cleaned = raw.replace(/[\u0000-\u001f<>]/g, '').trim();
  return (cleaned || fallback).slice(0, MAX_TITLE_LENGTH);
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

/** Local mode: persist the audio bytes, optional art, and metadata to disk. */
export async function saveLocalSong(
  meta: Omit<SongMeta, 'audioUrl'>,
  bytes: Buffer,
  artBytes?: Buffer | null
): Promise<SongMeta> {
  const ext = meta.ext && isValidExt(meta.ext) ? meta.ext : 'mp3';
  await fs.mkdir(LOCAL_DIR, { recursive: true });
  await fs.writeFile(path.join(LOCAL_DIR, `${meta.id}.${ext}`), bytes);
  if (artBytes) {
    await fs.writeFile(path.join(LOCAL_DIR, `${meta.id}.jpg`), artBytes);
  }
  const full: SongMeta = { ...meta, audioUrl: `/api/songs/${meta.id}/audio` };
  await fs.writeFile(
    path.join(LOCAL_DIR, `${meta.id}.json`),
    JSON.stringify(full, null, 2)
  );
  return full;
}

// ---------------------------------------------------------------------------
// Chart cache — computed charts are deterministic, so the first player's
// analysis can be reused by everyone (keyed by algorithm version+difficulty)
// ---------------------------------------------------------------------------

const CHARTS_DIR = path.join(process.cwd(), '.data', 'charts');
const GHOSTS_DIR = path.join(process.cwd(), '.data', 'ghosts');
export const MAX_CHART_BYTES = 800 * 1024;
export const MAX_GHOST_BYTES = 300 * 1024;

// ---------------------------------------------------------------------------
// Ghost replays — one JSON document per song per player
// ---------------------------------------------------------------------------

function ghostKey(name: string): string {
  return Buffer.from(name, 'utf8').toString('base64url');
}

export async function putGhost(
  songId: string,
  name: string,
  json: string
): Promise<void> {
  const key = ghostKey(name);
  if (storageMode() === 'blob') {
    await put(`ghosts/${songId}/${key}.json`, json, {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  } else {
    await fs.mkdir(path.join(GHOSTS_DIR, songId), { recursive: true });
    await fs.writeFile(path.join(GHOSTS_DIR, songId, `${key}.json`), json);
  }
}

export async function getGhost(
  songId: string,
  name: string
): Promise<string | null> {
  const key = ghostKey(name);
  if (storageMode() === 'blob') {
    const pathname = `ghosts/${songId}/${key}.json`;
    const res = await list({ prefix: pathname, limit: 5 });
    const blob = res.blobs.find((b) => b.pathname === pathname);
    if (!blob) return null;
    try {
      const r = await fetch(blob.url, { cache: 'no-store' });
      return r.ok ? await r.text() : null;
    } catch {
      return null;
    }
  }
  try {
    return await fs.readFile(path.join(GHOSTS_DIR, songId, `${key}.json`), 'utf8');
  } catch {
    return null;
  }
}

function chartKey(songId: string, version: number, difficulty: number): string {
  return `${songId}-v${version}-d${difficulty}`;
}

export async function getCachedChart(
  songId: string,
  version: number,
  difficulty: number
): Promise<string | null> {
  const key = chartKey(songId, version, difficulty);
  if (storageMode() === 'blob') {
    const pathname = `charts/${songId}/${key}.json`;
    const res = await list({ prefix: pathname, limit: 5 });
    const blob = res.blobs.find((b) => b.pathname === pathname);
    if (!blob) return null;
    try {
      const r = await fetch(blob.url, { cache: 'no-store' });
      return r.ok ? await r.text() : null;
    } catch {
      return null;
    }
  }
  try {
    return await fs.readFile(path.join(CHARTS_DIR, `${key}.json`), 'utf8');
  } catch {
    return null;
  }
}

export async function putCachedChart(
  songId: string,
  version: number,
  difficulty: number,
  json: string
): Promise<void> {
  const key = chartKey(songId, version, difficulty);
  if (storageMode() === 'blob') {
    await put(`charts/${songId}/${key}.json`, json, {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  } else {
    await fs.mkdir(CHARTS_DIR, { recursive: true });
    await fs.writeFile(path.join(CHARTS_DIR, `${key}.json`), json);
  }
}

// ---------------------------------------------------------------------------
// Global scoreboards — one JSON document per song holding each player's best
// ---------------------------------------------------------------------------

export interface ScoreEntry {
  score: number;
  acc: number;
  maxCombo: number;
  grade: string;
  updatedAt: string;
}

export interface SongScores {
  players: Record<string, ScoreEntry>;
}

const SCORES_DIR = path.join(process.cwd(), '.data', 'scores');
const MAX_PLAYERS_PER_SONG = 200;

/** The demo track has scores too, even though it has no uploaded meta. */
export function isValidScoreSongId(id: string): boolean {
  return id === 'demo' || isValidSongId(id);
}

export async function getSongScores(songId: string): Promise<SongScores> {
  if (!isValidScoreSongId(songId)) return { players: {} };
  if (storageMode() === 'blob') {
    const res = await list({ prefix: `scores/${songId}.json`, limit: 5 });
    const blob = res.blobs.find((b) => b.pathname === `scores/${songId}.json`);
    if (!blob) return { players: {} };
    try {
      const r = await fetch(blob.url, { cache: 'no-store' });
      if (!r.ok) return { players: {} };
      return (await r.json()) as SongScores;
    } catch {
      return { players: {} };
    }
  }
  try {
    const raw = await fs.readFile(path.join(SCORES_DIR, `${songId}.json`), 'utf8');
    return JSON.parse(raw) as SongScores;
  } catch {
    return { players: {} };
  }
}

async function writeSongScores(songId: string, scores: SongScores): Promise<void> {
  // Bound the document: keep only the top N players by score.
  const entries = Object.entries(scores.players)
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, MAX_PLAYERS_PER_SONG);
  const bounded: SongScores = { players: Object.fromEntries(entries) };
  if (storageMode() === 'blob') {
    await put(`scores/${songId}.json`, JSON.stringify(bounded), {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  } else {
    await fs.mkdir(SCORES_DIR, { recursive: true });
    await fs.writeFile(
      path.join(SCORES_DIR, `${songId}.json`),
      JSON.stringify(bounded, null, 2)
    );
  }
}

/** Record a player's result if it beats their previous best for the song. */
export async function submitGlobalScore(
  songId: string,
  name: string,
  entry: ScoreEntry
): Promise<{ updated: boolean; scores: SongScores }> {
  const scores = await getSongScores(songId);
  const prev = scores.players[name];
  if (prev && prev.score >= entry.score) {
    return { updated: false, scores };
  }
  scores.players[name] = entry;
  await writeSongScores(songId, scores);
  return { updated: true, scores };
}

/** All scoreboards, keyed by song id. */
export async function getAllScores(): Promise<Record<string, SongScores>> {
  const result: Record<string, SongScores> = {};
  if (storageMode() === 'blob') {
    let cursor: string | undefined;
    do {
      const res = await list({ prefix: 'scores/', cursor, limit: 1000 });
      cursor = res.cursor;
      const fetched = await Promise.all(
        res.blobs
          .filter((b) => b.pathname.endsWith('.json'))
          .map(async (b) => {
            const songId = b.pathname.slice('scores/'.length, -'.json'.length);
            try {
              const r = await fetch(b.url, { cache: 'no-store' });
              if (!r.ok) return null;
              return [songId, (await r.json()) as SongScores] as const;
            } catch {
              return null;
            }
          })
      );
      for (const item of fetched) {
        if (item) result[item[0]] = item[1];
      }
    } while (cursor);
    return result;
  }
  try {
    const files = await fs.readdir(SCORES_DIR);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(SCORES_DIR, f), 'utf8');
        result[f.slice(0, -'.json'.length)] = JSON.parse(raw) as SongScores;
      } catch {
        // skip corrupt file
      }
    }
  } catch {
    // no scores yet
  }
  return result;
}

/** Persist an updated meta record (blob or local). */
async function writeMeta(meta: SongMeta): Promise<void> {
  if (storageMode() === 'blob') {
    await registerBlobSong(meta);
  } else {
    await fs.writeFile(
      path.join(LOCAL_DIR, `${meta.id}.json`),
      JSON.stringify(meta, null, 2)
    );
  }
}

/** Bump the shared play counter. Best-effort — races just drop a count. */
export async function incrementPlays(id: string): Promise<void> {
  const meta = await getSong(id);
  if (!meta) return;
  meta.plays = (meta.plays ?? 0) + 1;
  await writeMeta(meta);
}

/** Update editable song fields (admin). Returns the new meta or null. */
export async function updateSongMeta(
  id: string,
  fields: { title?: string; artist?: string }
): Promise<SongMeta | null> {
  const meta = await getSong(id);
  if (!meta) return null;
  if (fields.title !== undefined) meta.title = sanitizeTitle(fields.title);
  if (fields.artist !== undefined) meta.artist = sanitizeTitle(fields.artist, '');
  await writeMeta(meta);
  return meta;
}

/** Remove a song (audio, metadata, cached charts, scores, ghosts). */
export async function deleteSong(id: string): Promise<boolean> {
  if (!isValidSongId(id)) return false;
  if (storageMode() === 'blob') {
    const urls: string[] = [];
    for (const prefix of [`songs/${id}/`, `charts/${id}/`, `ghosts/${id}/`, `scores/${id}.json`]) {
      const res = await list({ prefix, limit: 500 });
      urls.push(...res.blobs.map((b) => b.url));
    }
    if (urls.length === 0) return false;
    await del(urls);
    return true;
  }
  const meta = await getSong(id);
  if (!meta) return false;
  const ext = meta.ext && isValidExt(meta.ext) ? meta.ext : 'mp3';
  await fs.rm(path.join(LOCAL_DIR, `${id}.${ext}`), { force: true });
  await fs.rm(path.join(LOCAL_DIR, `${id}.json`), { force: true });
  await fs.rm(path.join(LOCAL_DIR, `${id}.jpg`), { force: true });
  await fs.rm(path.join(SCORES_DIR, `${id}.json`), { force: true });
  try {
    for (const f of await fs.readdir(CHARTS_DIR)) {
      if (f.startsWith(`${id}-`)) await fs.rm(path.join(CHARTS_DIR, f), { force: true });
    }
  } catch {
    // no charts dir yet
  }
  try {
    for (const f of await fs.readdir(path.join(GHOSTS_DIR, id))) {
      await fs.rm(path.join(GHOSTS_DIR, id, f), { force: true });
    }
  } catch {
    // no ghosts for this song
  }
  return true;
}

export async function readLocalAudio(
  id: string,
  ext: string
): Promise<Buffer | null> {
  if (!isValidSongId(id) || !isValidExt(ext)) return null;
  try {
    return await fs.readFile(path.join(LOCAL_DIR, `${id}.${ext}`));
  } catch {
    return null;
  }
}
