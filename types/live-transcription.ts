export interface LiveTranscriptSegment {
  id: string;
  text: string;
  speaker?: number;
  start?: number;
  end?: number;
  isFinal: boolean;
}
