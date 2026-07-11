'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { analyzeAudio } from '@/lib/analyze';
import { serializeChart } from '@/lib/chart-io';
import { decodeAudio } from '@/lib/aiff';
import { Engine } from '@/lib/game/engine';
import type { Beatmap, Note } from '@/lib/types';

type Phase =
  | 'no-auth'
  | 'loading'
  | 'ready'
  | 'recording'
  | 'rec-paused'
  | 'review'
  | 'preview'
  | 'error';

const PW_KEY = 'mm-admin-pw';

/**
 * Snap recorded taps to the nearest 16th-note subdivision of the fitted
 * beat grid; taps landing in the same subdivision + lane collapse to one.
 */
function quantizeTaps(
  taps: { t: number; lane: number }[],
  map: Beatmap
): Note[] {
  const period =
    map.grid && map.grid.confidence >= 1.2 ? map.grid.period : 60 / map.bpm;
  const phase = map.grid?.phase ?? 0;
  const sub = period / 4;
  const seen = new Set<string>();
  const notes: Note[] = [];
  for (const tap of taps) {
    if (tap.t < 0.3 || tap.t > map.duration - 0.2) continue;
    const k = Math.round((tap.t - phase) / sub);
    const t = Math.max(0.3, phase + k * sub);
    const key = `${Math.round(t * 1000)}:${tap.lane}`;
    if (seen.has(key)) continue;
    seen.add(key);
    notes.push({ t: Math.round(t * 1000) / 1000, lane: tap.lane });
  }
  return notes.sort((a, b) => a.t - b.t);
}

