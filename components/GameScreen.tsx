'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { analyzeAudio, CHART_VERSION } from '@/lib/analyze';
import { serializeChart, deserializeChart } from '@/lib/chart-io';
import { decodeAudio } from '@/lib/aiff';
import { DEMO_SONG, getDemoSong } from '@/lib/demo-song';
import { Engine } from '@/lib/game/engine';
import {
  getBest,
  submitScore,
  getPlayerName,
  setPlayerName,
  type BestEntry,
} from '@/lib/scores';
import type { Beatmap, GameStats } from '@/lib/types';

type Phase = 'loading' | 'ready' | 'playing' | 'paused' | 'results' | 'error';

const OFFSET_KEY = 'mm-offset-ms';
const RUN_TOTAL_KEY = 'mm-run-total';
const RUN_CLEAR_ACC = 60; // % accuracy needed to advance a gauntlet stage

// The demo chart never changes — analyze it once per page session.
let demoMapCache: Beatmap | null = null;

/** Stable background theme per song outside gauntlet runs. */
function themeForSong(songId: string): number {
  let h = 0;
  for (let i = 0; i < songId.length; i++) h = (h * 31 + songId.charCodeAt(i)) | 0;
  return Math.abs(h) % 5;
}

async function pickRandomSongId(excludeId?: string): Promise<string> {
  try {
    const res = await fetch('/api/songs', { cache: 'no-store' });
    const data = await res.json();
    const all: { id: string }[] = data.songs ?? [];
    const pool = all.filter((s) => s.id !== excludeId);
    if (pool.length > 0) return pool[Math.floor(Math.random() * pool.length)].id;
    if (all.length > 0) return all[0].id;
  } catch {
    // fall through
  }
  return 'demo';
}

function accuracy(stats: GameStats): number {
  if (stats.totalNotes === 0) return 100;
  return (
    ((stats.perfect * 100 + stats.great * 60 + stats.good * 30) /
      (stats.totalNotes * 100)) *
    100
  );
}

function grade(stats: GameStats): string {
  const acc = accuracy(stats);
  if (acc >= 95) return 'S';
  if (acc >= 88) return 'A';
  if (acc >= 78) return 'B';
  if (acc >= 65) return 'C';
  return 'D';
}

