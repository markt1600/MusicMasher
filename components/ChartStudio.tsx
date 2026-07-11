'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { analyzeAudio } from '@/lib/analyze';
import { serializeChart, deserializeChart } from '@/lib/chart-io';
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

type AuthorTap = { t: number; lane: number; dur?: number; kind?: 'bonus' };

/** Two quick presses on the same pad within this gap read as one
 * double-tap tile rather than two separate tiles. */
const DOUBLE_GAP = 0.24;

/**
 * Snap recorded presses to the nearest 16th-note subdivision of the fitted
 * beat grid; presses landing in the same subdivision + lane collapse to
 * one. Long presses become hold tiles with beat-multiple durations, rapid
 * same-lane double-taps become double tiles, and gem-button presses become
 * bonus gems.
 */
function quantizeTaps(taps: AuthorTap[], map: Beatmap): Note[] {
  const period =
    map.grid && map.grid.confidence >= 1.2 ? map.grid.period : 60 / map.bpm;
  const phase = map.grid?.phase ?? 0;
  const sub = period / 4;

  // Merge rapid same-lane tap pairs into double tiles first (holds and gems
  // never merge). Taps arrive in release order, so sort by time.
  const merged: (AuthorTap & { double?: boolean })[] = [];
  for (const tap of [...taps].sort((a, b) => a.t - b.t)) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      !prev.double &&
      prev.lane === tap.lane &&
      prev.dur === undefined &&
      tap.dur === undefined &&
      prev.kind === undefined &&
      tap.kind === undefined &&
      tap.t - prev.t <= DOUBLE_GAP
    ) {
      prev.double = true;
      continue;
    }
    merged.push({ ...tap });
  }

  const seen = new Set<string>();
  const notes: Note[] = [];
  for (const tap of merged) {
    if (tap.t < 0.3 || tap.t > map.duration - 0.2) continue;
    const k = Math.round((tap.t - phase) / sub);
    const t = Math.max(0.3, phase + k * sub);
    const key = `${Math.round(t * 1000)}:${tap.lane}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tq = Math.round(t * 1000) / 1000;
    if (tap.kind === 'bonus') {
      notes.push({ t: tq, lane: tap.lane, kind: 'bonus' });
      continue;
    }
    if (tap.dur !== undefined) {
      const dur = Math.min(
        Math.max(sub * 2, Math.round(tap.dur / sub) * sub),
        map.duration - 0.3 - t
      );
      if (dur >= 0.35) {
        notes.push({ t: tq, lane: tap.lane, kind: 'hold', dur: Math.round(dur * 1000) / 1000 });
        continue;
      }
    }
    if (tap.double) {
      notes.push({ t: tq, lane: tap.lane, kind: 'double' });
      continue;
    }
    notes.push({ t: tq, lane: tap.lane });
  }
  return notes.sort((a, b) => a.t - b.t);
}

function fmtTime(x: number): string {
  return `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
}

