import { FFT } from './fft';
import type { Beatmap, Note } from './types';

/**
 * Client-side beat analysis. Decodes nothing itself — takes an AudioBuffer
 * and produces a deterministic Beatmap, so every player of a given song
 * gets the same chart.
 *
 * Pipeline: mono downmix → STFT (1024/512) → spectral flux onset envelope →
 * adaptive peak picking → difficulty-ramped note selection with lane
 * assignment from band energy (bass→left, mids→center, highs→right).
 */

const WIN = 1024;
const HOP = 512;
const ENVELOPE_RATE = 30; // samples per second, for visuals

/** Bump when the chart algorithm changes — invalidates server-cached charts. */
export const CHART_VERSION = 2;

// Deterministic PRNG so charts are identical across devices.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const yieldToUI = () => new Promise<void>((r) => setTimeout(r, 0));

function easeInOut(x: number): number {
  return x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2;
}

interface Onset {
  t: number;
  strength: number;
  band: number; // 0 low, 1 mid, 2 high
}

export async function analyzeAudio(
  buffer: AudioBuffer,
  onProgress?: (p: number) => void,
  difficulty = 1
): Promise<Beatmap> {
  const sr = buffer.sampleRate;
  const duration = buffer.duration;

  // --- mono downmix ---------------------------------------------------------
  const mono = new Float32Array(buffer.length);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) mono[i] += data[i];
  }
  const chScale = 1 / buffer.numberOfChannels;
  for (let i = 0; i < mono.length; i++) mono[i] *= chScale;

  // --- STFT: spectral flux + band energies + rms ---------------------------
  const numFrames = Math.max(0, Math.floor((mono.length - WIN) / HOP));
  if (numFrames < 40) {
    return { notes: [], bpm: 120, duration, envelope: new Float32Array(1), envelopeRate: ENVELOPE_RATE };
  }
  const fft = new FFT(WIN);
  const hann = new Float32Array(WIN);
  for (let i = 0; i < WIN; i++) {
    hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (WIN - 1)));
  }
  const frame = new Float32Array(WIN);
  const mag = new Float32Array(WIN / 2);
  const prevMag = new Float32Array(WIN / 2);

  const flux = new Float32Array(numFrames);
  const rms = new Float32Array(numFrames);
  const bandLow = new Float32Array(numFrames);
  const bandMid = new Float32Array(numFrames);
  const bandHigh = new Float32Array(numFrames);

  const binHz = sr / WIN;
  const lowEnd = Math.max(2, Math.round(220 / binHz)); // ~bins 1..5
  const midEnd = Math.round(2200 / binHz); // ~bins ..51

  for (let f = 0; f < numFrames; f++) {
    const off = f * HOP;
    let sumSq = 0;
    for (let i = 0; i < WIN; i++) {
      const s = mono[off + i];
      sumSq += s * s;
      frame[i] = s * hann[i];
    }
    rms[f] = Math.sqrt(sumSq / WIN);
    fft.magnitudes(frame, mag);

    let fl = 0;
    let lo = 0;
    let mi = 0;
    let hi = 0;
    for (let k = 1; k < WIN / 2; k++) {
      const d = mag[k] - prevMag[k];
      if (d > 0) fl += d;
      if (k < lowEnd) lo += mag[k];
      else if (k < midEnd) mi += mag[k];
      else hi += mag[k];
    }
    flux[f] = fl;
    bandLow[f] = lo;
    bandMid[f] = mi;
    bandHigh[f] = hi;
    prevMag.set(mag);

    if ((f & 2047) === 2047) {
      onProgress?.(f / numFrames);
      await yieldToUI();
    }
  }
  onProgress?.(1);

  const frameDt = HOP / sr; // ~11.6 ms

  // --- adaptive onset picking ----------------------------------------------
  // Sliding local mean via prefix sums.
  const prefix = new Float64Array(numFrames + 1);
  for (let i = 0; i < numFrames; i++) prefix[i + 1] = prefix[i] + flux[i];
  const globalMean = prefix[numFrames] / numFrames;
  const halfWin = Math.round(0.5 / frameDt); // ±0.5 s

  const localMeanAt = (i: number) => {
    const a = Math.max(0, i - halfWin);
    const b = Math.min(numFrames, i + halfWin + 1);
    return (prefix[b] - prefix[a]) / (b - a);
  };

  const onsets: Onset[] = [];
  const minGapFrames = Math.round(0.09 / frameDt);
  let lastOnsetFrame = -minGapFrames;
  for (let i = 3; i < numFrames - 3; i++) {
    const v = flux[i];
    if (v <= 0) continue;
    let isPeak = true;
    for (let j = 1; j <= 3; j++) {
      if (flux[i - j] > v || flux[i + j] > v) {
        isPeak = false;
        break;
      }
    }
    if (!isPeak) continue;
    const local = localMeanAt(i);
    if (v < local * 1.3 + globalMean * 0.08) continue;
    const strength = v / (local + 1e-9);
    if (i - lastOnsetFrame < minGapFrames) {
      // keep the stronger of the two close onsets
      const prev = onsets[onsets.length - 1];
      if (prev && strength > prev.strength) {
        prev.t = i * frameDt;
        prev.strength = strength;
        prev.band = dominantBand(i);
        lastOnsetFrame = i;
      }
      continue;
    }
    onsets.push({ t: i * frameDt, strength, band: dominantBand(i) });
    lastOnsetFrame = i;
  }

  function dominantBand(i: number): number {
    // Compare each band to its neighborhood average so a quiet hi-hat can
    // still win over a constantly-loud bassline.
    const a = Math.max(0, i - halfWin);
    const b = Math.min(numFrames, i + halfWin + 1);
    let lo = 0;
    let mi = 0;
    let hi = 0;
    for (let k = a; k < b; k++) {
      lo += bandLow[k];
      mi += bandMid[k];
      hi += bandHigh[k];
    }
    const n = b - a;
    const rl = bandLow[i] / (lo / n + 1e-9);
    const rm = bandMid[i] / (mi / n + 1e-9);
    const rh = bandHigh[i] / (hi / n + 1e-9);
    if (rl >= rm && rl >= rh) return 0;
    if (rm >= rh) return 1;
    return 2;
  }

  // --- BPM estimate via flux autocorrelation + beat-grid fit ----------------
  const bpm = estimateBpm(flux, frameDt);
  const grid = fitBeatGrid(flux, frameDt, bpm);

  // --- envelope for visuals --------------------------------------------------
  const envLen = Math.max(1, Math.ceil(duration * ENVELOPE_RATE));
  const envelope = new Float32Array(envLen);
  const counts = new Uint16Array(envLen);
  for (let f = 0; f < numFrames; f++) {
    const idx = Math.min(envLen - 1, Math.floor(f * frameDt * ENVELOPE_RATE));
    envelope[idx] += rms[f];
    counts[idx]++;
  }
  let envMax = 1e-9;
  for (let i = 0; i < envLen; i++) {
    if (counts[i] > 0) envelope[i] /= counts[i];
    if (envelope[i] > envMax) envMax = envelope[i];
  }
  for (let i = 0; i < envLen; i++) {
    envelope[i] = Math.min(1, envelope[i] / (envMax * 0.85));
  }

  // --- difficulty-ramped note selection --------------------------------------
  const notes = buildNotes(onsets, duration, bpm, envelope, ENVELOPE_RATE, difficulty, grid);

  return {
    notes,
    bpm: Math.round((60 / grid.period) * 10) / 10,
    duration,
    envelope,
    envelopeRate: ENVELOPE_RATE,
  };
}

