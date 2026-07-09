import { NextResponse } from 'next/server';
import {
  getCachedChart,
  putCachedChart,
  isValidScoreSongId,
  MAX_CHART_BYTES,
} from '@/lib/storage';

export const dynamic = 'force-dynamic';

function parseKeyParams(url: string): { version: number; difficulty: number } | null {
  const sp = new URL(url).searchParams;
  const version = Math.round(Number(sp.get('v')));
  const difficulty = Math.round(Number(sp.get('d') ?? 1));
  if (!Number.isFinite(version) || version < 1 || version > 1000) return null;
  if (!Number.isFinite(difficulty) || difficulty < 1 || difficulty > 5) return null;
  return { version, difficulty };
}

/** GET /api/charts/:id?v=&d= — fetch a cached chart. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const key = parseKeyParams(request.url);
  if (!key || !isValidScoreSongId(id)) {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }
  try {
    const json = await getCachedChart(id, key.version, key.difficulty);
    if (!json) {
      return NextResponse.json({ error: 'Not cached' }, { status: 404 });
    }
    return new Response(json, {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (err) {
    console.error('chart GET failed', err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

/** POST /api/charts/:id?v=&d= — store a freshly computed chart. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const key = parseKeyParams(request.url);
  if (!key || !isValidScoreSongId(id)) {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }
  try {
    const json = await request.text();
    if (json.length > MAX_CHART_BYTES) {
      return NextResponse.json({ error: 'Chart too large' }, { status: 413 });
    }
    // Sanity-check the payload before persisting.
    const data = JSON.parse(json) as {
      notes?: { t?: number; lane?: number; kind?: string }[];
      bpm?: number;
      duration?: number;
      envelope?: number[];
      envelopeRate?: number;
    };
    if (
      !Array.isArray(data.notes) ||
      data.notes.length === 0 ||
      data.notes.length > 10000 ||
      !Number.isFinite(data.bpm) ||
      !Number.isFinite(data.duration) ||
      !Array.isArray(data.envelope) ||
      !Number.isFinite(data.envelopeRate)
    ) {
      return NextResponse.json({ error: 'Invalid chart' }, { status: 400 });
    }
    for (const n of data.notes) {
      if (
        !Number.isFinite(n.t) ||
        !Number.isFinite(n.lane) ||
        n.lane! < 0 ||
        n.lane! > 2 ||
        (n.kind !== undefined && !['tap', 'double', 'hold', 'bonus'].includes(n.kind))
      ) {
        return NextResponse.json({ error: 'Invalid chart' }, { status: 400 });
      }
    }
    // First writer wins — don't let later posts replace an existing chart.
    const existing = await getCachedChart(id, key.version, key.difficulty);
    if (existing) return NextResponse.json({ ok: true, existed: true });
    await putCachedChart(id, key.version, key.difficulty, json);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('chart POST failed', err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
