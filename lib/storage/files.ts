/**
 * File storage utilities for transcriptions and audio files
 */

import fs from 'fs/promises';
import path from 'path';
import { DeliberationOntology } from '@/types/deliberation';
import { getLogger } from '@/lib/logging/logger';

const logger = getLogger('storage.files');

const DATA_DIR = path.join(process.cwd(), 'data');
const TRANSCRIPTIONS_DIR = path.join(DATA_DIR, 'transcriptions');
const AUDIO_DIR = path.join(process.cwd(), 'public', 'audio');

/**
 * Ensure required directories exist
 */
export async function ensureDirectories() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(TRANSCRIPTIONS_DIR, { recursive: true });
  await fs.mkdir(AUDIO_DIR, { recursive: true });
}

/**
 * Save both raw Deepgram response and Deliberation Ontology JSON
 * @param roundId - Unique round identifier
 * @param rawResponse - Raw Deepgram API response
 * @param deliberationData - Deliberation Ontology format data
 */
export async function saveTranscription(
  roundId: string,
  rawResponse: any,
  deliberationData: DeliberationOntology
) {
  logger.info('Saving transcription files', { roundId });

  try {
    await ensureDirectories();

    const rawPath = path.join(TRANSCRIPTIONS_DIR, `${roundId}_raw.json`);
    const deliberationPath = path.join(TRANSCRIPTIONS_DIR, `${roundId}_deliberation.json`);

    await fs.writeFile(rawPath, JSON.stringify(rawResponse, null, 2), 'utf-8');
    await fs.writeFile(deliberationPath, JSON.stringify(deliberationData, null, 2), 'utf-8');

    logger.info('Transcription files saved successfully', {
      roundId,
      rawPath,
      deliberationPath
    });

    return { rawPath, deliberationPath };
  } catch (error) {
    logger.error('Failed to save transcription files', { error, roundId });
    throw error;
  }
}

/**
 * Load Deliberation Ontology JSON for a round
 * @param roundId - Unique round identifier
 */
export async function loadDeliberationOntology(roundId: string): Promise<DeliberationOntology> {
  logger.debug('Loading deliberation ontology', { roundId });

  try {
    const filePath = path.join(TRANSCRIPTIONS_DIR, `${roundId}_deliberation.json`);
    const content = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(content);

    logger.info('Deliberation ontology loaded successfully', { roundId });
    return data;
  } catch (error) {
    logger.error('Failed to load deliberation ontology', { error, roundId });
    throw error;
  }
}

/**
 * Check if transcription exists for a round
 * @param roundId - Unique round identifier
 */
export async function transcriptionExists(roundId: string): Promise<boolean> {
  const filePath = path.join(TRANSCRIPTIONS_DIR, `${roundId}_deliberation.json`);
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Save audio file to public directory
 * @param roundId - Unique round identifier
 * @param buffer - Audio file buffer
 * @param extension - File extension (e.g., 'webm', 'mp3')
 */
export async function saveAudioFile(
  roundId: string,
  buffer: Buffer,
  extension: string = 'webm'
): Promise<string> {
  logger.info('Saving audio file', { roundId, extension, size: buffer.length });

  try {
    await ensureDirectories();
    const filename = `${roundId}.${extension}`;
    const filePath = path.join(AUDIO_DIR, filename);
    await fs.writeFile(filePath, buffer);

    logger.info('Audio file saved successfully', { roundId, filename, path: filePath });
    return `/audio/${filename}`;
  } catch (error) {
    logger.error('Failed to save audio file', { error, roundId, extension });
    throw error;
  }
}

/**
 * Check if audio file exists for a round
 * @param roundId - Unique round identifier
 */
export async function audioFileExists(roundId: string): Promise<string | null> {
  const extensions = ['webm', 'mp3', 'wav', 'ogg'];

  for (const ext of extensions) {
    const filePath = path.join(AUDIO_DIR, `${roundId}.${ext}`);
    try {
      await fs.access(filePath);
      return `/audio/${roundId}.${ext}`;
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Delete all files related to a round
 * @param roundId - Unique round identifier
 */
export async function deleteRoundFiles(roundId: string): Promise<void> {
  logger.info('Deleting round files', { roundId });

  const filesToDelete = [
    path.join(TRANSCRIPTIONS_DIR, `${roundId}_raw.json`),
    path.join(TRANSCRIPTIONS_DIR, `${roundId}_deliberation.json`),
  ];

  // Try to delete audio files with various extensions
  const extensions = ['webm', 'mp3', 'wav', 'ogg'];
  for (const ext of extensions) {
    filesToDelete.push(path.join(AUDIO_DIR, `${roundId}.${ext}`));
  }

  const deletedFiles: string[] = [];
  const failedFiles: string[] = [];

  for (const filePath of filesToDelete) {
    try {
      await fs.unlink(filePath);
      deletedFiles.push(path.basename(filePath));
    } catch {
      // File might not exist, ignore error
      failedFiles.push(path.basename(filePath));
    }
  }

  logger.info('Round files deletion completed', {
    roundId,
    deletedCount: deletedFiles.length,
    failedCount: failedFiles.length,
    deletedFiles
  });
}