export default function ChartStudio({ songId }: { songId: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const mapRef = useRef<Beatmap | null>(null);
  const engineRef = useRef<Engine | null>(null);

  const [phase, setPhase] = useState<Phase>('loading');
  const [loadingMsg, setLoadingMsg] = useState('Loading song…');
  const [pct, setPct] = useState<number | null>(null);
  const [title, setTitle] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [recorded, setRecorded] = useState<Note[]>([]);
  const [hasAuthored, setHasAuthored] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const modeRef = useRef<'record' | 'preview'>('record');

  const pw =
    typeof window !== 'undefined' ? sessionStorage.getItem(PW_KEY) : null;

  useEffect(() => {
    if (!sessionStorage.getItem(PW_KEY)) {
      setPhase('no-auth');
      return;
    }
    let cancelled = false;
    const audioCtx = new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext)();
    audioCtxRef.current = audioCtx;

    (async () => {
      try {
        const metaRes = await fetch(`/api/songs/${songId}`);
        if (!metaRes.ok) throw new Error('Song not found.');
        const { song } = await metaRes.json();
        setTitle(song.artist ? `${song.title} — ${song.artist}` : song.title);

        try {
          const a = await fetch(`/api/charts/${songId}?authored=1`);
          if (!cancelled) setHasAuthored(a.ok);
        } catch {
          // fine — no authored chart
        }

        setLoadingMsg('Downloading audio…');
        const audioRes = await fetch(song.audioUrl);
        if (!audioRes.ok) throw new Error('Could not download the audio.');
        const data = await audioRes.arrayBuffer();
        if (cancelled) return;

        setLoadingMsg('Decoding audio…');
        const buffer = await decodeAudio(data, audioCtx);
        if (cancelled) return;

        // Full analysis for the beat grid (quantization) and envelope.
        setLoadingMsg('Fitting the beat grid…');
        setPct(0);
        const map = await analyzeAudio(buffer, (p) => {
          if (!cancelled) setPct(Math.round(p * 100));
        });
        if (cancelled) return;

        bufferRef.current = buffer;
        mapRef.current = map;
        setPct(null);
        setPhase('ready');
      } catch (err) {
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : 'Failed to load.');
          setPhase('error');
        }
      }
    })();

    return () => {
      cancelled = true;
      engineRef.current?.destroy();
      engineRef.current = null;
      void audioCtx.close();
    };
  }, [songId]);

  const startEngine = useCallback(
    async (mode: 'record' | 'preview', notes?: Note[]) => {
      const canvas = canvasRef.current;
      const audioCtx = audioCtxRef.current;
      const buffer = bufferRef.current;
      const map = mapRef.current;
      if (!canvas || !audioCtx || !buffer || !map) return;
      engineRef.current?.destroy();
      setNotice(null);
      modeRef.current = mode;
      await audioCtx.resume();
      const engineMap: Beatmap =
        mode === 'record' ? { ...map, notes: [] } : { ...map, notes: notes ?? [] };
      const engine = new Engine(
        canvas,
        audioCtx,
        buffer,
        engineMap,
        title,
        {
          onEnd: () => {
            if (mode === 'record') {
              const taps = engineRef.current?.getAuthorTaps() ?? [];
              const m = mapRef.current;
              if (m) setRecorded(quantizeTaps(taps, m));
            }
            engineRef.current?.destroy();
            engineRef.current = null;
            setPhase('review');
          },
          onPauseRequest: () => setPhase('rec-paused'),
        },
        { author: mode === 'record' }
      );
      engine.offsetMs = Number(localStorage.getItem('mm-offset-ms') ?? 0) || 0;
      engineRef.current = engine;
      engine.start();
      setPhase(mode === 'record' ? 'recording' : 'preview');
    },
    [title]
  );

  const finishRecording = useCallback(() => {
    // In preview, "finish" just returns to review without touching the take.
    if (modeRef.current === 'record') {
      const taps = engineRef.current?.getAuthorTaps() ?? [];
      const m = mapRef.current;
      if (m) setRecorded(quantizeTaps(taps, m));
    }
    engineRef.current?.destroy();
    engineRef.current = null;
    setPhase('review');
  }, []);

  const saveChart = useCallback(async () => {
    const map = mapRef.current;
    if (!map || recorded.length === 0 || !pw) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/charts/${songId}?authored=1`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-password': pw,
        },
        body: serializeChart({ ...map, notes: recorded }),
      });
      if (res.status === 401) throw new Error('Wrong admin password — re-open /admin.');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'Save failed.');
      }
      setHasAuthored(true);
      setNotice('✅ Saved! All players now get your chart for this song.');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  }, [pw, recorded, songId]);

  const removeAuthored = useCallback(async () => {
    if (!pw) return;
    if (!window.confirm('Remove the custom chart and return this song to procedural generation?')) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/charts/${songId}?authored=1`, {
        method: 'DELETE',
        headers: { 'x-admin-password': pw },
      });
      if (!res.ok) throw new Error('Remove failed.');
      setHasAuthored(false);
      setNotice('Custom chart removed — back to procedural generation.');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Remove failed.');
    } finally {
      setBusy(false);
    }
  }, [pw, songId]);

  return (
    <div className="game-root">
      <canvas ref={canvasRef} className="game-canvas" />

      {phase === 'no-auth' && (
        <div className="overlay">
          <h1>Chart Studio</h1>
          <p className="subtle">Unlock the admin page first, then come back.</p>
          <Link href="/admin" className="big-btn">
            Go to admin
          </Link>
        </div>
      )}

      {phase === 'loading' && (
        <div className="overlay">
          <div className="spinner" />
          <h1>{title || 'Chart Studio'}</h1>
          <p className="subtle">
            {loadingMsg}
            {pct != null && (
              <>
                {' '}
                <span className="analyze-pct">{pct}%</span>
              </>
            )}
          </p>
        </div>
      )}

      {phase === 'error' && (
        <div className="overlay">
          <h1>😵 Oops</h1>
          <p className="subtle">{errorMsg}</p>
          <Link href="/admin" className="ghost-btn">
            Back to admin
          </Link>
        </div>
      )}

      {phase === 'ready' && (
        <div className="overlay">
          <h1>🎼 Chart Studio</h1>
          <p className="subtle">
            <b>{title}</b>
            <br />
            The song will play — tap the lanes (or <b>A S D</b>) where tiles
            should fall. Slightly-off taps snap to the beat automatically.
            {hasAuthored && (
              <>
                <br />
                <br />
                ⚠️ This song already has a custom chart — saving will replace it.
              </>
            )}
          </p>
          <button className="big-btn pulse" onClick={() => void startEngine('record')}>
            ● &nbsp;Start recording
          </button>
          {hasAuthored && (
            <button className="ghost-btn" disabled={busy} onClick={() => void removeAuthored()}>
              🗑 Remove custom chart
            </button>
          )}
          <Link href="/admin" className="ghost-btn">
            Back to admin
          </Link>
          {notice && <p className="subtle">{notice}</p>}
        </div>
      )}

      {phase === 'rec-paused' && (
        <div className="overlay">
          <h1>Recording paused</h1>
          <button
            className="big-btn"
            onClick={() => {
              engineRef.current?.resume();
              setPhase('recording');
            }}
          >
            ▶ &nbsp;Resume
          </button>
          <button className="ghost-btn" onClick={finishRecording}>
            ✔ &nbsp;Finish &amp; review
          </button>
          <button className="ghost-btn" onClick={() => void startEngine('record')}>
            ↻ &nbsp;Start over
          </button>
          <Link href="/admin" className="ghost-btn">
            Exit
          </Link>
        </div>
      )}

      {phase === 'review' && (
        <div className="overlay">
          <h1>🎼 {recorded.length} tiles</h1>
          <p className="subtle">
            {title}
            <br />
            Taps were quantized to the beat grid. Preview it, save it as the
            song&apos;s chart, or record again.
          </p>
          {notice && <p className="subtle">{notice}</p>}
          <button
            className="big-btn"
            disabled={recorded.length === 0 || busy}
            onClick={() => void startEngine('preview', recorded)}
          >
            ▶ &nbsp;Preview
          </button>
          <button
            className="big-btn"
            disabled={recorded.length === 0 || busy}
            onClick={() => void saveChart()}
          >
            {busy ? 'Saving…' : '💾 Save as song chart'}
          </button>
          <button className="ghost-btn" onClick={() => void startEngine('record')}>
            ● &nbsp;Re-record
          </button>
          {hasAuthored && (
            <button className="ghost-btn" disabled={busy} onClick={() => void removeAuthored()}>
              🗑 Remove custom chart
            </button>
          )}
          <Link href="/admin" className="ghost-btn">
            Back to admin
          </Link>
        </div>
      )}
    </div>
  );
}