interface BeatGrid {
  /** Seconds per beat. */
  period: number;
  /** Time of the first beat. */
  phase: number;
  /** Time of the first downbeat (bar start). */
  downPhase: number;
  /** How much louder the grid positions are vs. average — >1.35 is trustworthy. */
  confidence: number;
}

/**
 * Fit a beat grid to the onset-strength envelope: search small tempo
 * perturbations × all phases for the alignment that captures the most flux,
 * then pick the downbeat as the strongest of the four beat positions.
 */
function fitBeatGrid(flux: Float32Array, frameDt: number, bpm: number): BeatGrid {
  const n = flux.length;
  const total = n * frameDt;
  const fluxAt = (t: number) => {
    const i = t / frameDt;
    const i0 = Math.floor(i);
    if (i0 < 0 || i0 + 1 >= n) return 0;
    const fr = i - i0;
    return flux[i0] * (1 - fr) + flux[i0 + 1] * fr;
  };

  const period0 = 60 / bpm;
  let best = { score: -Infinity, period: period0, phase: 0 };
  for (let dp = -4; dp <= 4; dp++) {
    const period = period0 * (1 + dp * 0.003);
    for (let ph = 0; ph < period; ph += frameDt) {
      let s = 0;
      let count = 0;
      for (let t = ph; t < total; t += period) {
        s += fluxAt(t);
        count++;
      }
      const score = count > 0 ? s / count : 0;
      if (score > best.score) best = { score, period, phase: ph };
    }
  }

  let mean = 0;
  for (let i = 0; i < n; i++) mean += flux[i];
  mean /= Math.max(1, n);
  const confidence = best.score / (mean + 1e-9);

  // Downbeat: the strongest of the four beat offsets within a bar.
  let downPhase = best.phase;
  let downScore = -Infinity;
  for (let k = 0; k < 4; k++) {
    const start = best.phase + k * best.period;
    let s = 0;
    let count = 0;
    for (let t = start; t < total; t += best.period * 4) {
      s += fluxAt(t);
      count++;
    }
    const sc = count > 0 ? s / count : 0;
    if (sc > downScore) {
      downScore = sc;
      downPhase = start;
    }
  }

  return { period: best.period, phase: best.phase, downPhase, confidence };
}

