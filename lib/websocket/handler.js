const path = require('path')
const fs = require('fs').promises
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk')

// Import storage functions dynamically to handle ES modules
let saveChunk, assembleChunks, getChunkManifest, findMissingChunks, updateChunkManifest
let getRound, updateRound

async function loadModules() {
  if (!saveChunk) {
    const fileStorage = await import('../storage/files.js')
    saveChunk = fileStorage.saveChunk
    assembleChunks = fileStorage.assembleChunks
    getChunkManifest = fileStorage.getChunkManifest
    findMissingChunks = fileStorage.findMissingChunks
    updateChunkManifest = fileStorage.updateChunkManifest

    const roundStorage = await import('../storage/rounds.js')
    getRound = roundStorage.getRound
    updateRound = roundStorage.updateRound
  }
}

// Session storage
const sessions = new Map()
const LIVE_ENABLED = process.env.DEEPGRAM_LIVE_ENABLED !== 'false'

function generateSessionId() {
  return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
}

function handleConnection(ws) {
  const sessionId = generateSessionId()
  const state = {
    sessionId,
    roundId: null,
    lastReceivedSequence: -1,
    expectedSequence: 0,
    totalChunksReceived: 0,
    startTime: Date.now(),
    lastMessageAt: Date.now(),
    mimeType: 'audio/webm',
    awaitingChunkData: false,
    pendingChunkSequence: null,
    unexpectedBinaryBuffer: null,  // Handle race condition binary data
    status: 'connected',
    ws,
    live: null,
    liveRequested: true,
    processing: Promise.resolve()
  }

  sessions.set(ws, state)
  console.log('[WebSocket] Connection opened', { sessionId })

  // Heartbeat
  const heartbeat = setInterval(() => {
    if (ws.readyState === 1) { // OPEN
      ws.ping()
    }
  }, 30000)

  ws.on('message', (data, isBinary) => {
    state.processing = state.processing.then(async () => {
      try {
        await handleMessage(ws, state, data, isBinary)
      } catch (error) {
        console.error('[WebSocket] Error handling message', {
          sessionId,
          error: error.message,
          stack: error.stack,
          dataType: data instanceof Buffer ? 'Buffer' : typeof data,
          dataLength: data.length
        })
        ws.send(JSON.stringify({
          type: 'error',
          message: error.message || 'Internal server error',
          code: 'INTERNAL_ERROR'
        }))
      }
    })
  })

  ws.on('close', () => {
    clearInterval(heartbeat)
    teardownLiveTranscription(state)
    sessions.delete(ws)
    console.log('[WebSocket] Connection closed', { sessionId, roundId: state.roundId })
  })

  ws.on('error', (error) => {
    console.error('[WebSocket] Socket error', { sessionId, error: error.message })
  })

  ws.on('pong', () => {
    // Heartbeat pong received
  })
}

/**
 * Safely check if data looks like JSON before attempting to parse
 */
function isLikelyJSON(data) {
  if (!(data instanceof Buffer) && typeof data !== 'string') return false

  const str = data instanceof Buffer ? data.toString('utf8') : data

  // Check for empty or very small payloads
  if (str.trim().length < 2) return false

  try {
    const trimmed = str.trim()

    // JSON objects start with { or [
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      return false
    }

    // Try to parse - if it throws, it's not JSON
    JSON.parse(str)
    return true
  } catch (e) {
    return false
  }
}

