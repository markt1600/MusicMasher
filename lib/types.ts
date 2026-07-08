export interface SongMeta {
  id: string;
  title: string;
  /** Artist name — from embedded tags or user input at upload time. */
  artist: string;
  /** Duration in seconds (measured client-side at upload time). */
  duration: number;
  /** Absolute URL (blob mode) or app-relative path (local mode) of the audio file. */
  audioUrl: string;
  /** File extension: mp3 | aac | m4a | aiff | aif | wav. Legacy entries lack it (mp3). */
  ext?: string;
  size: number;
  createdAt: string;
  /** Total times this song has been started (all players). */
  plays?: number;
}

export type NoteKind = 'tap' | 'double' | 'hold' | 'bonus';

/** A single tile. */
export interface Note {
  /** Time in seconds (relative to audio start) when the tile crosses the hit line. */
  t: number;
  /** Lane index 0..2 */
  lane: number;
  /** Tile type; absent means a normal tap. */
  kind?: NoteKind;
  /** Hold duration in seconds (kind === 'hold'). */
  dur?: number;
}

export interface Beatmap {
  notes: Note[];
  bpm: number;
  duration: number;
  /** Coarse loudness envelope (ENVELOPE_RATE samples/sec, values 0..1) for visuals. */
  envelope: Float32Array;
  envelopeRate: number;
}

export type Judgement = 'perfect' | 'great' | 'good' | 'miss';

export interface GameStats {
  score: number;
  maxCombo: number;
  perfect: number;
  great: number;
  good: number;
  miss: number;
  totalNotes: number;
}
