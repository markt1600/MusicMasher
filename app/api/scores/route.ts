import { NextResponse } from 'next/server';
import {
  getAllScores,
  submitGlobalScore,
  isValidScoreSongId,
  sanitizeTitle,
  type ScoreEntry,
} from '@/lib/storage';

export const dynamic = 'force-dynamic';

const GRADES = ['S', 'A', 'B', 'C', 'D'];
const MAX_NAME = 16;

export interface ScoreboardSummary {
  /** Per song: the world-record holder. */
  songs: Record<string, { name: string; score: number }>;
  /** Cumulative leaderboard: each player's bests summed across songs. */
  leaderboard: { name: string; total: number; songs: number }[];
}

/** GET /api/scores — world records per song + cumulative leaderboard. */
export async function GET() {
  try {
    const all = await getAllScores();
    const songs: ScoreboardSummary['songs'] = {};
    const totals = new Map<string, { total: number; songs: number }>();

    for (const [songId, board] of Object.entries(all)) {
      let top: { name: string; score: number } | null = null;
      for (const [name, entry] of Object.entries(board.players)) {
        if (!top || entry.score > top.score) top = { name, score: entry.score };
        const t = totals.get(name) ?? { total: 0, songs: 0 };
        t.total += entry.score;
        t.songs += 1;
        totals.set(name, t);
      }
      if (top) songs[songId] = top;
    }

    const leaderboard = [...totals.entries()]
      .map(([name, t]) => ({ name, total: t.total, songs: t.songs }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);

    return NextResponse.json({ songs, leaderboard } satisfies ScoreboardSummary);
  } catch (err) {
    console.error('scores GET failed', err);
    return NextResponse.json({ error: 'Failed to load scores' }, { status: 500 });
  }
}

/** POST /api/scores — submit a result; stored if it beats the player's best. */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      songId?: string;
      name?: string;
      score?: number;
      acc?: number;
      maxCombo?: number;
      grade?: string;
    };
    const songId = String(body.songId ?? '');
    const name = sanitizeTitle(String(body.name ?? ''), '').slice(0, MAX_NAME).trim();
    const score = Math.round(Number(body.score ?? -1));
    const acc = Number(body.acc ?? -1);
    const maxCombo = Math.round(Number(body.maxCombo ?? -1));
    const grade = String(body.grade ?? '');

    if (!isValidScoreSongId(songId)) {
      return NextResponse.json({ error: 'Invalid song' }, { status: 400 });
    }
    if (!name) {
      return NextResponse.json({ error: 'Enter a player name' }, { status: 400 });
    }
    if (!Number.isFinite(score) || score < 0 || score > 5_000_000) {
      return NextResponse.json({ error: 'Invalid score' }, { status: 400 });
    }
    if (!Number.isFinite(acc) || acc < 0 || acc > 100) {
      return NextResponse.json({ error: 'Invalid accuracy' }, { status: 400 });
    }
    if (!Number.isFinite(maxCombo) || maxCombo < 0 || maxCombo > 100_000) {
      return NextResponse.json({ error: 'Invalid combo' }, { status: 400 });
    }
    if (!GRADES.includes(grade)) {
      return NextResponse.json({ error: 'Invalid grade' }, { status: 400 });
    }

    const entry: ScoreEntry = {
      score,
      acc: Math.round(acc * 10) / 10,
      maxCombo,
      grade,
      updatedAt: new Date().toISOString(),
    };
    const { updated, scores } = await submitGlobalScore(songId, name, entry);

    let best: { name: string; score: number } | null = null;
    for (const [n, e] of Object.entries(scores.players)) {
      if (!best || e.score > best.score) best = { name: n, score: e.score };
    }
    const isRecord = updated && best !== null && best.name === name && best.score === score;
    return NextResponse.json({ updated, best, isRecord });
  } catch (err) {
    console.error('scores POST failed', err);
    return NextResponse.json({ error: 'Failed to submit score' }, { status: 500 });
  }
}
