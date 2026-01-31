"use client"

import React from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { LiveTranscriptSegment } from '@/types/live-transcription'

interface LiveTranscriptionDisplayProps {
  segments: LiveTranscriptSegment[]
  partial?: LiveTranscriptSegment | null
}

const formatSeconds = (seconds?: number) => {
  if (seconds === undefined || Number.isNaN(seconds)) return '--:--'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export function LiveTranscriptionDisplay({ segments, partial }: LiveTranscriptionDisplayProps) {
  const hasContent = segments.length > 0 || Boolean(partial?.text)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Live Transcription</CardTitle>
        <CardDescription>Updates in real time while recording</CardDescription>
      </CardHeader>
      <CardContent>
        {!hasContent && (
          <p className="text-sm text-muted-foreground">
            Listening for speech...
          </p>
        )}
        <div className="space-y-4">
          {segments.map(segment => (
            <div key={segment.id} className="rounded-lg border border-border/60 bg-background/80 p-3">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  Speaker {segment.speaker ?? '—'}
                </span>
                <span>
                  {formatSeconds(segment.start)} - {formatSeconds(segment.end)}
                </span>
              </div>
              <p className="mt-2 text-sm leading-relaxed">{segment.text}</p>
            </div>
          ))}
          {partial?.text && (
            <div className="rounded-lg border border-dashed border-border/60 bg-background/60 p-3">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  Speaker {partial.speaker ?? '—'}
                </span>
                <span>
                  {formatSeconds(partial.start)} - {formatSeconds(partial.end)}
                </span>
              </div>
              <p className="mt-2 text-sm italic text-muted-foreground">
                {partial.text}
              </p>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
