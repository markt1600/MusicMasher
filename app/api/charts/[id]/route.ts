import { NextResponse } from 'next/server';
import {
  getCachedChart,
  putCachedChart,
  deleteCachedChart,
  isValidScoreSongId,
  MAX_CHART_BYTES,
} from '@/lib/storage';
import { checkAdminPassword } from '@/lib/admin';

export const dynamic = 'force-dynamic';

/** The hand-authored chart lives in a reserved cache slot. */
const AUTHORED_V = 0;
const AUTHORED_D = 0;

function parseKeyParams(url: string): { version: number; difficulty: number } | null {
  const sp = new URL(url).searchParams;
  const version = Math.round(Number(sp.get('v')));
  const difficulty = Math.round(Number(sp.get('d') ?? 1));
  if (!Number.isFinite(version) || version < 1 || version > 1000) return null;
  if (!Number.isFinite(difficulty) || difficulty < 1 || difficulty > 5) return null;
  return { version, difficulty };
}

function isAuthoredRequest(url: string): boolean {
  return new URL(url).searchParams.get('authored') === '1';
}

/** Validate chart JSON; returns an error string or null when acceptable. */
function validateChart(json: string): string | null {
  if (json.length > MAX_CHART_BYTES) return 'Chart too large';
  let data: {
    notes?: { t?: number; lane?: number; kind?: string }[];
    bpm?: number;
    duration?: number;
    envelope?: number[];
    envelopeRate?: number;
  };
  try {
    data = JSON.parse(json);
  } catch {
    return 'Invalid JSON';
  }
  if (
    !Array.isArray(data.notes) ||
    data.notes.length === 0 ||
    data.notes.length > 10000 ||
    !Number.isFinite(data.bpm) ||
    !Number.isFinite(data.duration) ||
    !Array.isArray(data.envelope) ||
    !Number.isFinite(data.envelopeRate)
  ) {
    return 'Invalid chart';
  }
  for (const n of data.notes) {
    if (
      !Number.isFinite(n.t) ||
      !Number.isFinite(n.lane) ||
      n.lane! < 0 ||
      n.lane! > 2 ||
      (n.kind !== undefined && !['tap', 'double', 'hold', 'bonus'].includes(n.kind))
    ) {
      return 'Invalid chart';
    }
  }
  return null;
}

/**
 * GET /api/charts/:id?v=&d= — fetch a chart. A hand-authored chart, when one
 * exists, takes priority over the procedural cache for every version and
 * difficulty. ?authored=1 asks for the authored chart specifically.
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
    const authored = await getCachedChart(id, AUTHORED_V, AUTHORED_D);
    if (isAuthoredRequest(request.url)) {
      if (!authored) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      return new Response(authored, {
        headers: { 'Content-Type': 'application/json', 'X-Chart-Authored': '1' },
      });
    }
    if (authored) {
      return new Response(authored, {
        headers: { 'Content-Type': 'application/json', 'X-Chart-Authored': '1' },
      });
    }
    const key = parseKeyParams(request.url);
    if (!key) return NextResponse.json({ error: 'Bad request' }, { status: 400 });
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

/**
 * POST /api/charts/:id — store a chart. With ?authored=1 (admin password
 * required) it saves the hand-authored chart; otherwise it stores a
 * procedural result (first writer wins).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isValidScoreSongId(id)) {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }
  try {
    const json = await request.text();
    const problem = validateChart(json);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });

    if (isAuthoredRequest(request.url)) {
      if (!checkAdminPassword(request.headers.get('x-admin-password'))) {
        return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
      }
      await putCachedChart(id, AUTHORED_V, AUTHORED_D, json);
      return NextResponse.json({ ok: true, authored: true });
    }

    const key = parseKeyParams(request.url);
    if (!key) return NextResponse.json({ error: 'Bad request' }, { status: 400 });
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

/** DELETE /api/charts/:id?authored=1 — remove the authored chart (admin). */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isValidScoreSongId(id) || !isAuthoredRequest(request.url)) {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }
  if (!checkAdminPassword(request.headers.get('x-admin-password'))) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
  }
  try {
    await deleteCachedChart(id, AUTHORED_V, AUTHORED_D);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('chart DELETE failed', err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