async function handleMessage(ws, state, data, isBinary = data instanceof Buffer) {
  await loadModules()
  state.lastMessageAt = Date.now()

  // Handle binary chunk data when expected
  if (isBinary && state.awaitingChunkData) {
    if (!(data instanceof Buffer)) {
      console.warn('[WebSocket] Expected binary buffer but received non-buffer data', {
        sessionId: state.sessionId,
        dataType: typeof data
      })
      return
    }
    if (state.pendingChunkSequence === null || state.pendingChunkSequence === undefined) {
      console.warn('[WebSocket] Unexpected binary data received', { sessionId: state.sessionId })
      return
    }

    // Save chunk to disk
    try {
      const sequence = state.pendingChunkSequence
      await saveChunk(state.roundId, sequence, data)
      sendToLiveTranscription(state, data)

      console.log('[WebSocket] Chunk received and saved', {
        sessionId: state.sessionId,
        sequence,
        size: data.length
      })

      state.totalChunksReceived++
      state.lastReceivedSequence = sequence

      ws.send(JSON.stringify({
        type: 'ack',
        sequence
      }))

      state.awaitingChunkData = false
      state.pendingChunkSequence = null
    } catch (error) {
      console.error('[WebSocket] Failed to save chunk', {
        sessionId: state.sessionId,
        error: error.message
      })
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Failed to save chunk',
        code: 'CHUNK_SAVE_ERROR'
      }))
    }
    return
  }

  // If ws marks data as text but payload is binary, treat it as binary.
  if (!isBinary && data instanceof Buffer && !isLikelyJSON(data)) {
    console.warn('[WebSocket] Treating non-JSON buffer as binary', {
      sessionId: state.sessionId,
      size: data.length
    })
    await handleMessage(ws, state, data, true)
    return
  }

  // NEW: Handle unexpected binary data (race condition)
  if (isBinary && !state.awaitingChunkData) {
    if (!(data instanceof Buffer)) {
      console.warn('[WebSocket] Expected binary buffer but received non-buffer data', {
        sessionId: state.sessionId,
        dataType: typeof data
      })
      return
    }
    console.log('[WebSocket] Binary data arrived before metadata (race condition)', {
      sessionId: state.sessionId,
      size: data.length,
      hasBuffered: state.unexpectedBinaryBuffer !== null
    })

    // Buffer ONE unexpected chunk (don't accumulate)
    if (!state.unexpectedBinaryBuffer) {
      state.unexpectedBinaryBuffer = data
    } else {
      console.warn('[WebSocket] Multiple unexpected binary chunks - dropping oldest', {
        sessionId: state.sessionId
      })
      state.unexpectedBinaryBuffer = data
    }
    sendToLiveTranscription(state, data)
    return
  }

  // NEW: Safe JSON parsing with validation
  if (!isLikelyJSON(data)) {
    console.warn('[WebSocket] Received non-JSON data', {
      sessionId: state.sessionId,
      dataType: typeof data,
      isBuffer: data instanceof Buffer,
      size: data instanceof Buffer ? data.length : data.length,
      preview: data instanceof Buffer
        ? data.toString('utf8', 0, Math.min(100, data.length))
        : data.slice(0, 100)
    })
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Invalid message format',
      code: 'INVALID_FORMAT'
    }))
    return
  }

  // Parse JSON message
  const message = JSON.parse(data instanceof Buffer ? data.toString('utf8') : data)

  switch (message.type) {
    case 'init':
      await handleInit(ws, state, message)
      break

    case 'chunk':
      await handleChunkMetadata(ws, state, message)
      break

    case 'complete':
      await handleComplete(ws, state, message)
      break

    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }))
      break

    default:
      console.warn('[WebSocket] Unknown message type', { type: message.type })
  }
}

async function handleInit(ws, state, message) {
  const { roundId, mimeType, liveEnabled } = message

  // Validate round exists
  const round = await getRound(roundId)
  if (!round) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Round not found',
      code: 'ROUND_NOT_FOUND'
    }))
    ws.close()
    return
  }

  state.roundId = roundId
  state.mimeType = mimeType || 'audio/webm'
  state.status = 'recording'
  console.log('[WebSocket] Init received', {
    sessionId: state.sessionId,
    roundId,
    liveEnabled
  })
  state.liveRequested = liveEnabled !== false
  if (state.liveRequested) {
    console.log('[WebSocket] Starting live transcription', {
      sessionId: state.sessionId,
      roundId,
      mimeType: state.mimeType
    })
    await startLiveTranscription(state, round, state.mimeType)
  } else {
    console.log('[WebSocket] Live transcription disabled for session', {
      sessionId: state.sessionId,
      roundId
    })
  }

  // Check if resuming (existing chunks)
  const manifest = await getChunkManifest(roundId)
  if (manifest) {
    state.lastReceivedSequence = Math.max(...manifest.receivedSequences, -1)
    state.expectedSequence = state.lastReceivedSequence + 1
    console.log('[WebSocket] Resuming session', {
      sessionId: state.sessionId,
      roundId,
      lastReceivedSequence: state.lastReceivedSequence
    })
  }

  // Update round status
  await updateRound(roundId, { status: 'streaming' })

  ws.send(JSON.stringify({
    type: 'ready',
    sessionId: state.sessionId,
    lastReceivedSequence: state.lastReceivedSequence
  }))

  console.log('[WebSocket] Session initialized', {
    sessionId: state.sessionId,
    roundId,
    resuming: manifest !== null
  })
}

