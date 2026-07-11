import type { Beatmap, Note } from './types';

/** Wire format for the server-side chart cache. */
export function serializeChart(map: Beatmap): string {
  return JSON.stringify({
    notes: map.notes,
    bpm: map.bpm,
    duration: map.duration,
    envelopeRate: map.envelopeRate,
    envelope: Array.from(map.envelope, (x) => Math.round(x * 1000) / 1000),
    grid: map.grid,
  });
}

export function deserializeChart(data: unknown): Beatmap | null {
  try {
    const d = data as {
      notes: Note[];
      bpm: number;
      duration: number;
      envelopeRate: number;
      envelope: number[];
      grid?: { period: number; phase: number; confidence: number };
    };
    if (
      !Array.isArray(d.notes) ||
      d.notes.length === 0 ||
      !Number.isFinite(d.bpm) ||
      !Number.isFinite(d.duration) ||
      !Number.isFinite(d.envelopeRate) ||
      !Array.isArray(d.envelope)
    ) {
      return null;
    }
    return {
      notes: d.notes,
      bpm: d.bpm,
      duration: d.duration,
      envelopeRate: d.envelopeRate,
      envelope: Float32Array.from(d.envelope),
      grid: d.grid,
    };
  } catch {
    return null;
  }
}
