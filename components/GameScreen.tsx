'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { analyzeAudio } from '@/lib/analyze';
import { decodeAudio } from '@/lib/aiff';
import { DEMO_SONG, getDemoSong } from '@/lib/demo-song';
import { Engine } from '@/lib/game/engine';
import type { Beatmap, GameStats } from '@/lib/types';

type Phase = 'loading' | 'ready' | 'playing' | 'paused' | 'results' | 'error';

const OFFSET_KEY = 'mm-offset-ms';

// The demo chart never changes — analyze it once per page session.
let demoMapCache: Beatmap | null = null;

function grade(stats: GameStats): string {
  if (stats.totalNotes === 0) return 'S';
  const acc =
    (stats.perfect * 100 + stats.great * 60 + stats.good * 30) /
    (stats.totalNotes * 100);
  if (acc >= 0.95) return 'S';
  if (acc >= 0.88) return 'A';
  if (acc >= 0.78) return 'B';
  if (acc >= 0.65) return 'C';
  return 'D';
}

export default function GameScreen({ songId }: { songId: string }) {
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const beatmapRef = useRef<Beatmap | null>(null);
  const engineRef = useRef<Engine | null>(null);

  const [phase, setPhase] = useState<Phase>('loading');
  const [loadingMsg, setLoadingMsg] = useState('Loading song…');
  const [analyzePct, setAnalyzePct] = useState<number | null>(null);
  const [title, setTitle] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [stats, setStats] = useState<GameStats | null>(null);
  const [offsetMs, setOffsetMs] = useState(0);

  // ---------------------------------------------------------------------
  // Load: fetch (or synthesize) audio → decode → analyze beats
  // ---------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    const audioCtx = new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext)();
    audioCtxRef.current = audioCtx;

    const saved = Number(localStorage.getItem(OFFSET_KEY) ?? 0);
    if (Number.isFinite(saved)) setOffsetMs(saved);

    (async () => {
      try {
        let buffer: AudioBuffer;
        let songTitle: string;

        if (songId === 'demo') {
          songTitle = DEMO_SONG.title;
          setTitle(songTitle);
          setLoadingMsg('Synthesizing demo track…');
          setAnalyzePct(0);
          buffer = await getDemoSong(audioCtx, (p) => {
            if (!cancelled) setAnalyzePct(Math.round(p * 100));
          });
          setAnalyzePct(null);
        } else {
          setLoadingMsg('Loading song…');
          const metaRes = await fetch(`/api/songs/${songId}`);
          if (!metaRes.ok) throw new Error('Song not found.');
          const { song } = await metaRes.json();
          songTitle = song.artist
            ? `${song.title} — ${song.artist}`
            : (song.title as string);
          setTitle(songTitle);

          setLoadingMsg('Downloading audio…');
          const audioRes = await fetch(song.audioUrl);
          if (!audioRes.ok) throw new Error('Could not download the audio.');
          const data = await audioRes.arrayBuffer();
          if (cancelled) return;

          setLoadingMsg('Decoding audio…');
          buffer = await decodeAudio(data, audioCtx);
        }
        if (cancelled) return;

        let map: Beatmap;
        if (songId === 'demo' && demoMapCache) {
          map = demoMapCache;
        } else {
          setLoadingMsg('Analyzing beats…');
          setAnalyzePct(0);
          map = await analyzeAudio(buffer, (p) => {
            if (!cancelled) setAnalyzePct(Math.round(p * 100));
          });
        }
        if (cancelled) return;
        if (map.notes.length === 0) {
          throw new Error("Couldn't find a beat in this song.");
        }
        if (songId === 'demo') demoMapCache = map;

        bufferRef.current = buffer;
        beatmapRef.current = map;
        setAnalyzePct(null);
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

  // Auto-pause when the tab is hidden mid-game.
  useEffect(() => {
    const onHide = () => {
      if (document.hidden && engineRef.current && phase === 'playing') {
        engineRef.current.pause();
        setPhase('paused');
      }
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [phase]);

  // ---------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------
  const startGame = useCallback(async () => {
    const canvas = canvasRef.current;
    const audioCtx = audioCtxRef.current;
    const buffer = bufferRef.current;
    const map = beatmapRef.current;
    if (!canvas || !audioCtx || !buffer || !map) return;

    engineRef.current?.destroy();
    await audioCtx.resume(); // requires the user gesture we're inside of

    const engine = new Engine(canvas, audioCtx, buffer, map, title, {
      onEnd: (s) => {
        setStats(s);
        setPhase('results');
        engineRef.current?.destroy();
        engineRef.current = null;
      },
      onPauseRequest: () => setPhase('paused'),
    });
    engine.offsetMs = Number(localStorage.getItem(OFFSET_KEY) ?? 0) || 0;
    engineRef.current = engine;
    engine.start();
    setPhase('playing');
  }, [title]);

  const resumeGame = useCallback(() => {
    engineRef.current?.resume();
    setPhase('playing');
  }, []);

  const changeOffset = useCallback((delta: number) => {
    setOffsetMs((prev) => {
      const next = Math.max(-300, Math.min(300, prev + delta));
      localStorage.setItem(OFFSET_KEY, String(next));
      if (engineRef.current) engineRef.current.offsetMs = next;
      return next;
    });
  }, []);

  const exit = useCallback(() => router.push('/'), [router]);

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------
  const acc =
    stats && stats.totalNotes > 0
      ? ((stats.perfect * 100 + stats.great * 60 + stats.good * 30) /
          (stats.totalNotes * 100)) *
        100
      : 100;

  return (
    <div className="game-root">
      <canvas ref={canvasRef} className="game-canvas" />

      {phase === 'loading' && (
        <div className="overlay">
          <div className="spinner" />
          <h1>{title || 'MusicMasher'}</h1>
          <p className="subtle">
            {loadingMsg}
            {analyzePct != null && (
              <>
                {' '}
                <span className="analyze-pct">{analyzePct}%</span>
              </>
            )}
          </p>
          {analyzePct != null && (
            <div className="load-bar">
              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{ width: `${analyzePct}%` }}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {phase === 'error' && (
        <div className="overlay">
          <h1>😵 Oops</h1>
          <p className="subtle">{errorMsg}</p>
          <button className="ghost-btn" onClick={exit}>
            Back to library
          </button>
        </div>
      )}

      {phase === 'ready' && (
        <div className="overlay">
          <h1>{title}</h1>
          <p className="subtle">
            {beatmapRef.current?.notes.length} tiles ·{' '}
            {Math.round(beatmapRef.current?.bpm ?? 0)} BPM — tap the tiles as
            they hit the line. It gets faster!
          </p>
          <button className="big-btn pulse" onClick={() => void startGame()}>
            ▶ &nbsp;Play
          </button>
          <button className="ghost-btn" onClick={exit}>
            Back
          </button>
        </div>
      )}

      {phase === 'paused' && (
        <div className="overlay">
          <h1>Paused</h1>
          <p className="subtle">{title}</p>
          <button className="big-btn" onClick={resumeGame}>
            ▶ &nbsp;Resume
          </button>
          <button className="ghost-btn" onClick={() => void startGame()}>
            ↻ &nbsp;Restart song
          </button>
          <button className="ghost-btn" onClick={exit}>
            ♫ &nbsp;Choose another song
          </button>
          <div className="offset-row">
            <button onClick={() => changeOffset(-10)}>−</button>
            <span>
              Audio offset: <b>{offsetMs} ms</b>
            </span>
            <button onClick={() => changeOffset(10)}>+</button>
          </div>
          <p className="subtle">
            Hits feel late? Increase the offset. Feel early? Decrease it.
          </p>
        </div>
      )}

      {phase === 'results' && stats && (
        <div className="overlay">
          <div className="grade">{grade(stats)}</div>
          <div className="result-score">{stats.score.toLocaleString()}</div>
          <p className="subtle">
            {title} · accuracy {acc.toFixed(1)}% · best combo {stats.maxCombo}
            {stats.miss === 0 && stats.totalNotes > 0 ? ' · FULL COMBO! 🔥' : ''}
          </p>
          <div className="result-stats">
            <div className="result-stat">
              <b>{stats.perfect}</b>
              <span>Perfect</span>
            </div>
            <div className="result-stat">
              <b>{stats.great}</b>
              <span>Great</span>
            </div>
            <div className="result-stat">
              <b>{stats.good}</b>
              <span>Good</span>
            </div>
            <div className="result-stat">
              <b>{stats.miss}</b>
              <span>Miss</span>
            </div>
          </div>
          <button className="big-btn" onClick={() => void startGame()}>
            ↻ &nbsp;Play again
          </button>
          <button className="ghost-btn" onClick={exit}>
            ♫ &nbsp;Choose another song
          </button>
        </div>
      )}
    </div>
  );
}
