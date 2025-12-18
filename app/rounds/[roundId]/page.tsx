"use client"

import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Trash2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { TranscriptionDisplay } from '@/components/transcription/TranscriptionDisplay'
import { Round, RoundStatus } from '@/types/round'
import { DeliberationOntology } from '@/types/deliberation'

export default function RoundDetailPage({ params }: { params: { roundId: string } }) {
  const router = useRouter()
  const [round, setRound] = useState<Round | null>(null)
  const [transcription, setTranscription] = useState<DeliberationOntology | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchRoundData = async () => {
    setIsLoading(true)
    setError(null)

    try {
      // Fetch round metadata
      const roundResponse = await fetch(`/api/rounds/${params.roundId}`)
      if (!roundResponse.ok) {
        throw new Error('Round not found')
      }
      const roundData = await roundResponse.json()
      setRound(roundData.round)

      // If completed, fetch transcription
      if (roundData.round.status === RoundStatus.COMPLETED && roundData.round.transcription_file) {
        const transcriptionResponse = await fetch(`/api/rounds/${params.roundId}/transcription`)
        if (transcriptionResponse.ok) {
          const transcriptionData = await transcriptionResponse.json()
          setTranscription(transcriptionData)
        }
      }
    } catch (err) {
      const error = err as Error
      setError(error.message)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    fetchRoundData()
  }, [params.roundId])

  const handleDelete = async () => {
    if (!round) return

    if (!confirm(`Are you sure you want to delete "${round.name}"?`)) {
      return
    }

    try {
      const response = await fetch(`/api/rounds/${params.roundId}`, {
        method: 'DELETE'
      })

      if (!response.ok) {
        throw new Error('Failed to delete round')
      }

      router.push('/rounds')
    } catch (err) {
      const error = err as Error
      alert(`Error: ${error.message}`)
    }
  }

  const getStatusVariant = (status: RoundStatus) => {
    switch (status) {
      case RoundStatus.COMPLETED:
        return 'default'
      case RoundStatus.PROCESSING:
        return 'secondary'
      case RoundStatus.RECORDING:
        return 'default'
      case RoundStatus.ERROR:
        return 'destructive'
      default:
        return 'secondary'
    }
  }

  const getStatusLabel = (status: RoundStatus) => {
    switch (status) {
      case RoundStatus.COMPLETED:
        return 'Completed'
      case RoundStatus.PROCESSING:
        return 'Processing'
      case RoundStatus.RECORDING:
        return 'Recording'
      case RoundStatus.ERROR:
        return 'Error'
      case RoundStatus.CREATED:
        return 'Created'
      default:
        return status
    }
  }

  const formatDate = (dateString: string) => {
    const date = new Date(dateString)
    return new Intl.DateTimeFormat('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date)
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4 py-8 max-w-6xl">
          <div className="flex items-center justify-center py-12">
            <div className="text-center space-y-4">
              <RefreshCw className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
              <p className="text-muted-foreground">Loading round...</p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (error || !round) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4 py-8 max-w-6xl">
          <Link href="/rounds">
            <Button variant="ghost" size="sm" className="mb-4">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Rounds
            </Button>
          </Link>
          <div className="rounded-md bg-destructive/10 p-4 text-sm text-destructive">
            {error || 'Round not found'}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-8 max-w-6xl">
        {/* Header */}
        <div className="mb-8">
          <Link href="/rounds">
            <Button variant="ghost" size="sm" className="mb-4">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Rounds
            </Button>
          </Link>
          <div className="flex items-start justify-between">
            <div className="flex-1 min-w-0">
              <div className="flex items-center space-x-3 mb-2">
                <h1 className="text-4xl font-bold">{round.name}</h1>
                <Badge variant={getStatusVariant(round.status)}>
                  {getStatusLabel(round.status)}
                </Badge>
              </div>
              {round.description && (
                <p className="text-muted-foreground text-lg">
                  {round.description}
                </p>
              )}
              <p className="text-sm text-muted-foreground mt-2">
                Created {formatDate(round.created_at)}
              </p>
            </div>
            <Button
              variant="destructive"
              onClick={handleDelete}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </Button>
          </div>
        </div>

        {/* Status Messages */}
        {round.status === RoundStatus.PROCESSING && (
          <div className="rounded-md bg-blue-500/10 p-4 text-sm text-blue-700 dark:text-blue-400 mb-6">
            <div className="flex items-center space-x-2">
              <RefreshCw className="h-4 w-4 animate-spin" />
              <span>Processing audio... This may take a few minutes.</span>
            </div>
          </div>
        )}

        {round.status === RoundStatus.ERROR && (
          <div className="rounded-md bg-destructive/10 p-4 text-sm text-destructive mb-6">
            An error occurred during processing. Please try creating a new round.
          </div>
        )}

        {round.status === RoundStatus.CREATED && (
          <div className="rounded-md bg-yellow-500/10 p-4 text-sm text-yellow-700 dark:text-yellow-400 mb-6">
            This round has been created but no audio has been added yet.
          </div>
        )}

        {/* Transcription Display */}
        {round.status === RoundStatus.COMPLETED && transcription && (
          <TranscriptionDisplay
            data={transcription}
            roundName={round.name}
          />
        )}

        {round.status === RoundStatus.COMPLETED && !transcription && (
          <div className="rounded-md bg-yellow-500/10 p-4 text-sm text-yellow-700 dark:text-yellow-400 mb-6">
            <div className="flex items-center justify-between">
              <span>Transcription file not found.</span>
              <Button variant="outline" size="sm" onClick={fetchRoundData}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Retry
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