export default function GameScreen({
  songId,
  runStage = 0,
  vsName,
}: {
  songId: string;
  /** 0 = normal play; 1..5 = gauntlet stage. */
  runStage?: number;
  /** Race a specific player's ghost (from a challenge link). */
  vsName?: string;
}) {
  const router = useRouter();
  const inRun = runStage > 0;
  const difficulty = inRun ? runStage : 1;
  const theme = inRun ? (runStage - 1) % 5 : themeForSong(songId);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const beatmapRef = useRef<Beatmap | null>(null);
  const engineRef = useRef<Engine | null>(null);

  const [phase, setPhase] = useState<Phase>('loading');
  const [loadingMsg, setLoadingMsg] = useState('Loading song…');
  const [analyzePct, setAnalyzePct] = useState<number | null>(null);
  const [title, setTitle] = useState('');
  const [artUrl, setArtUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [stats, setStats] = useState<GameStats | null>(null);
  const [offsetMs, setOffsetMs] = useState(0);
  const [bestResult, setBestResult] = useState<{
    newBest: boolean;
    prev: BestEntry | null;
  } | null>(null);
  const playCounted = useRef(false);

  // shared scoreboard state
  const [player, setPlayer] = useState('');
  const [nameDraft, setNameDraft] = useState('');
  const [globalBest, setGlobalBest] = useState<{ name: string; score: number } | null>(null);
  const [isRecord, setIsRecord] = useState(false);
  const scorePosted = useRef(false);
  const [runTotal, setRunTotal] = useState(0);
  const [advancing, setAdvancing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [ghost, setGhost] = useState<{ name: string; score: number; events: number[][] } | null>(null);
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const replayRef = useRef<number[][] | null>(null);

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
    setPlayer(getPlayerName());

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
          if (song.artUrl) setArtUrl(song.artUrl);

          setLoadingMsg('Downloading audio…');
          const audioRes = await fetch(song.audioUrl);
          if (!audioRes.ok) throw new Error('Could not download the audio.');
          const data = await audioRes.arrayBuffer();
          if (cancelled) return;

          setLoadingMsg('Decoding audio…');
          buffer = await decodeAudio(data, audioCtx);
        }
        if (cancelled) return;

        // Someone to race: a specific challenger's ghost, or the record holder's.
        if (difficulty === 1 && !cancelled) {
          try {
            const q = vsName ? `?name=${encodeURIComponent(vsName)}` : '';
            const gr = await fetch(`/api/ghosts/${songId}${q}`);
            if (gr.ok) {
              const gd = await gr.json();
              if (Array.isArray(gd.events) && gd.events.length > 0 && !cancelled) {
                setGhost({ name: gd.name, score: gd.score, events: gd.events });
              }
            }
          } catch {
            // no ghost — race yourself
          }
        }

        let map: Beatmap | null = null;
        if (songId === 'demo' && difficulty === 1 && demoMapCache) {
          map = demoMapCache;
        }
        // Charts are deterministic — reuse the shared server-side cache.
        if (!map && songId !== 'demo') {
          try {
            const r = await fetch(
              `/api/charts/${songId}?v=${CHART_VERSION}&d=${difficulty}`
            );
            if (r.ok) {
              map = deserializeChart(await r.json());
              if (map) console.log('[MusicMasher] chart loaded from shared cache');
            }
          } catch {
            // cache miss/offline — analyze locally
          }
        }
        if (cancelled) return;
        if (!map) {
          setLoadingMsg('Analyzing beats…');
          setAnalyzePct(0);
          map = await analyzeAudio(
            buffer,
            (p) => {
              if (!cancelled) setAnalyzePct(Math.round(p * 100));
            },
            difficulty
          );
          if (!cancelled && songId !== 'demo' && map.notes.length > 0) {
            // Share the result so the next player skips analysis.
            void fetch(`/api/charts/${songId}?v=${CHART_VERSION}&d=${difficulty}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: serializeChart(map),
            }).catch(() => {});
          }
        }
        if (cancelled) return;
        if (map.notes.length === 0) {
          throw new Error("Couldn't find a beat in this song.");
        }
        if (songId === 'demo' && difficulty === 1) demoMapCache = map;
        console.log(
          '[MusicMasher] chart:',
          `${map.notes.length} notes,`,
          `${map.notes.filter((n) => n.kind === 'double').length} doubles,`,
          `${map.notes.filter((n) => n.kind === 'hold').length} holds,`,
          `${map.notes.filter((n) => n.kind === 'bonus').length} gems,`,
          `${Math.round(map.bpm)} bpm`
        );
        // Debug/testing hook: the resolved chart for the current song.
        (window as unknown as Record<string, unknown>).__mmChart = map.notes;

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
  }, [songId, difficulty, vsName]);

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
    scorePosted.current = false;
    setGlobalBest(null);
    setIsRecord(false);
    setFailed(false);
    setBestResult(null);
    setShareMsg(null);
    replayRef.current = null;

    // On touch devices, go fullscreen for the game (iOS Safari doesn't
    // support the Fullscreen API — it simply no-ops there).
    if (
      window.matchMedia('(pointer: coarse)').matches &&
      !document.fullscreenElement &&
      document.documentElement.requestFullscreen
    ) {
      try {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      } catch {
        // user/browser refused — play windowed
      }
    }

    await audioCtx.resume(); // requires the user gesture we're inside of

    const engine = new Engine(
      canvas,
      audioCtx,
      buffer,
      map,
      title,
      {
        onEnd: (s, didFail) => {
          replayRef.current = engineRef.current?.getReplay() ?? null;
          setStats(s);
          setFailed(didFail);
          // Personal/global bests only count for completed songs on normal
          // difficulty — gauntlet charts are denser/faster, and a failed run
          // is an incomplete song.
          if (difficulty === 1 && !didFail) {
            setBestResult(
              submitScore(songId, {
                score: s.score,
                acc: accuracy(s),
                maxCombo: s.maxCombo,
                grade: grade(s),
              })
            );
          }
          if (inRun) {
            const prev = Number(sessionStorage.getItem(RUN_TOTAL_KEY) ?? 0) || 0;
            const total = prev + s.score;
            sessionStorage.setItem(RUN_TOTAL_KEY, String(total));
            setRunTotal(total);
          }
          setPhase('results');
          engineRef.current?.destroy();
          engineRef.current = null;
        },
        onPauseRequest: () => setPhase('paused'),
      },
      {
        theme,
        difficulty,
        stageLabel: inRun ? `STAGE ${runStage}/5` : '',
        ghost: !inRun && ghost ? { name: ghost.name, events: ghost.events } : undefined,
      }
    );
    engine.offsetMs = Number(localStorage.getItem(OFFSET_KEY) ?? 0) || 0;
    engineRef.current = engine;
    engine.start();
    setPhase('playing');

    // Count one play per visit (restarts don't inflate the counter).
    if (!playCounted.current && songId !== 'demo') {
      playCounted.current = true;
      void fetch(`/api/songs/${songId}/play`, { method: 'POST' }).catch(() => {});
    }
  }, [difficulty, ghost, inRun, runStage, songId, theme, title]);

  const nextStage = useCallback(async () => {
    setAdvancing(true);
    const next = await pickRandomSongId(songId);
    router.push(`/play/${next}?run=1&stage=${runStage + 1}`);
  }, [router, runStage, songId]);

  const startGauntlet = useCallback(async () => {
    setAdvancing(true);
    sessionStorage.setItem(RUN_TOTAL_KEY, '0');
    const first = await pickRandomSongId();
    router.push(`/play/${first}?run=1&stage=1`);
  }, [router]);

  const postScore = useCallback(
    async (name: string, s: GameStats) => {
      if (scorePosted.current) return;
      scorePosted.current = true;
      try {
        const res = await fetch('/api/scores', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            songId,
            name,
            score: s.score,
            acc: accuracy(s),
            maxCombo: s.maxCombo,
            grade: grade(s),
          }),
        });
        if (res.ok) {
          const data = await res.json();
          setGlobalBest(data.best ?? null);
          setIsRecord(Boolean(data.isRecord));
          if (data.updated && replayRef.current && replayRef.current.length > 0) {
            void fetch(`/api/ghosts/${songId}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name, events: replayRef.current }),
            }).catch(() => {});
          }
        }
      } catch {
        // offline — the local best is still recorded
      }
    },
    [songId]
  );

  // Auto-post once the results screen shows, when we already know the player.
  // Gauntlet stages past 1 use harder charts, so they don't post.
  useEffect(() => {
    if (
      phase === 'results' &&
      stats &&
      player &&
      difficulty === 1 &&
      !failed &&
      !scorePosted.current
    ) {
      void postScore(player, stats);
    }
  }, [difficulty, failed, phase, player, postScore, stats]);

  const savePlayerName = useCallback(() => {
    const name = nameDraft.trim().slice(0, 16);
    if (!name || !stats) return;
    setPlayerName(name);
    setPlayer(name);
    void postScore(name, stats);
  }, [nameDraft, postScore, stats]);

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

  const exit = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    }
    router.push('/');
  }, [router]);

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------
  const acc = stats ? accuracy(stats) : 100;
  const cleared = stats ? !failed && acc >= RUN_CLEAR_ACC : false;

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
          {artUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={artUrl} alt="" className="ready-art" />
          )}
          <h1>{title}</h1>
          {ghost && !inRun && (
            <p className="subtle ghost-line">
              👻 Racing <b>{ghost.name}</b> — {ghost.score.toLocaleString()}
            </p>
          )}
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
            {engineRef.current !== null &&
              engineRef.current.autoLatencyMs > 0 && (
                <>
                  <br />
                  Auto latency compensation: {engineRef.current.autoLatencyMs} ms
                </>
              )}
          </p>
        </div>
      )}

      {phase === 'results' && stats && (
        <div className="overlay">
          {inRun && cleared && runStage === 5 && (
            <div className="new-best win-title">🏆 YOU BEAT THE GAUNTLET!</div>
          )}
          {inRun && cleared && runStage < 5 && (
            <div className="new-best stage-clear">
              ✅ STAGE {runStage} CLEAR!
            </div>
          )}
          {inRun && !cleared && (
            <div className="new-best run-over">
              {failed ? '💀 GAME OVER' : '💔 RUN OVER'} — STAGE {runStage}/5
            </div>
          )}
          {!inRun && failed && (
            <div className="new-best run-over">💀 GAME OVER</div>
          )}
          {!inRun &&
            !failed &&
            (isRecord ? (
              <div className="new-best world-record">🌍 WORLD RECORD!</div>
            ) : (
              bestResult?.newBest && <div className="new-best">🏆 NEW BEST!</div>
            ))}
          <div className="grade">{failed ? 'F' : grade(stats)}</div>
          <div className="result-score">{stats.score.toLocaleString()}</div>
          {inRun && (
            <p className="subtle best-line run-line">
              ⚔️ Run total: <b>{runTotal.toLocaleString()}</b>
            </p>
          )}
          {!inRun && !bestResult?.newBest && (
            <p className="subtle best-line">
              Your best: {(bestResult?.prev ?? getBest(songId))?.score.toLocaleString() ?? '—'}
            </p>
          )}
          {globalBest && !isRecord && (
            <p className="subtle best-line">
              🌍 World best: {globalBest.score.toLocaleString()} by {globalBest.name}
            </p>
          )}
          {failed && (
            <p className="subtle">
              Too many misses — stay under 70% missed over any 10 seconds!
            </p>
          )}
          {!player && difficulty === 1 && !failed && (
            <div className="name-form">
              <input
                type="text"
                placeholder="Player name"
                maxLength={16}
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') savePlayerName();
                }}
              />
              <button className="ghost-btn" onClick={savePlayerName}>
                Post score
              </button>
            </div>
          )}
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
          {inRun && cleared && runStage < 5 ? (
            <>
              <button
                className="big-btn"
                disabled={advancing}
                onClick={() => void nextStage()}
              >
                {advancing ? 'Loading…' : `▶  Stage ${runStage + 1}`}
              </button>
              <button className="ghost-btn" onClick={exit}>
                End run
              </button>
            </>
          ) : inRun ? (
            <>
              <button
                className="big-btn"
                disabled={advancing}
                onClick={() => void startGauntlet()}
              >
                {advancing ? 'Loading…' : '⚔️  New gauntlet'}
              </button>
              <button className="ghost-btn" onClick={exit}>
                ♫ &nbsp;Back to library
              </button>
            </>
          ) : (
            <>
              <button className="big-btn" onClick={() => void startGame()}>
                ↻ &nbsp;Play again
              </button>
              {player && !failed && (
                <button
                  className="ghost-btn"
                  onClick={() => {
                    const url = `${window.location.origin}/play/${songId}?vs=${encodeURIComponent(player)}`;
                    if (navigator.share) {
                      void navigator
                        .share({ title: 'Beat my MusicMasher score!', url })
                        .catch(() => {});
                    } else {
                      void navigator.clipboard
                        .writeText(url)
                        .then(() => setShareMsg('Challenge link copied!'))
                        .catch(() => setShareMsg(url));
                    }
                  }}
                >
                  📣 &nbsp;Challenge friends
                </button>
              )}
              {shareMsg && <p className="subtle">{shareMsg}</p>}
              <button className="ghost-btn" onClick={exit}>
                ♫ &nbsp;Choose another song
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
