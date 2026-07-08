'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { upload } from '@vercel/blob/client';
import type { SongMeta } from '@/lib/types';
import { DEMO_SONG } from '@/lib/demo-song';

const MAX_BYTES = 25 * 1024 * 1024;

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

async function measureDuration(data: ArrayBuffer): Promise<number> {
  const ctx = new OfflineAudioContext(1, 1, 44100);
  const buf = await ctx.decodeAudioData(data);
  return buf.duration;
}

export default function LibraryPage() {
  const [songs, setSongs] = useState<SongMeta[] | null>(null);
  const [mode, setMode] = useState<'blob' | 'local'>('local');
  const [drag, setDrag] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/songs', { cache: 'no-store' });
      const data = await res.json();
      setSongs(data.songs ?? []);
      if (data.mode) setMode(data.mode);
    } catch {
      setSongs([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      if (uploading) return;
      const isMp3 =
        file.type === 'audio/mpeg' ||
        file.type === 'audio/mp3' ||
        /\.mp3$/i.test(file.name);
      if (!isMp3) {
        setError('Please drop an MP3 file.');
        return;
      }
      if (file.size > MAX_BYTES) {
        setError('File is too large — 25 MB max.');
        return;
      }

      setUploading(true);
      setProgress(null);
      try {
        setStatus('Checking audio…');
        const arrayBuf = await file.arrayBuffer();
        let duration: number;
        try {
          duration = await measureDuration(arrayBuf.slice(0));
        } catch {
          throw new Error("Couldn't decode this file as audio.");
        }
        if (duration < 15) throw new Error('Song must be at least 15 seconds.');
        if (duration > 60 * 20) throw new Error('Song must be under 20 minutes.');

        const id = newSongId();
        const title = file.name.replace(/\.mp3$/i, '').slice(0, 80);
        setStatus('Uploading…');

        if (mode === 'blob') {
          const blob = await upload(`songs/${id}/audio.mp3`, file, {
            access: 'public',
            handleUploadUrl: '/api/songs/upload',
            contentType: 'audio/mpeg',
            onUploadProgress: ({ percentage }) => setProgress(percentage),
          });
          const reg = await fetch('/api/songs/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id,
              title,
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
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Upload failed.');
        setStatus(null);
      } finally {
        setUploading(false);
        setProgress(null);
      }
    },
    [mode, refresh, uploading]
  );

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
        Drop an MP3 → get a beat-synced tile game. Songs are shared with everyone.
      </p>

      <div
        className={`dropzone${drag ? ' drag' : ''}`}
        onClick={() => !uploading && fileInput.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        role="button"
        aria-label="Upload an MP3"
      >
        <span className="dz-icon">🎵</span>
        <h2>{uploading ? 'Uploading your track…' : 'Drop an MP3 here'}</h2>
        <p>or tap to browse — max 25 MB</p>
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
          accept=".mp3,audio/mpeg"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
            e.target.value = '';
          }}
        />
      </div>

      <div className="section-title">Song library</div>
      <div className="song-list">
        <SongCard
          title={DEMO_SONG.title}
          sub={`${formatDuration(DEMO_SONG.duration)} · built-in synthwave`}
          href="/play/demo"
          icon="✨"
        />
        {songs === null && <div className="empty-note">Loading songs…</div>}
        {songs?.map((s) => (
          <SongCard
            key={s.id}
            title={s.title}
            sub={`${formatDuration(s.duration)} · ${new Date(s.createdAt).toLocaleDateString()}`}
            href={`/play/${s.id}`}
            icon="🎧"
          />
        ))}
        {songs?.length === 0 && (
          <div className="empty-note">
            No uploads yet — be the first to add a song!
          </div>
        )}
      </div>

      <div className="keys-hint">
        Mobile: tap the three lanes.
        <br />
        Desktop: <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> or <kbd>J</kbd>{' '}
        <kbd>K</kbd> <kbd>L</kbd> or arrow keys · <kbd>Esc</kbd> to pause
      </div>
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