async function handleChunkMetadata(ws, state, message) {
  const sequence = Number(message.sequence)
  if (!Number.isFinite(sequence)) {
    console.warn('[WebSocket] Invalid chunk sequence', {
      sessionId: state.sessionId,
      sequence: message.sequence
    })
    return
  }

  if (!state.roundId) {
    console.warn('[WebSocket] Chunk received before init', {
      sessionId: state.sessionId,
      sequence
    })
    return
  }

  // Check for gaps
  if (sequence !== state.expectedSequence) {
    console.warn('[WebSocket] Sequence gap detected', {
      expected: state.expectedSequence,
      received: sequence,
      sessionId: state.sessionId
    })

    const missing = await findMissingChunks(state.roundId, sequence)

    if (missing.length > 0) {
      ws.send(JSON.stringify({
        type: 'missing',
        sequences: missing
      }))
    }
  }

  state.awaitingChunkData = true
  state.pendingChunkSequence = sequence
  state.expectedSequence = sequence + 1

  // NEW: Process buffered binary data if available (race condition handling)
  if (state.unexpectedBinaryBuffer) {
    console.log('[WebSocket] Processing buffered binary data from race condition', {
      sessionId: state.sessionId,
      sequence: sequence,
      size: state.unexpectedBinaryBuffer.length
    })

    // Recursively call handleMessage with the buffered binary data
    const bufferedData = state.unexpectedBinaryBuffer
    state.unexpectedBinaryBuffer = null

    // Process the buffered binary data immediately
    await handleMessage(ws, state, bufferedData, true)
  }
}

async function handleComplete(ws, state, message) {
  const { totalChunks, finalDuration } = message

  if (!state.roundId) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Session not initialized',
      code: 'NOT_INITIALIZED'
    }))
    return
  }

  console.log('[WebSocket] Completing chunk assembly', {
    roundId: state.roundId,
    totalChunks,
    received: state.totalChunksReceived
  })

  try {
    state.status = 'processing'
    // Check for missing chunks
    const missing = await findMissingChunks(state.roundId, totalChunks)
    if (missing.length > 0) {
      console.warn('[WebSocket] Missing chunks detected', { roundId: state.roundId, missing })
      ws.send(JSON.stringify({
        type: 'missing',
        sequences: missing
      }))
      return
    }

    // Assemble chunks into final file
    const audioPath = await assembleChunks(state.roundId, totalChunks, state.mimeType)

    // Update round
    await updateRound(state.roundId, {
      status: 'processing',
      audio_file: audioPath,
      duration_seconds: finalDuration
    })

    ws.send(JSON.stringify({
      type: 'complete',
      chunkCount: totalChunks,
      audioPath
    }))

    console.log('[WebSocket] Chunks assembled successfully', { roundId: state.roundId })

    const usedLive = await finalizeLiveTranscription(state, audioPath)
    console.log('[WebSocket] Live transcription finalize', {
      roundId: state.roundId,
      usedLive
    })
    if (!usedLive) {
      // Trigger transcription asynchronously (don't await to avoid blocking WebSocket)
      triggerTranscription(state.roundId).catch(error => {
        console.error('[WebSocket] Failed to trigger transcription', {
          roundId: state.roundId,
          error: error.message
        })
      })
    }
  } catch (error) {
    console.error('[WebSocket] Failed to assemble chunks', { roundId: state.roundId, error: error.message })

    await updateRound(state.roundId, { status: 'error' })

    ws.send(JSON.stringify({
      type: 'error',
      message: 'Failed to assemble audio',
      code: 'ASSEMBLY_FAILED'
    }))
  }
}

