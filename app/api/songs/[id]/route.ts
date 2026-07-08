import { NextResponse } from 'next/server';
import { getSong } from '@/lib/storage';

export const dynamic = 'force-dynamic';

/** GET /api/songs/:id — song metadata. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const song = await getSong(id);
  if (!song) {
    return NextResponse.json({ error: 'Song not found' }, { status: 404 });
  }
  return NextResponse.json({ song });
}
