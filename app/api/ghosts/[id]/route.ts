import { NextResponse } from 'next/server';
import {
  getGhost,
  putGhost,
  getSongScores,
  isValidScoreSongId,
  sanitizeTitle,
  MAX_GHOST_BYTES,
} from '@/lib/storage';

export const dynamic = 'force-dynamic';

interface GhostDoc {
  name: string;
  score: number;
  events: number[][];
}

/**
 * GET /api/ghosts/:id[?name=] — a stored replay to race. Without ?name it
 * returns the world-record holder's ghost.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isValidScoreSongId(id)) {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }
  try {
    let name = new URL(request.url).searchParams.get('name')?.trim() ?? '';
    if (!name) {
      const scores = await getSongScores(id);
      let bestScore = -1;
      for (const [n, e] of Object.entries(scores.players)) {
        if (e.score > bestScore) {
          bestScore = e.score;
          name = n;
        }
      }
      if (!name) return NextResponse.json({ error: 'No ghost' }, { status: 404 });
    }
    const json = await getGhost(id, name.slice(0, 16));
    if (!json) return NextResponse.json({ error: 'No ghost' }, { status: 404 });
    return new Response(json, {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('ghost GET failed', err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

/** POST /api/ghosts/:id — store the submitting player's replay. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isValidScoreSongId(id)) {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }
  try {
    const raw = await request.text();
    if (raw.length > MAX_GHOST_BYTES) {
      return NextResponse.json({ error: 'Replay too large' }, { status: 413 });
    }
    const body = JSON.parse(raw) as Partial<GhostDoc>;
    const name = sanitizeTitle(String(body.name ?? ''), '').slice(0, 16).trim();
    const events = body.events;
    if (!name || !Array.isArray(events) || events.length === 0 || events.length > 6000) {
      return NextResponse.json({ error: 'Invalid replay' }, { status: 400 });
    }
    let prevT = -Infinity;
    for (const e of events) {
      if (
        !Array.isArray(e) ||
        e.length !== 4 ||
        e.some((x) => !Number.isFinite(x)) ||
        e[0] < prevT ||
        e[1] < 0 ||
        e[1] > 5_000_000
      ) {
        return NextResponse.json({ error: 'Invalid replay' }, { status: 400 });
      }
      prevT = e[0];
    }
    const doc: GhostDoc = {
      name,
      score: Math.round(events[events.length - 1][1]),
      events,
    };
    await putGhost(id, name, JSON.stringify(doc));
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('ghost POST failed', err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
