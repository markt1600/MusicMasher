/**
 * Procedurally synthesized demo track ("Neon Dreams"), so the game is
 * playable with zero uploads and no bundled (copyrighted) audio files.
 *
 * Samples are computed directly in JavaScript rather than rendered through
 * an OfflineAudioContext graph: offline rendering has cross-browser quirks
 * that can hang forever with no error, while plain math runs identically
 * everywhere. It's also fully deterministic (seeded noise), so every player
 * hears the same render and gets the same chart. The arrangement builds in
 * intensity so the difficulty ramp is easy to feel.
 */

const SR = 44100;
const BPM = 122;
const BEAT = 60 / BPM;
const BARS = 48; // 4 beats per bar ≈ 94.4 s
const TAU = Math.PI * 2;

export const DEMO_SONG = {
  id: 'demo',
  title: 'Neon Dreams (Demo)',
  duration: Math.round(BARS * 4 * BEAT + 2),
};

// A minor progression: Am, F, C, G (roots per bar)
const BASS_ROOTS = [110.0, 87.31, 130.81, 98.0]; // A2 F2 C3 G2
// A minor pentatonic pool for the lead arp
const PENTA = [440.0, 523.25, 587.33, 659.25, 783.99, 880.0];

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

// Rendered once per page session — replays and revisits are instant.
let demoCache: AudioBuffer | null = null;

export async function getDemoSong(
  ctx: BaseAudioContext,
  onProgress?: (p: number) => void
): Promise<AudioBuffer> {
  if (!demoCache) demoCache = await renderDemoSong(ctx, onProgress);
  return demoCache;
}

