/**
 * Round-specific Live Transcription API Route
 * Accepts Deepgram live transcription payload and writes deliberation JSON.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createDeliberationOntology } from '@/lib/deliberation/ontology';
import { saveTranscription, audioFileExists } from '@/lib/storage/files';
import { getRound, updateRound } from '@/lib/storage/rounds';
import { RoundStatus } from '@/types/round';
import { getLogger, createRequestId } from '@/lib/logging/logger';
import path from 'path';

const logger = getLogger('api.rounds.transcribe-live');

export const runtime = 'nodejs';

interface RouteContext {
  params: {
    roundId: string;
  };
}

export async function POST(request: NextRequest, context: RouteContext) {
  const requestId = createRequestId();
  const log = logger.withContext({ requestId });
  const { roundId } = context.params;

  try {
    const body = await request.json();
    const { response, audioPath, language } = body || {};

    if (!response || !response.results) {
      return NextResponse.json(
        { error: 'Invalid live transcription payload' },
        { status: 400 }
      );
    }

    const round = await getRound(roundId);
    if (!round) {
      return NextResponse.json({ error: 'Round not found' }, { status: 404 });
    }

    const resolvedAudioPath = audioPath || await audioFileExists(roundId);
    if (!resolvedAudioPath) {
      return NextResponse.json({ error: 'Audio file not found' }, { status: 404 });
    }

    const filename = path.basename(resolvedAudioPath);
    const deliberationData = createDeliberationOntology(
      response,
      filename,
      language || round.language || 'en'
    );

    await saveTranscription(roundId, response, deliberationData);

    await updateRound(roundId, {
      status: RoundStatus.COMPLETED,
      audio_file: resolvedAudioPath,
      transcription_file: `${roundId}_deliberation.json`,
      duration_seconds: deliberationData.statistics.duration_seconds,
      speaker_count: deliberationData.statistics.total_speakers
    });

    log.info('Live transcription saved successfully', { roundId });

    return NextResponse.json({
      success: true,
      roundId,
      deliberation: deliberationData,
      message: 'Live transcription completed successfully'
    });
  } catch (error) {
    log.error('Live transcription error occurred', { error });
    return NextResponse.json(
      { error: 'Failed to save live transcription' },
      { status: 500 }
    );
  }
}