/** Audio pre-roll before a punch-in point, so you hear the run-up. */
const PUNCH_PREROLL = 3;

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
  const [fromT, setFromT] = useState(0);
  const [duration, setDuration] = useState(0);
  const modeRef = useRef<'record' | 'preview'>('record');
  const punchFromRef = useRef(0);

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
          if (a.ok && !cancelled) {
            setHasAuthored(true);
            const existing = deserializeChart(await a.json());
            if (existing) setRecorded(existing.notes);
          }
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
        setDuration(map.duration);
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
    async (mode: 'record' | 'preview', notes?: Note[], punchFrom = 0) => {
      const canvas = canvasRef.current;
      const audioCtx = audioCtxRef.current;
      const buffer = bufferRef.current;
      const map = mapRef.current;
      if (!canvas || !audioCtx || !buffer || !map) return;
      engineRef.current?.destroy();
      setNotice(null);
      modeRef.current = mode;
      punchFromRef.current = punchFrom;
      await audioCtx.resume();
      const engineMap: Beatmap =
        mode === 'record' ? { ...map, notes: [] } : { ...map, notes: notes ?? [] };
      const finishTake = () => {
        const eng = engineRef.current;
        const taps = eng?.getAuthorTaps() ?? [];
        const takeover = eng?.getTakeoverT() ?? null;
        const m = mapRef.current;
        if (!m) return;
        const fresh = quantizeTaps(taps, m);
        setRecorded((prev) => {
          if (punchFromRef.current > 0) {
            // Punch-in: nothing changes until the first tap; from there the
            // new take replaces the old one.
            if (takeover === null) return prev;
            const from = fresh.length > 0 ? Math.min(takeover, fresh[0].t) : takeover;
            return [...prev.filter((n) => n.t < from - 0.001), ...fresh].sort(
              (a, b) => a.t - b.t
            );
          }
          return fresh; // full re-record replaces everything
        });
      };
      const engine = new Engine(
        canvas,
        audioCtx,
        buffer,
        engineMap,
        title,
        {
          onEnd: () => {
            if (mode === 'record') finishTake();
            engineRef.current?.destroy();
            engineRef.current = null;
            setPhase('review');
          },
          onPauseRequest: () => setPhase('rec-paused'),
        },
        {
          author: mode === 'record',
          startAt: mode === 'record' ? Math.max(0, punchFrom - PUNCH_PREROLL) : 0,
          armAt: mode === 'record' ? punchFrom : 0,
          referenceNotes:
            mode === 'record' && punchFrom > 0 ? recorded : undefined,
        }
      );
      engine.offsetMs = Number(localStorage.getItem('mm-offset-ms') ?? 0) || 0;
      engineRef.current = engine;
      engine.start();
      setPhase(mode === 'record' ? 'recording' : 'preview');
    },
    [recorded, title]
  );

  const finishRecording = useCallback(() => {
    // In preview, "finish" just returns to review without touching the take.
    if (modeRef.current === 'record') {
      const eng = engineRef.current;
      const taps = eng?.getAuthorTaps() ?? [];
      const takeover = eng?.getTakeoverT() ?? null;
      const m = mapRef.current;
      if (m) {
        const fresh = quantizeTaps(taps, m);
        setRecorded((prev) => {
          if (punchFromRef.current > 0) {
            if (takeover === null) return prev;
            const from = fresh.length > 0 ? Math.min(takeover, fresh[0].t) : takeover;
            return [...prev.filter((n) => n.t < from - 0.001), ...fresh].sort(
              (a, b) => a.t - b.t
            );
          }
          return fresh;
        });
      }
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
            should fall. <b>Long-press</b> to place hold tiles,{' '}
            <b>double-tap quickly</b> for a double tile, and hit the floating
            gem buttons above the pads (or <b>Q W E</b>) to place bonus gems.
            Slightly-off taps snap to the beat automatically.
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
          {recorded.length > 0 && (
            <button className="ghost-btn" onClick={() => setPhase('review')}>
              ✏️ &nbsp;Review saved chart ({recorded.length} tiles)
            </button>
          )}
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
          <div className="scrub-row">
            <input
              type="range"
              min={0}
              max={Math.max(1, Math.ceil(duration - 1))}
              step={1}
              value={Math.min(fromT, Math.max(0, duration - 1))}
              onChange={(e) => setFromT(Number(e.target.value))}
            />
            <button
              className="ghost-btn scrub-btn"
              disabled={busy}
              onClick={() => void startEngine('record', undefined, fromT)}
            >
              ⏺ &nbsp;Re-record from {fmtTime(fromT)}
            </button>
          </div>
          {fromT > 0 && (
            <p className="subtle scrub-hint">
              Old tiles play translucently from {fmtTime(fromT)} so you can
              cue in — nothing changes until your first tap, which takes
              over from there. ({PUNCH_PREROLL}s run-up first.)
            </p>
          )}
          <button className="ghost-btn" onClick={() => void startEngine('record')}>
            ● &nbsp;Re-record all
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