function resolveLiveEncoding(mimeType) {
  if (!mimeType) return undefined
  if (mimeType.includes('webm') || mimeType.includes('ogg')) return 'opus'
  if (mimeType.includes('wav')) return 'linear16'
  return undefined
}

function buildLiveSegment(alternative, data, isFinal) {
  const words = alternative?.words || []
  const text = (alternative?.transcript || '').trim()
    || words.map(word => word.punctuated_word || word.word).join(' ').trim()
  const start = words.length ? words[0].start : (data.start || 0)
  const end = words.length ? words[words.length - 1].end : ((data.start || 0) + (data.duration || 0))
  const speakerCounts = new Map()
  words.forEach((word) => {
    if (typeof word.speaker === 'number') {
      speakerCounts.set(word.speaker, (speakerCounts.get(word.speaker) || 0) + 1)
    }
  })
  let speaker = undefined
  if (speakerCounts.size) {
    speaker = Array.from(speakerCounts.entries()).sort((a, b) => b[1] - a[1])[0][0]
  }
  return {
    id: `seg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    text,
    speaker,
    start,
    end,
    isFinal
  }
}

async function startLiveTranscription(state, round, mimeType) {
  if (!LIVE_ENABLED) return
  const apiKey = process.env.DEEPGRAM_API_KEY
  if (!apiKey) {
    console.warn('[WebSocket] Live transcription disabled (missing DEEPGRAM_API_KEY)')
    return
  }

  try {
    const deepgram = createClient(apiKey)
    const language = round?.language || 'en'
    const encoding = resolveLiveEncoding(mimeType)
    console.log('[WebSocket] Live transcription connect', {
      roundId: state.roundId,
      language,
      encoding: encoding || 'auto'
    })
    const liveClient = deepgram.listen.live({
      model: 'nova-2',
      language,
      diarize: true,
      punctuate: true,
      smart_format: true,
      interim_results: true,
      utterances: true,
      vad_events: true,
      channels: 1,
      sample_rate: 48000,
      ...(encoding ? { encoding } : {})
    })

    const liveState = {
      client: liveClient,
      language,
      words: [],
      segments: [],
      partial: null,
      lastEventAt: null,
      keepAlive: null
    }

    state.live = liveState

    liveClient.on(LiveTranscriptionEvents.Open, () => {
      console.log('[WebSocket] Live transcription open', {
        roundId: state.roundId
      })
      liveState.keepAlive = setInterval(() => {
        liveClient.keepAlive()
      }, 15000)
    })

    liveClient.on(LiveTranscriptionEvents.Transcript, (data) => {
      const alternative = data.channel?.alternatives?.[0] || data.channels?.[0]?.alternatives?.[0]
      if (!alternative) return

      const isFinal = Boolean(data.is_final || data.speech_final)
      const segment = buildLiveSegment(alternative, data, isFinal)
      if (!segment.text) return
      liveState.lastEventAt = Date.now()
      console.log('[WebSocket] Live transcript segment', {
        roundId: state.roundId,
        isFinal,
        speaker: segment.speaker,
        textPreview: segment.text.slice(0, 80)
      })

      if (isFinal) {
        liveState.segments.push(segment)
        if (Array.isArray(alternative.words)) {
          liveState.words.push(...alternative.words)
        }
        liveState.partial = null
      } else {
        liveState.partial = segment
      }

      state.lastMessageAt = Date.now()

      try {
        state.ws?.send(JSON.stringify({
          type: 'live_transcript',
          segment
        }))
      } catch {
        // Ignore send errors for live transcript updates.
      }
    })

    liveClient.on(LiveTranscriptionEvents.Error, (error) => {
      console.error('[WebSocket] Live transcription error', { roundId: state.roundId, error })
    })

    liveClient.on(LiveTranscriptionEvents.Close, (event) => {
      console.log('[WebSocket] Live transcription closed', {
        roundId: state.roundId,
        code: event?.code,
        reason: event?.reason
      })
    })
  } catch (error) {
    console.error('[WebSocket] Failed to start live transcription', { error: error.message })
  }
}

function sendToLiveTranscription(state, data) {
  if (!state.live?.client) return
  try {
    state.live.client.send(data)
  } catch (error) {
    console.error('[WebSocket] Failed to send audio to live transcription', { error: error.message })
  }
}

function teardownLiveTranscription(state) {
  if (!state.live?.client) return
  try {
    if (state.live.keepAlive) {
      clearInterval(state.live.keepAlive)
    }
    state.live.client.requestClose()
  } catch {
    // Ignore cleanup errors.
  }
}

function buildLiveResponse(state) {
  if (!state.live || !state.live.words.length) return null
  const words = state.live.words
  const transcript = state.live.segments.map(segment => segment.text).join(' ').trim()
  const duration = words.length ? Math.max(...words.map(word => word.end || 0)) : 0
  const averageConfidence = words.length
    ? words.reduce((sum, word) => sum + (word.confidence ?? 0), 0) / words.length
    : 0

  return {
    metadata: {
      model: 'nova-2',
      language: state.live.language || 'en',
      created: new Date().toISOString(),
      duration,
      channels: 1
    },
    results: {
      channels: [
        {
          alternatives: [
            {
              transcript,
              confidence: averageConfidence,
              words
            }
          ]
        }
      ]
    }
  }
}

function getLiveTranscription(roundId) {
  for (const session of sessions.values()) {
    if (session.roundId === roundId && session.live) {
      const text = [
        ...session.live.segments.map(segment => segment.text),
        session.live.partial?.text
      ].filter(Boolean).join(' ').trim()

      return {
        roundId,
        language: session.live.language,
        status: session.status,
        updated_at: session.live.lastEventAt || session.lastMessageAt,
        segments: session.live.segments,
        partial: session.live.partial,
        text
      }
    }
  }
  return null
}

async function finalizeLiveTranscription(state, audioPath) {
  if (!state.live?.client) return false
  try {
    console.log('[WebSocket] Finalizing live transcription', { roundId: state.roundId })
    state.live.client.finalize()
    await new Promise(resolve => setTimeout(resolve, 1500))
    state.live.client.requestClose()
    if (state.live.keepAlive) {
      clearInterval(state.live.keepAlive)
    }

    const response = buildLiveResponse(state)
    if (!response) {
      console.warn('[WebSocket] Live transcription did not return results')
      return false
    }

    const success = await saveLiveTranscription(state.roundId, audioPath, response, state.live.language || 'en')
    return success
  } catch (error) {
    console.error('[WebSocket] Failed to finalize live transcription', { error: error.message })
    return false
  }
}

async function saveLiveTranscription(roundId, audioPath, response, language) {
  try {
    console.log('[WebSocket] Saving live transcription', { roundId })
    const port = process.env.PORT || '3000'
    const result = await fetch(`http://localhost:${port}/api/rounds/${roundId}/transcribe-live`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ response, audioPath, language })
    })

    if (!result.ok) {
      const error = await result.json()
      throw new Error(error.error || 'Live transcription request failed')
    }

    console.log('[WebSocket] Live transcription saved successfully', { roundId })
    return true
  } catch (error) {
    console.error('[WebSocket] Failed to save live transcription', { roundId, error: error.message })
    return false
  }
}

/**
 * Trigger transcription for assembled audio file
 */
async function triggerTranscription(roundId) {
  try {
    const response = await fetch(`http://localhost:3000/api/rounds/${roundId}/transcribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    })

    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error || 'Transcription request failed')
    }

    const result = await response.json()
    console.log('[WebSocket] Transcription triggered successfully', {
      roundId,
      success: result.success
    })
  } catch (error) {
    console.error('[WebSocket] Failed to trigger transcription', {
      roundId,
      error: error.message
    })
    throw error
  }
}

function getSessionStats() {
  const sessionList = Array.from(sessions.values()).map((state) => ({
    sessionId: state.sessionId,
    roundId: state.roundId,
    status: state.status,
    lastReceivedSequence: state.lastReceivedSequence,
    totalChunksReceived: state.totalChunksReceived,
    startTime: state.startTime,
    lastMessageAt: state.lastMessageAt
  }))

  return {
    connected: sessions.size,
    recording: sessionList.filter(session => session.status === 'recording').length,
    sessions: sessionList
  }
}

module.exports = { handleConnection, getSessionStats, getLiveTranscription }
