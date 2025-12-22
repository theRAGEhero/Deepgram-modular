import { NextResponse } from 'next/server';
import { getSessionStats } from '@/lib/websocket/handler';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const stats = getSessionStats();
    return NextResponse.json(stats);
  } catch {
    return NextResponse.json({ error: 'Failed to fetch stream stats' }, { status: 500 });
  }
}
