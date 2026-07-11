'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { SongMeta } from '@/lib/types';

const PW_KEY = 'mm-admin-pw';

function formatSize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function AdminPage() {
  const [password, setPassword] = useState('');
  const [authedPw, setAuthedPw] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [songs, setSongs] = useState<SongMeta[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editArtist, setEditArtist] = useState('');

  const loadSongs = useCallback(async () => {
    try {
      const res = await fetch('/api/songs', { cache: 'no-store' });
      const data = await res.json();
      setSongs(data.songs ?? []);
    } catch {
      setSongs([]);
    }
  }, []);

  const verify = useCallback(
    async (pw: string, silent = false) => {
      setError(null);
      try {
        const res = await fetch('/api/admin', {
          method: 'POST',
          headers: { 'x-admin-password': pw },
        });
        if (res.ok) {
          sessionStorage.setItem(PW_KEY, pw);
          setAuthedPw(pw);
          void loadSongs();
        } else if (!silent) {
          setError('Wrong password.');
        }
      } catch {
        if (!silent) setError('Network error — try again.');
      } finally {
        setChecking(false);
      }
    },
    [loadSongs]
  );

  useEffect(() => {
    const saved = sessionStorage.getItem(PW_KEY);
    if (saved) void verify(saved, true);
    else setChecking(false);
  }, [verify]);

  const remove = useCallback(
    async (song: SongMeta) => {
      if (!authedPw) return;
      const label = song.artist ? `${song.title} — ${song.artist}` : song.title;
      if (!window.confirm(`Delete "${label}" for everyone? This can't be undone.`)) {
        return;
      }
      setBusyId(song.id);
      setNotice(null);
      setError(null);
      try {
        const res = await fetch(`/api/songs/${song.id}`, {
          method: 'DELETE',
          headers: { 'x-admin-password': authedPw },
        });
        if (res.status === 401) {
          sessionStorage.removeItem(PW_KEY);
          setAuthedPw(null);
          setError('Session expired — enter the password again.');
          return;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? 'Delete failed.');
        }
        setSongs((prev) => prev?.filter((s) => s.id !== song.id) ?? null);
        setNotice(`Deleted "${label}".`);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Delete failed.');
      } finally {
        setBusyId(null);
      }
    },
    [authedPw]
  );

  const startEdit = useCallback((song: SongMeta) => {
    setEditingId(song.id);
    setEditTitle(song.title);
    setEditArtist(song.artist ?? '');
    setNotice(null);
    setError(null);
  }, []);

  const saveEdit = useCallback(async () => {
    if (!authedPw || !editingId) return;
    if (!editTitle.trim()) {
      setError('Title cannot be empty.');
      return;
    }
    setBusyId(editingId);
    setError(null);
    try {
      const res = await fetch(`/api/songs/${editingId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-password': authedPw,
        },
        body: JSON.stringify({ title: editTitle, artist: editArtist }),
      });
      if (res.status === 401) {
        sessionStorage.removeItem(PW_KEY);
        setAuthedPw(null);
        setError('Session expired — enter the password again.');
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'Update failed.');
      }
      const { song } = await res.json();
      setSongs((prev) =>
        prev?.map((s) => (s.id === song.id ? song : s)) ?? null
      );
      setEditingId(null);
      setNotice(`Updated "${song.title}".`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed.');
    } finally {
      setBusyId(null);
    }
  }, [authedPw, editArtist, editTitle, editingId]);

  const logout = useCallback(() => {
    sessionStorage.removeItem(PW_KEY);
    setAuthedPw(null);
    setPassword('');
    setSongs(null);
  }, []);

  return (
    <main className="shell">
      <h1 className="logo">Admin</h1>
      <p className="tagline">Manage the shared song library.</p>

      {checking ? (
        <div className="empty-note">Checking access…</div>
      ) : !authedPw ? (
        <div className="admin-card">
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              autoFocus
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void verify(password);
              }}
            />
          </label>
          {error && <div className="upload-status upload-error">{error}</div>}
          <div className="modal-actions">
            <Link href="/" className="ghost-btn">
              Back
            </Link>
            <button className="big-btn modal-cta" onClick={() => void verify(password)}>
              Unlock
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="library-head">
            <div className="section-title">
              Uploaded songs{songs ? ` (${songs.length})` : ''}
            </div>
            <button className="ghost-btn admin-logout" onClick={logout}>
              Lock
            </button>
          </div>
          {notice && <div className="upload-status admin-notice">{notice}</div>}
          {error && <div className="upload-status upload-error">{error}</div>}
          <div className="song-list">
            {songs === null && <div className="empty-note">Loading songs…</div>}
            {songs?.map((s) =>
              editingId === s.id ? (
                <div key={s.id} className="song-card admin-row admin-edit">
                  <div className="song-info">
                    <label className="field">
                      <span>Track name</span>
                      <input
                        type="text"
                        value={editTitle}
                        maxLength={80}
                        autoFocus
                        onChange={(e) => setEditTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void saveEdit();
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                      />
                    </label>
                    <label className="field">
                      <span>Artist</span>
                      <input
                        type="text"
                        value={editArtist}
                        maxLength={80}
                        onChange={(e) => setEditArtist(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void saveEdit();
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                      />
                    </label>
                    <div className="admin-edit-actions">
                      <button
                        className="ghost-btn admin-logout"
                        onClick={() => setEditingId(null)}
                      >
                        Cancel
                      </button>
                      <button
                        className="big-btn modal-cta"
                        disabled={busyId === s.id}
                        onClick={() => void saveEdit()}
                      >
                        {busyId === s.id ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div key={s.id} className="song-card admin-row">
                  <div className="song-info">
                    <div className="song-title">{s.title}</div>
                    <div className="song-sub">
                      {[
                        s.artist,
                        formatSize(s.size),
                        (s.ext ?? 'mp3').toUpperCase(),
                        `${s.plays ?? 0} plays`,
                        new Date(s.createdAt).toLocaleDateString(),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  </div>
                  <Link href={`/admin/create/${s.id}`} className="edit-btn">
                    Chart
                  </Link>
                  <button
                    className="edit-btn"
                    disabled={busyId !== null}
                    onClick={() => startEdit(s)}
                  >
                    Edit
                  </button>
                  <button
                    className="danger-btn"
                    disabled={busyId !== null}
                    onClick={() => void remove(s)}
                  >
                    {busyId === s.id ? 'Deleting…' : 'Delete'}
                  </button>
                </div>
              )
            )}
            {songs?.length === 0 && (
              <div className="empty-note">No uploaded songs.</div>
            )}
          </div>
          <div className="keys-hint">
            <Link href="/">← Back to library</Link>
          </div>
        </>
      )}
    </main>
  );
}
