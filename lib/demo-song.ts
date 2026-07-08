/**
 * Procedurally synthesized demo track ("Neon Dreams") rendered with an
 * OfflineAudioContext, so the game is playable with zero uploads and no
 * bundled (copyrighted) audio files. The arrangement deliberately builds in
 * intensity so the difficulty ramp is easy to feel.
 */

export const DEMO_SONG = {
  id: 'demo',
  title: 'Neon Dreams (Demo)',
  duration: 96,
};

const BPM = 122;
const BEAT = 60 / BPM;
const BARS = 48; // 4 beats per bar ≈ 94.4 s
const SR = 44100;

// A minor progression: Am, F, C, G (roots per bar)
const BASS_ROOTS = [110.0, 87.31, 130.81, 98.0]; // A2 F2 C3 G2
// A minor pentatonic pool for the lead arp
const PENTA = [440.0, 523.25, 587.33, 659.25, 783.99, 880.0];

export async function renderDemoSong(): Promise<AudioBuffer> {
  const duration = BARS * 4 * BEAT + 2;
  const ctx = new OfflineAudioContext(2, Math.ceil(SR * duration), SR);

  const master = ctx.createGain();
  master.gain.value = 0.75;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 4;
  master.connect(comp);
  comp.connect(ctx.destination);

  // Shared noise buffer for drums
  const noiseBuf = ctx.createBuffer(1, SR, SR);
  const nd = noiseBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

  // Echo bus for the lead
  const echo = ctx.createDelay(1);
  echo.delayTime.value = BEAT * 0.75;
  const echoFb = ctx.createGain();
  echoFb.gain.value = 0.3;
  const echoWet = ctx.createGain();
  echoWet.gain.value = 0.22;
  echo.connect(echoFb);
  echoFb.connect(echo);
  echo.connect(echoWet);
  echoWet.connect(master);

  const kick = (t: number, level = 1) => {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.11);
    g.gain.setValueAtTime(0.9 * level, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.26);
    osc.connect(g);
    g.connect(master);
    osc.start(t);
    osc.stop(t + 0.3);
  };

  const hat = (t: number, open = false, level = 1) => {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7500;
    const g = ctx.createGain();
    const dur = open ? 0.14 : 0.04;
    g.gain.setValueAtTime(0.22 * level, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(hp);
    hp.connect(g);
    g.connect(master);
    src.start(t, Math.random(), dur + 0.05);
  };

  const snare = (t: number, level = 1) => {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1900;
    bp.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5 * level, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    src.connect(bp);
    bp.connect(g);
    g.connect(master);
    src.start(t, Math.random(), 0.2);

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 185;
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.25 * level, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    osc.connect(og);
    og.connect(master);
    osc.start(t);
    osc.stop(t + 0.1);
  };

  const bass = (t: number, freq: number, dur: number, level = 1) => {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(90, t);
    lp.frequency.exponentialRampToValueAtTime(600, t + 0.05);
    lp.frequency.exponentialRampToValueAtTime(120, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.28 * level, t);
    g.gain.setValueAtTime(0.28 * level, t + dur - 0.05);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(lp);
    lp.connect(g);
    g.connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  };

  const lead = (t: number, freq: number, dur: number, level = 1) => {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.11 * level, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3200;
    for (const detune of [-6, 6]) {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = freq;
      osc.detune.value = detune;
      osc.connect(lp);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    }
    lp.connect(g);
    g.connect(master);
    g.connect(echo);
  };

  // --- arrangement -----------------------------------------------------------
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
  }

  return ctx.startRendering();
}