function estimateBpm(flux: Float32Array, frameDt: number): number {
  const n = flux.length;
  const mean = flux.reduce((a, b) => a + b, 0) / n;
  const minLag = Math.round(60 / 200 / frameDt); // 200 bpm
  const maxLag = Math.min(n - 1, Math.round(60 / 60 / frameDt)); // 60 bpm
  let bestLag = 0;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < n; i += 2) {
      sum += (flux[i] - mean) * (flux[i + lag] - mean);
    }
    // slight bias toward shorter lags (faster tempo) to break ties
    const score = (sum / (n - lag)) * (1 - (lag - minLag) / (maxLag - minLag) * 0.1);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (bestLag === 0) return 120;
  let bpm = 60 / (bestLag * frameDt);
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  return Math.round(bpm * 10) / 10;
}

function buildNotes(
  onsets: Onset[],
  duration: number,
  bpm: number,
  envelope: Float32Array,
  envelopeRate: number,
  difficulty = 1,
  grid?: BeatGrid
): Note[] {
  const rng = mulberry32(Math.round(duration * 1000) ^ (onsets.length << 8));
  // Gauntlet stages: denser charts and more flourishes at higher difficulty.
  const gapScale = Math.max(0.65, 1 - 0.08 * (difficulty - 1));
  const flourishMul = 1 + 0.18 * (difficulty - 1);

  // --- musical grid helpers -------------------------------------------------
  // With a confident tempo fit, note times snap to 16th-note subdivisions so
  // tiles land squarely on the music; low confidence (rubato, live takes)
  // keeps raw onset times.
  const gridOk = !!grid && grid.confidence >= 1.35;
  const snap = (t: number): number => {
    if (!gridOk || !grid) return t;
    const sub = grid.period / 4;
    const k = Math.round((t - grid.phase) / sub);
    const tq = grid.phase + k * sub;
    return Math.abs(tq - t) <= Math.min(0.05, sub * 0.35) ? tq : t;
  };
  const onBeat = (t: number): boolean => {
    if (!gridOk || !grid) return true; // no grid → don't restrict
    const rel = (((t - grid.downPhase) % grid.period) + grid.period) % grid.period;
    return rel < 0.06 || rel > grid.period - 0.06;
  };

  // --- local intensity: how loud is the song around t, 0..1 -----------------
  // Smoothed over ~2 bars and normalized by the 90th percentile, so chart
  // density follows the song's arc (drops dense, bridges sparse).
  const barLen = gridOk && grid ? grid.period * 4 : 2;
  const intensityStep = 0.25;
  const intensityArr: number[] = [];
  for (let t = 0; t < duration; t += intensityStep) {
    let sum = 0;
    let n = 0;
    for (let u = t - barLen; u <= t + barLen; u += 1 / envelopeRate) {
      const idx = Math.floor(u * envelopeRate);
      if (idx >= 0 && idx < envelope.length) {
        sum += envelope[idx];
        n++;
      }
    }
    intensityArr.push(n > 0 ? sum / n : 0);
  }
  const sortedInt = [...intensityArr].sort((a, b) => a - b);
  const p90 = sortedInt[Math.floor(sortedInt.length * 0.9)] || 1;
  for (let i = 0; i < intensityArr.length; i++) {
    intensityArr[i] = Math.min(1, intensityArr[i] / (p90 + 1e-9));
  }
  const intensityAt = (t: number) =>
    intensityArr[Math.max(0, Math.min(intensityArr.length - 1, Math.floor(t / intensityStep)))] ?? 0.5;

  /** Density driver: progressive difficulty blended with the song's energy. */
  const driveAt = (t: number, p: number) =>
    Math.min(1, 0.55 * easeInOut(p) + 0.45 * intensityAt(t) ** 1.2);

  // Fallback for songs where onset detection finds almost nothing: lay tiles
  // on a straight beat grid so every upload is still playable.
  if (onsets.length < duration * 0.35) {
    const grid: Onset[] = [];
    const beat = 60 / bpm;
    for (let t = 1.5; t < duration - 1; t += beat) {
      grid.push({ t, strength: 2, band: Math.floor(rng() * 3) });
    }
    onsets = grid;
  }

  const envAt = (t: number) => {
    const idx = Math.floor(t * envelopeRate);
    return idx >= 0 && idx < envelope.length ? envelope[idx] : 0;
  };
  /** Mean loudness over [a, b] — used to confirm a sustained sound. */
  const envMean = (a: number, b: number) => {
    let sum = 0;
    let n = 0;
    for (let t = a; t < b; t += 1 / envelopeRate) {
      sum += envAt(t);
      n++;
    }
    return n > 0 ? sum / n : 0;
  };

  // Percentile thresholds on onset strength: early game keeps only the
  // strongest hits, late game keeps nearly everything.
  const sorted = onsets.map((o) => o.strength).sort((a, b) => a - b);
  const quantile = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];

  const notes: Note[] = [];
  let lastT = -10;
  let lastLane = -1;
  let laneStreak = 0;
  let lastBonusT = -10;

  const pickLane = (o: Onset, gapFromLast: number): number => {
    let lane = o.band;
    if (lane === lastLane) {
      laneStreak++;
      // Break up long same-lane streams and impossible fast jacks.
      if (laneStreak >= 3 || gapFromLast < 0.22) {
        lane = (lane + (rng() < 0.5 ? 1 : 2)) % 3;
        laneStreak = 0;
      }
    } else {
      laneStreak = 0;
    }
    return lane;
  };

  for (let i = 0; i < onsets.length; i++) {
    const o = onsets[i];
    if (o.t < 1.2 || o.t > duration - 0.5) continue;
    const p = Math.min(1, o.t / duration);
    const ramp = easeInOut(p);
    // Density follows both song progress and the music's local energy.
    const drive = driveAt(o.t, p);

    const minGap = (0.42 - 0.28 * drive) * gapScale; // sparse when quiet/early → dense at the drop
    if (o.t - lastT < minGap) continue;

    const cut = quantile((0.55 * (1 - drive)) / flourishMul);
    if (o.strength < cut) continue;

    const next = onsets[i + 1];
    const gapToNext = next ? next.t - o.t : Infinity;

    // --- Stream: a run of rapid onsets (fills, rolls) becomes a burst of
    // alternating tiles riding the actual hits. Late-game only.
    if (p > 0.5 && gapToNext <= 0.24 && rng() < (0.12 + 0.3 * drive) * flourishMul) {
      let run = 1;
      while (
        i + run < onsets.length &&
        onsets[i + run].t - onsets[i + run - 1].t <= 0.24 &&
        run < 4 + Math.floor(ramp * 4)
      ) {
        run++;
      }
      if (run >= 4) {
        let lane = pickLane(o, o.t - lastT);
        const dir = rng() < 0.5 ? 1 : 2;
        for (let k = 0; k < run; k++) {
          const on = onsets[i + k];
          if (on.t > duration - 0.5) break;
          notes.push({ t: snap(on.t), lane });
          lane = (lane + dir) % 3;
        }
        lastT = onsets[i + run - 1].t;
        lastLane = -1;
        laneStreak = 0;
        i += run - 1;
        continue;
      }
    }

    // --- Double-tap: the music really has two quick hits (a flam / echo
    // pair) — one tile that wants two taps. From 30% progress.
    if (
      p > 0.3 &&
      next &&
      gapToNext > 0.11 &&
      gapToNext < 0.3 &&
      o.strength >= quantile(0.45) &&
      next.strength >= quantile(0.35) &&
      o.t - lastT >= minGap * 1.25 &&
      rng() < (0.25 + 0.35 * drive) * flourishMul
    ) {
      const lane = pickLane(o, o.t - lastT);
      notes.push({ t: snap(o.t), lane, kind: 'double' });
      lastT = next.t;
      lastLane = lane;
      i++; // the second hit is consumed by this tile
      continue;
    }

    // --- Hold: a notable hit at the start of a sustained loud stretch —
    // press and ride it while the music carries (onsets underneath are
    // consumed by the hold). From 15% progress, as an occasional flourish.
    if (
      p > 0.15 &&
      o.strength >= quantile(0.55) &&
      o.t - lastT >= minGap * 1.5 &&
      envMean(o.t + 0.1, o.t + 0.9) > 0.4 &&
      rng() < 0.14 + 0.22 * ramp
    ) {
      // Extend the tail while the loudness keeps up (max 2.4 s).
      let dur = 0.7;
      while (dur < 2.4 && envAt(o.t + dur + 0.15) > 0.35) dur += 0.1;
      dur = Math.min(dur, duration - 0.4 - o.t);
      if (dur >= 0.6) {
        const lane = pickLane(o, o.t - lastT);
        notes.push({ t: snap(o.t), lane, kind: 'hold', dur });
        lastT = o.t + dur + 0.1; // onsets during the hold are skipped
        lastLane = lane;
        continue;
      }
    }

    // --- Bonus gem: a rare, extra-shiny tile on an accented hit, worth big
    // points. At most one every ~8 seconds.
    const lane = pickLane(o, o.t - lastT);
    if (
      o.strength >= quantile(0.8) &&
      o.t - lastBonusT >= 8 &&
      o.t - lastT >= minGap * 1.4 &&
      rng() < 0.35
    ) {
      notes.push({ t: snap(o.t), lane, kind: 'bonus' });
      lastBonusT = o.t;
      lastT = o.t;
      lastLane = lane;
      continue;
    }

    // --- Plain tap (+ chord on strong hits after 30%, preferring downbeats).
    notes.push({ t: snap(o.t), lane });

    const chordChance = p > 0.3 ? (0.1 + 0.4 * drive) * flourishMul : 0;
    if (
      chordChance > 0 &&
      o.strength >= quantile(0.75) &&
      (onBeat(o.t) || o.strength >= quantile(0.92)) &&
      o.t - lastT >= minGap * 1.6 &&
      rng() < chordChance
    ) {
      const offsets = [1, 2];
      const second = (lane + offsets[Math.floor(rng() * 2)]) % 3;
      notes.push({ t: snap(o.t), lane: second });
    }

    lastT = o.t;
    lastLane = lane;
  }

  return notes;
}
