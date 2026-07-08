'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { uploadPresigned } from '@vercel/blob/client';
import type { SongMeta } from '@/lib/types';
import { DEMO_SONG } from '@/lib/demo-song';
import { decodeAudio } from '@/lib/aiff';

const MAX_BYTES = 50 * 1024 * 1024;

/** Supported formats → upload content type. Must mirror AUDIO_TYPES on the server. */
const EXT_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
  wav: 'audio/wav',
};

const ACCEPT = '.mp3,.aac,.m4a,.aiff,.aif,.wav,audio/mpeg,audio/aac,audio/mp4,audio/aiff,audio/x-aiff,audio/wav,audio/x-wav';

interface PendingUpload {
  file: File;
  ext: string;
  title: string;
  artist: string;
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function hashHue(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

function newSongId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fileExt(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

const MIME_TO_EXT: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/aac': 'aac',
  'audio/aacp': 'aac',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/aiff': 'aiff',
  'audio/x-aiff': 'aiff',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/vnd.wave': 'wav',
};

/**
 * Work out the audio format from the extension, the browser-reported MIME
 * type, or the file's magic bytes — many real-world files (music apps,
 * downloads, mobile pickers) have missing or misleading names.
 */
async function detectFormat(file: File): Promise<string | null> {
  const ext = fileExt(file.name);
  if (EXT_TYPES[ext]) return ext === 'aif' ? 'aiff' : ext;

  const mime = (file.type || '').toLowerCase().split(';')[0].trim();
  if (MIME_TO_EXT[mime]) return MIME_TO_EXT[mime];

  try {
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    if (head.length < 12) return null;
    const tag = (o: number, n: number) =>
      String.fromCharCode(...head.subarray(o, o + n));
    if (tag(0, 3) === 'ID3') return 'mp3';
    if (tag(0, 4) === 'RIFF' && tag(8, 4) === 'WAVE') return 'wav';
    if (tag(0, 4) === 'FORM' && ['AIFF', 'AIFC'].includes(tag(8, 4))) return 'aiff';
    if (tag(4, 4) === 'ftyp') return 'm4a';
    // ADTS AAC sync (0xFFF0/0xFFF1/0xFFF8/0xFFF9) — check before generic MPEG
    if (head[0] === 0xff && (head[1] & 0xf6) === 0xf0) return 'aac';
    // Bare MPEG audio frame sync (MP3 without an ID3 tag)
    if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'mp3';
  } catch {
    // unreadable — fall through
  }
  return null;
}

function fileStem(name: string): string {
  const dot = name.lastIndexOf('.');
  return (dot > 0 ? name.slice(0, dot) : name).slice(0, 80);
}

async function measureDuration(data: ArrayBuffer): Promise<number> {
  const ctx = new OfflineAudioContext(1, 1, 44100);
  const buf = await decodeAudio(data, ctx);
  return buf.duration;
}

/** Read embedded title/artist tags (ID3, MP4 atoms, RIFF INFO, AIFF chunks). */
async function readTags(
  file: File
): Promise<{ title: string | null; artist: string | null }> {
  try {
    const mm = await import('music-metadata');
    const meta = await mm.parseBlob(file, { duration: false, skipCovers: true });
    return {
      title: meta.common.title?.trim() || null,
      artist: meta.common.artist?.trim() || null,
    };
  } catch {
    return { title: null, artist: null };
  }
}

export default function LibraryPage() {
  const router = useRouter();
  const [songs, setSongs] = useState<SongMeta[] | null>(null);
  const [mode, setMode] = useState<'blob' | 'local'>('local');
  const [uploadsEnabled, setUploadsEnabled] = useState(true);
  const [drag, setDrag] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingUpload | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/songs', { cache: 'no-store' });
      const data = await res.json();
      setSongs(data.songs ?? []);
      if (data.mode) setMode(data.mode);
      setUploadsEnabled(data.uploads !== false);
    } catch {
      setSongs([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const doUpload = useCallback(
    async (file: File, ext: string, title: string, artist: string) => {
      setUploading(true);
      setProgress(null);
      setError(null);
      try {
        setStatus('Checking audio…');
        const arrayBuf = await file.arrayBuffer();
        let duration: number;
        try {
          duration = await measureDuration(arrayBuf.slice(0));
        } catch {
          throw new Error(
            "Your browser couldn't decode this file — try converting it to MP3."
          );
        }
        if (duration < 15) throw new Error('Song must be at least 15 seconds.');
        if (duration > 60 * 20) throw new Error('Song must be under 20 minutes.');

        const id = newSongId();
        setStatus('Uploading…');

        if (mode === 'blob') {
          const blob = await uploadPresigned(`songs/${id}/audio.${ext}`, file, {
            access: 'public',
            handleUploadUrl: '/api/songs/upload',
            contentType: EXT_TYPES[ext],
            onUploadProgress: ({ percentage }) => setProgress(percentage),
          });
          const reg = await fetch('/api/songs/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id,
              title,
              artist,
              ext,
              duration,
              size: file.size,
              audioUrl: blob.url,
            }),
          });
          if (!reg.ok) {
            const body = await reg.json().catch(() => ({}));
            throw new Error(body.error ?? 'Failed to register song.');
          }
        } else {
          const form = new FormData();
          form.set('file', file);
          form.set('id', id);
          form.set('title', title);
          form.set('artist', artist);
          form.set('ext', ext);
          form.set('duration', String(duration));
          await new Promise<void>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/api/songs');
            xhr.upload.onprogress = (e) => {
              if (e.lengthComputable) setProgress((e.loaded / e.total) * 100);
            };
            xhr.onload = () => {
              if (xhr.status >= 200 && xhr.status < 300) resolve();
              else {
                let msg = 'Upload failed.';
                try {
                  msg = JSON.parse(xhr.responseText).error ?? msg;
                } catch {}
                reject(new Error(msg));
              }
            };
            xhr.onerror = () => reject(new Error('Network error during upload.'));
            xhr.send(form);
          });
        }

        setStatus(null);
        setShowUpload(false);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Upload failed.');
        setStatus(null);
      } finally {
        setUploading(false);
        setProgress(null);
      }
    },
    [mode, refresh]
  );

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      if (uploading || pending) return;
      if (!uploadsEnabled) {
        setError(
          'Uploads are disabled: no storage is connected. In Vercel, add a Blob store (Storage → Create Database → Blob), connect it to this project, and redeploy.'
        );
        return;
      }
      const ext = await detectFormat(file);
      if (!ext) {
        const detail = [file.name, file.type].filter(Boolean).join(', ');
        setError(`Unsupported format (${detail}) — use MP3, AAC, AIFF or WAV.`);
        return;
      }
      if (file.size > MAX_BYTES) {
        setError('File is too large — 50 MB max.');
        return;
      }

      setStatus('Reading track info…');
      setUploading(true); // block double-drops while we inspect tags
      const tags = await readTags(file);
      setUploading(false);
      setStatus(null);

      if (tags.title && tags.artist) {
        await doUpload(file, ext, tags.title, tags.artist);
      } else {
        // Missing embedded info — ask the player to fill it in.
        setPending({
          file,
          ext,
          title: tags.title ?? fileStem(file.name),
          artist: tags.artist ?? '',
        });
      }
    },
    [doUpload, pending, uploading, uploadsEnabled]
  );

  const submitPending = useCallback(() => {
    if (!pending) return;
    const title = pending.title.trim() || fileStem(pending.file.name);
    const artist = pending.artist.trim() || 'Unknown Artist';
    const { file, ext } = pending;
    setPending(null);
    void doUpload(file, ext, title, artist);
  }, [doUpload, pending]);

  const playRandom = useCallback(() => {
    const pool = songs ?? [];
    if (pool.length === 0) return;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    router.push(`/play/${pick.id}`);
  }, [router, songs]);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDrag(false);
      const file = e.dataTransfer.files?.[0];
      if (file) void handleFile(file);
    },
    [handleFile]
  );

  return (
    <main className="shell">
      <h1 className="logo">MusicMasher</h1>
      <p className="tagline">
        Pick a song and tap to the beat — tiles fall in sync with the music.
      </p>

      <div className="library-head">
        <div className="section-title">Song library</div>
        {(songs?.length ?? 0) > 0 && (
          <button className="random-btn" onClick={playRandom}>
            🎲 Random
          </button>
        )}
      </div>
      <div className="song-list">
        {songs === null && <div className="empty-note">Loading songs…</div>}
        {songs?.map((s) => (
          <SongCard
            key={s.id}
            title={s.title}
            sub={[
              s.artist,
              formatDuration(s.duration),
              new Date(s.createdAt).toLocaleDateString(),
            ]
              .filter(Boolean)
              .join(' · ')}
            href={`/play/${s.id}`}
            icon="🎧"
          />
        ))}
        {songs?.length === 0 && (
          <>
            <SongCard
              title={DEMO_SONG.title}
              sub={`${formatDuration(DEMO_SONG.duration)} · built-in synthwave`}
              href="/play/demo"
              icon="✨"
            />
            <div className="empty-note">
              No uploads yet — add the first song below!
            </div>
          </>
        )}
      </div>

      {!showUpload && (
        <button className="upload-link" onClick={() => setShowUpload(true)}>
          ＋ Upload a new song
        </button>
      )}

      {showUpload && (
      <div
        className={`dropzone upload-section${drag ? ' drag' : ''}`}
        onClick={() => !uploading && !pending && fileInput.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        role="button"
        aria-label="Upload a song"
      >
        <span className="dz-icon">🎵</span>
        <h2>{uploading ? 'Working on your track…' : 'Drop a song here'}</h2>
        <p>MP3 · AAC · AIFF · WAV — or tap to browse, max 50 MB</p>
        {!uploadsEnabled && (
          <div className="upload-status upload-error">
            Uploads are disabled — no Blob store is connected to this
            deployment. In Vercel: Storage → Create Database → Blob → Connect
            to this project, then redeploy.
          </div>
        )}
        {status && !error && (
          <div className="upload-status">
            {status}
            {progress != null && ` ${Math.round(progress)}%`}
          </div>
        )}
        {uploading && (
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{ width: `${progress ?? 8}%` }}
            />
          </div>
        )}
        {error && <div className="upload-status upload-error">{error}</div>}
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
            e.target.value = '';
          }}
        />
      </div>
      )}

      <div className="keys-hint">
        Mobile: tap the three lanes.
        <br />
        Desktop: <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> or <kbd>J</kbd>{' '}
        <kbd>K</kbd> <kbd>L</kbd> or arrow keys · <kbd>Esc</kbd> to pause
        <br />
        <Link href="/admin">admin</Link>
      </div>

      {pending && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>Track details</h2>
            <p className="modal-sub">
              This file doesn&apos;t have complete track info embedded — fill it
              in so everyone knows what they&apos;re playing.
            </p>
            <label className="field">
              <span>Track name</span>
              <input
                type="text"
                value={pending.title}
                maxLength={80}
                autoFocus
                onChange={(e) =>
                  setPending((p) => (p ? { ...p, title: e.target.value } : p))
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitPending();
                }}
              />
            </label>
            <label className="field">
              <span>Artist</span>
              <input
                type="text"
                value={pending.artist}
                maxLength={80}
                placeholder="Unknown Artist"
                onChange={(e) =>
                  setPending((p) => (p ? { ...p, artist: e.target.value } : p))
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitPending();
                }}
              />
            </label>
            <div className="modal-actions">
              <button className="ghost-btn" onClick={() => setPending(null)}>
                Cancel
              </button>
              <button className="big-btn modal-cta" onClick={submitPending}>
                Upload
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function SongCard({
  title,
  sub,
  href,
  icon,
}: {
  title: string;
  sub: string;
  href: string;
  icon: string;
}) {
  const hue = hashHue(title);
  return (
    <Link href={href} className="song-card">
      <div
        className="song-art"
        style={{
          background: `linear-gradient(140deg, hsl(${hue}, 85%, 55%), hsl(${(hue + 70) % 360}, 85%, 45%))`,
        }}
      >
        {icon}
      </div>
      <div className="song-info">
        <div className="song-title">{title}</div>
        <div className="song-sub">{sub}</div>
      </div>
      <div className="play-btn">▶</div>
    </Link>
  );
}