export async function renderDemoSong(
  ctx: BaseAudioContext,
  onProgress?: (p: number) => void
): Promise<AudioBuffer> {
  const duration = BARS * 4 * BEAT + 2;
  const N = Math.ceil(SR * duration);
  const mix = new Float32Array(N);
  const leadBus = new Float32Array(N); // lead goes through an echo pass
  const rng = mulberry32(0xc0ffee);

  const kick = (at: number, level = 1) => {
    const start = Math.floor(at * SR);
    const len = Math.floor(0.3 * SR);
    let phase = 0;
    for (let i = 0; i < len && start + i < N; i++) {
      const t = i / SR;
      const f = 42 + 110 * Math.exp(-t * 12); // 150 Hz dropping to 42 Hz
      phase += (TAU * f) / SR;
      mix[start + i] += Math.sin(phase) * 0.85 * level * Math.exp(-t * 13);
    }
  };

  const hat = (at: number, open = false, level = 1) => {
    const start = Math.floor(at * SR);
    const len = Math.floor((open ? 0.15 : 0.05) * SR);
    let prev = 0;
    for (let i = 0; i < len && start + i < N; i++) {
      const t = i / SR;
      const w = rng() * 2 - 1;
      // differentiated noise ≈ highpassed hiss
      mix[start + i] += (w - prev) * 0.3 * level * Math.exp(-t * (open ? 28 : 85));
      prev = w;
    }
  };

  const snare = (at: number, level = 1) => {
    const start = Math.floor(at * SR);
    const len = Math.floor(0.2 * SR);
    for (let i = 0; i < len && start + i < N; i++) {
      const t = i / SR;
      const w = rng() * 2 - 1;
      // noise ring-modulated toward ~1.9 kHz (bandpass-ish) + 185 Hz body
      mix[start + i] +=
        (w * Math.sin(TAU * 1900 * t) * 0.8 + w * 0.25) * 0.5 * level * Math.exp(-t * 26) +
        Math.sin(TAU * 185 * t) * 0.28 * level * Math.exp(-t * 45);
    }
  };

  const bass = (at: number, freq: number, dur: number, level = 1) => {
    const start = Math.floor(at * SR);
    const len = Math.floor((dur + 0.03) * SR);
    // lowpassed saw: first 5 harmonics rolled off above ~500 Hz
    const amps: number[] = [];
    for (let k = 1; k <= 5; k++) {
      amps.push(1 / k / (1 + ((k * freq) / 500) ** 2));
    }
    for (let i = 0; i < len && start + i < N; i++) {
      const t = i / SR;
      const attack = Math.min(1, t * 200);
      const release = t > dur - 0.05 ? Math.max(0, (dur + 0.03 - t) / 0.08) : 1;
      let s = 0;
      for (let k = 1; k <= 5; k++) s += amps[k - 1] * Math.sin(TAU * k * freq * t);
      mix[start + i] += s * 0.38 * level * attack * release;
    }
  };

  const lead = (at: number, freq: number, dur: number, level = 1) => {
    const start = Math.floor(at * SR);
    const len = Math.floor((dur + 0.05) * SR);
    const decay = Math.log(120) / (dur + 0.05);
    for (let i = 0; i < len && start + i < N; i++) {
      const t = i / SR;
      const env = Math.exp(-t * decay) * Math.min(1, t * 400);
      let s = 0;
      for (const detune of [0.9965, 1.0035]) {
        const x = TAU * freq * detune * t;
        // square-ish: odd harmonics
        s += Math.sin(x) + 0.33 * Math.sin(3 * x) + 0.2 * Math.sin(5 * x);
      }
      leadBus[start + i] += s * 0.065 * level * env;
    }
  };

  // --- arrangement (identical structure to the original graph version) -----
  let arpStep = 0;
  for (let bar = 0; bar < BARS; bar++) {
    const t0 = 0.5 + bar * 4 * BEAT;
    const root = BASS_ROOTS[bar % 4];
    const sect = bar / BARS; // 0..1 build

    for (let b = 0; b < 4; b++) {
      const tb = t0 + b * BEAT;

      // Kick: four-on-the-floor from bar 2
      if (bar >= 2) kick(tb);
      else if (b === 0 || b === 2) kick(tb, 0.8);

      // Bass: eighths, denser later
      if (bar >= 1) {
        bass(tb, root, BEAT * 0.45);
        if (sect > 0.25) bass(tb + BEAT / 2, root * (b === 3 ? 1.5 : 1), BEAT * 0.4, 0.8);
      }

      // Hats: offbeats from bar 6, sixteenths late in the song
      if (bar >= 6) {
        hat(tb + BEAT / 2, b === 3 && bar % 4 === 3);
        if (sect > 0.55) {
          hat(tb + BEAT / 4, false, 0.6);
          hat(tb + (3 * BEAT) / 4, false, 0.6);
        }
      }

      // Snare on 2 and 4 from bar 10
      if (bar >= 10 && (b === 1 || b === 3)) snare(tb);

      // Lead arp from bar 14: eighths, then sixteenths past 65%
      if (bar >= 14) {
        const div = sect > 0.65 ? 4 : 2;
        for (let s = 0; s < div; s++) {
          const noteFreq = PENTA[(arpStep * 3 + bar) % PENTA.length];
          lead(tb + (s * BEAT) / div, noteFreq, BEAT / div + 0.05, sect > 0.65 ? 0.9 : 1);
          arpStep++;
        }
      }
    }

    // Snare fill at the end of every 8th bar late in the song
    if (sect > 0.5 && bar % 8 === 7) {
      for (let s = 0; s < 4; s++) {
        snare(t0 + 3 * BEAT + (s * BEAT) / 4, 0.5 + s * 0.12);
      }
    }

    if ((bar & 3) === 3) {
      onProgress?.(bar / BARS);
      await new Promise<void>((r) => setTimeout(r, 0)); // keep the UI alive
    }
  }

  // --- echo on the lead bus, then mixdown with a soft clip ------------------
  const d = Math.floor(BEAT * 0.75 * SR);
  for (let i = d; i < N; i++) leadBus[i] += leadBus[i - d] * 0.32;
  for (let i = 0; i < N; i++) {
    mix[i] = Math.tanh((mix[i] + leadBus[i]) * 1.15) * 0.92;
  }
  onProgress?.(1);

  const buffer = ctx.createBuffer(1, N, SR);
  buffer.getChannelData(0).set(mix);
  return buffer;
}
