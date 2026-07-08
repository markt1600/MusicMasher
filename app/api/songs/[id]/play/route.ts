import { NextResponse } from 'next/server';
import { incrementPlays } from '@/lib/storage';

export const dynamic = 'force-dynamic';

/** POST /api/songs/:id/play — bump the shared play counter. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    await incrementPlays(id);
  } catch (err) {
    console.error('incrementPlays failed', err);
  }
  return NextResponse.json({ ok: true });
}
