import type { Beatmap, GameStats, Judgement, Note } from '../types';

/**
 * Pseudo-3D rhythm game engine on a 2D canvas.
 *
 * World model: a 3-lane road recedes from the hit line (bottom of screen)
 * toward a vanishing point on the horizon. A note at song time `t` sits at
 * normalized distance d = (t - songTime) / approachTime; perspective
 * projection maps d → screen position/scale. The AudioContext clock is the
 * single source of truth for timing, so visuals, judging and music can
 * never drift apart.
 */

const LANES = 3;
const NEAR = 1;
const SPAN = 7; // world depth units per approach-time
const TILE_LEN = 0.085; // tile depth in d-units
const LEAD_IN = 2.4; // seconds of countdown before audio starts

const WINDOW_PERFECT = 0.065;
const WINDOW_GREAT = 0.13;
const WINDOW_GOOD = 0.19;

const SCORE_VALUE: Record<Exclude<Judgement, 'miss'>, number> = {
  perfect: 100,
  great: 60,
  good: 30,
};

const JUDGE_LABEL: Record<Judgement, string> = {
  perfect: 'PERFECT',
  great: 'GREAT',
  good: 'GOOD',
  miss: 'MISS',
};

const JUDGE_COLOR: Record<Judgement, string> = {
  perfect: '#7dfff2',
  great: '#7dc4ff',
  good: '#e0d17d',
  miss: '#ff5d7d',
};

interface ActiveNote extends Note {
  judged: Judgement | null;
  judgedAt: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  hue: number;
}

interface Ring {
  lane: number;
  born: number;
  color: string;
  ghost: boolean;
}

interface FloatText {
  lane: number;
  born: number;
  text: string;
  color: string;
}

export interface EngineCallbacks {
  onEnd: (stats: GameStats) => void;
  onPauseRequest: () => void;
}

function easeInOut(x: number): number {
  return x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2;
}

function easeOutCubic(x: number): number {
  return 1 - (1 - x) ** 3;
}

export class Engine {
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private audioCtx: AudioContext;
  private buffer: AudioBuffer;
  private map: Beatmap;
  private cb: EngineCallbacks;
  private title: string;

  private notes: ActiveNote[] = [];
  private nextJudgeIdx = 0; // per-lane search start optimization base
  private source: AudioBufferSourceNode | null = null;
  private startCtxTime = 0;
  private raf = 0;
  private destroyed = false;
  private ended = false;
  private paused = false;

  offsetMs = 0;

  // scoring
  private score = 0;
  private shownScore = 0;
  private combo = 0;
  private maxCombo = 0;
  private counts: Record<Judgement, number> = { perfect: 0, great: 0, good: 0, miss: 0 };
  private lastComboChange = -10;
  private lastMissAt = -10;

  // effects
  private particles: Particle[] = [];
  private rings: Ring[] = [];
  private texts: FloatText[] = [];
  private pressUntil = new Float64Array(LANES);

  // layout (recomputed on resize)
  private w = 0;
  private h = 0;
  private dpr = 1;
  private cx = 0;
  private horizonY = 0;
  private hitY = 0;
  private roadHalf = 0;
  private laneW = 0;

  // scenery
  private stars: { x: number; y: number; r: number; phase: number }[] = [];
  private mountains: Path2D[] = [];
  private resizeObserver: ResizeObserver | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    audioCtx: AudioContext,
    buffer: AudioBuffer,
    map: Beatmap,
    title: string,
    cb: EngineCallbacks
  ) {
    this.canvas = canvas;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('Canvas 2D context unavailable');
    this.g = g;
    this.audioCtx = audioCtx;
    this.buffer = buffer;
    this.map = map;
    this.title = title;
    this.cb = cb;
    this.notes = [...map.notes]
      .sort((a, b) => a.t - b.t)
      .map((n) => ({ ...n, judged: null, judgedAt: 0 }));

    this.handleResize();
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(canvas);

    canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('keydown', this.onKeyDown);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start(): void {
    const src = this.audioCtx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.audioCtx.destination);
    this.startCtxTime = this.audioCtx.currentTime + LEAD_IN;
    src.start(this.startCtxTime);
    this.source = src;
    this.loop();
  }

  pause(): void {
    if (this.paused || this.ended || this.destroyed) return;
    this.paused = true;
    void this.audioCtx.suspend();
    cancelAnimationFrame(this.raf);
  }

  resume(): void {
    if (!this.paused || this.destroyed) return;
    this.paused = false;
    void this.audioCtx.resume();
    this.loop();
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    try {
      this.source?.stop();
    } catch {
      // already stopped
    }
    this.source?.disconnect();
    this.resizeObserver?.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('keydown', this.onKeyDown);
  }

  private songTime(): number {
    return this.audioCtx.currentTime - this.startCtxTime;
  }

  private stats(): GameStats {
    return {
      score: Math.round(this.score),
      maxCombo: this.maxCombo,
      perfect: this.counts.perfect,
      great: this.counts.great,
      good: this.counts.good,
      miss: this.counts.miss,
      totalNotes: this.notes.length,
    };
  }

  // -------------------------------------------------------------------------
  // Difficulty ramp: scroll speeds up over the song
  // -------------------------------------------------------------------------

  private approachAt(t: number): number {
    const p = Math.min(1, Math.max(0, t / this.map.duration));
    return 1.95 - 0.7 * easeInOut(p);
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  private onPointerDown = (e: PointerEvent) => {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * this.w;
    const y = ((e.clientY - rect.top) / rect.height) * this.h;
    // pause button (top-right)
    if (x > this.w - 64 && y < 64) {
      if (!this.paused && !this.ended) {
        this.pause();
        this.cb.onPauseRequest();
      }
      return;
    }
    if (this.paused || this.ended) return;
    const lane = Math.max(0, Math.min(LANES - 1, Math.floor((x / this.w) * LANES)));
    this.tapLane(lane);
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    if (k === 'escape' || k === 'p') {
      if (!this.paused && !this.ended) {
        this.pause();
        this.cb.onPauseRequest();
      }
      return;
    }
    if (this.paused || this.ended) return;
    let lane = -1;
    if (k === 'a' || k === 'j' || k === 'arrowleft' || k === '1') lane = 0;
    else if (k === 's' || k === 'k' || k === 'arrowdown' || k === '2') lane = 1;
    else if (k === 'd' || k === 'l' || k === 'arrowright' || k === '3') lane = 2;
    if (lane >= 0) {
      e.preventDefault();
      this.tapLane(lane);
    }
  };

  private tapLane(lane: number): void {
    const now = performance.now();
    this.pressUntil[lane] = now + 130;
    const t = this.songTime() - this.offsetMs / 1000;

    // Find the closest unjudged note in this lane within the good window.
    let best: ActiveNote | null = null;
    let bestAbs = Infinity;
    for (let i = this.nextJudgeIdx; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.t > t + WINDOW_GOOD + 0.05) break;
      if (n.judged || n.lane !== lane) continue;
      const abs = Math.abs(n.t - t);
      if (abs <= WINDOW_GOOD && abs < bestAbs) {
        best = n;
        bestAbs = abs;
      }
    }

    if (!best) {
      // Ghost tap: gentle feedback, no penalty.
      this.rings.push({ lane, born: now, color: 'rgba(255,255,255,0.25)', ghost: true });
      return;
    }

    const judgement: Judgement =
      bestAbs <= WINDOW_PERFECT ? 'perfect' : bestAbs <= WINDOW_GREAT ? 'great' : 'good';
    this.judge(best, judgement);
  }

  private judge(note: ActiveNote, j: Judgement): void {
    note.judged = j;
    note.judgedAt = performance.now();
    this.counts[j]++;

    if (j === 'miss') {
      this.combo = 0;
      this.lastComboChange = note.judgedAt;
      this.lastMissAt = note.judgedAt;
    } else {
      this.combo++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      this.lastComboChange = note.judgedAt;
      const mult = 1 + Math.min(this.combo, 100) / 100;
      this.score += SCORE_VALUE[j] * mult;
      this.spawnHitEffects(note.lane, j);
    }
    this.texts.push({
      lane: note.lane,
      born: note.judgedAt,
      text: JUDGE_LABEL[j],
      color: JUDGE_COLOR[j],
    });
  }

  private spawnHitEffects(lane: number, j: Judgement): void {
    const now = performance.now();
    this.rings.push({ lane, born: now, color: JUDGE_COLOR[j], ghost: false });
    const x = this.laneX(lane, 1);
    const count = j === 'perfect' ? 16 : j === 'great' ? 10 : 6;
    const hue = j === 'perfect' ? 172 : j === 'great' ? 210 : 55;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.5 + Math.random()) * this.w * 0.004;
      this.particles.push({
        x,
        y: this.hitY,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - this.w * 0.003,
        life: 0,
        maxLife: 500 + Math.random() * 350,
        size: (2 + Math.random() * 3.5) * this.dpr,
        hue: hue + Math.random() * 30 - 15,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Projection helpers
  // -------------------------------------------------------------------------

  private proj(d: number): number {
    return NEAR / (NEAR + Math.max(d, -0.06) * SPAN);
  }

  private yAt(proj: number): number {
    return this.horizonY + (this.hitY - this.horizonY) * proj;
  }

  private laneX(lane: number, proj: number): number {
    return this.cx + (lane - 1) * this.laneW * proj;
  }

  // -------------------------------------------------------------------------
  // Layout & scenery
  // -------------------------------------------------------------------------

  private handleResize(): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.round(rect.width * this.dpr);
    this.h = Math.round(rect.height * this.dpr);
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.cx = this.w / 2;
    this.horizonY = this.h * 0.3;
    this.hitY = this.h * 0.8;
    this.roadHalf = Math.min(this.w * 0.44, this.h * 0.36);
    this.laneW = (this.roadHalf * 2) / LANES;
    this.buildScenery();
    if (this.paused) this.render(); // keep a fresh frame behind pause overlay
  }

  private buildScenery(): void {
    const rng = mulberry32Local(42);
    this.stars = [];
    const starCount = 90;
    for (let i = 0; i < starCount; i++) {
      this.stars.push({
        x: rng() * this.w,
        y: rng() * this.horizonY * 0.95,
        r: (0.5 + rng() * 1.3) * this.dpr,
        phase: rng() * Math.PI * 2,
      });
    }
    // Two silhouette mountain layers.
    this.mountains = [];
    for (let layer = 0; layer < 2; layer++) {
      const path = new Path2D();
      const base = this.horizonY + this.h * 0.002;
      const amp = this.h * (layer === 0 ? 0.085 : 0.05);
      path.moveTo(0, base);
      const segs = 9 + layer * 4;
      for (let i = 0; i <= segs; i++) {
        const x = (i / segs) * this.w;
        const y = base - Math.abs(Math.sin(i * (2.3 + layer) + layer * 7)) * amp * (0.4 + rng() * 0.6);
        path.lineTo(x, y);
      }
      path.lineTo(this.w, base);
      path.closePath();
      this.mountains.push(path);
    }
  }

  // -------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------

  private loop = (): void => {
    if (this.destroyed || this.paused) return;
    this.update();
    this.render();
    if (!this.ended) this.raf = requestAnimationFrame(this.loop);
  };

  private update(): void {
    const t = this.songTime() - this.offsetMs / 1000;

    // Auto-miss notes that scrolled past the window.
    for (let i = this.nextJudgeIdx; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.t > t - WINDOW_GOOD) break;
      if (!n.judged) this.judge(n, 'miss');
    }
    // Advance the search base past fully-judged prefix.
    while (this.nextJudgeIdx < this.notes.length && this.notes[this.nextJudgeIdx].judged) {
      this.nextJudgeIdx++;
    }

    // Rolling score display.
    this.shownScore += (this.score - this.shownScore) * 0.14;
    if (Math.abs(this.score - this.shownScore) < 1) this.shownScore = this.score;

    // Particles.
    const grav = this.h * 0.00012;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life += 16.7;
      p.x += p.vx;
      p.y += p.vy;
      p.vy += grav;
      if (p.life >= p.maxLife) this.particles.splice(i, 1);
    }
    const now = performance.now();
    this.rings = this.rings.filter((r) => now - r.born < 450);
    this.texts = this.texts.filter((tx) => now - tx.born < 700);

    // Song end.
    if (!this.ended && this.songTime() > this.map.duration + 0.6) {
      this.ended = true;
      cancelAnimationFrame(this.raf);
      this.cb.onEnd(this.stats());
    }
  }

  private envAt(t: number): number {
    if (t < 0) return 0;
    const idx = Math.floor(t * this.map.envelopeRate);
    return idx < this.map.envelope.length ? this.map.envelope[idx] : 0;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private render(): void {
    const g = this.g;
    const t = this.songTime();
    const prog = Math.min(1, Math.max(0, t / this.map.duration));
    const env = this.envAt(t);
    const now = performance.now();
    // Base hue drifts teal → violet → pink as the song intensifies.
    const hue = 178 + prog * 110;

    this.drawBackground(g, t, hue, env);
    this.drawRoad(g, t, hue, env, prog);
    this.drawNotes(g, t, hue);
    this.drawHitLine(g, hue, now);
    this.drawEffects(g, now);
    this.drawHUD(g, t, prog, now, hue);
  }

  private drawBackground(
    g: CanvasRenderingContext2D,
    t: number,
    hue: number,
    env: number
  ): void {
    const { w, h, horizonY, cx } = this;
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, `hsl(${hue + 60}, 45%, 5%)`);
    sky.addColorStop(0.45, `hsl(${hue + 30}, 55%, 11%)`);
    sky.addColorStop(0.62, `hsl(${hue}, 60%, 16%)`);
    sky.addColorStop(1, `hsl(${hue + 40}, 50%, 7%)`);
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);

    // Stars
    g.save();
    for (const s of this.stars) {
      const tw = 0.35 + 0.65 * Math.abs(Math.sin(t * 1.7 + s.phase));
      g.globalAlpha = tw * 0.8;
      g.fillStyle = '#dff6ff';
      g.beginPath();
      g.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();

    // Sun/moon glow on the horizon, pulsing with the music.
    const sunR = (this.h * 0.11) * (1 + env * 0.16);
    const sun = g.createRadialGradient(cx, horizonY, sunR * 0.1, cx, horizonY, sunR * 2.6);
    sun.addColorStop(0, `hsla(${hue}, 100%, 78%, 0.95)`);
    sun.addColorStop(0.25, `hsla(${hue}, 95%, 62%, 0.5)`);
    sun.addColorStop(1, 'hsla(0, 0%, 0%, 0)');
    g.fillStyle = sun;
    g.fillRect(cx - sunR * 3, horizonY - sunR * 3, sunR * 6, sunR * 6);

    // Mountain silhouettes
    g.fillStyle = `hsl(${hue + 45}, 45%, 6%)`;
    g.fill(this.mountains[0]);
    g.fillStyle = `hsl(${hue + 45}, 40%, 9%)`;
    g.fill(this.mountains[1]);

    // Rising fireflies
    g.save();
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 14; i++) {
      const seed = i * 137.5;
      const speed = 18 + (i % 5) * 7;
      const fy = this.h - (((t * speed + seed * 13) % (this.h * 1.2)) );
      const fx = (seed * 7.3) % w + Math.sin(t * 0.9 + i) * w * 0.02;
      const alpha = 0.12 + 0.1 * Math.sin(t * 2 + i * 2.1);
      if (fy < horizonY || alpha <= 0) continue;
      g.globalAlpha = alpha;
      g.fillStyle = `hsl(${hue - 20}, 100%, 70%)`;
      g.beginPath();
      g.arc(fx, fy, (1.5 + (i % 3)) * this.dpr, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }

  private drawRoad(
    g: CanvasRenderingContext2D,
    t: number,
    hue: number,
    env: number,
    prog: number
  ): void {
    const { cx, horizonY, hitY, roadHalf, h } = this;
    const bottomProj = this.proj(-0.1); // road extends past the hit line
    const bottomY = this.yAt(bottomProj);
    const bottomHalf = roadHalf * bottomProj;

    // Road body: dark glassy wedge to the vanishing point.
    g.save();
    const roadGrad = g.createLinearGradient(0, horizonY, 0, h);
    roadGrad.addColorStop(0, `hsla(${hue}, 70%, 30%, 0.10)`);
    roadGrad.addColorStop(0.6, `hsla(${hue + 20}, 55%, 12%, 0.55)`);
    roadGrad.addColorStop(1, `hsla(${hue + 20}, 55%, 8%, 0.8)`);
    g.fillStyle = roadGrad;
    g.beginPath();
    g.moveTo(cx, horizonY);
    g.lineTo(cx - bottomHalf, bottomY);
    g.lineTo(cx + bottomHalf, bottomY);
    g.closePath();
    g.fill();

    // Horizontal beat grid rushing toward the player.
    const speed = 0.55; // d-units per second equivalent
    g.strokeStyle = `hsla(${hue}, 90%, 60%, 0.5)`;
    for (let k = 0; k < 12; k++) {
      const dLine = ((k * 0.14 - t * speed * 0.14) % 1.68 + 1.68) % 1.68 - 0.1;
      if (dLine < -0.1 || dLine > 1.4) continue;
      const pr = this.proj(dLine);
      const y = this.yAt(pr);
      const half = roadHalf * pr;
      g.globalAlpha = Math.min(0.5, pr * 0.55) * (0.5 + env * 0.5);
      g.lineWidth = Math.max(1, 1.6 * pr * this.dpr);
      g.beginPath();
      g.moveTo(cx - half, y);
      g.lineTo(cx + half, y);
      g.stroke();
    }
    g.globalAlpha = 1;

    // Lane dividers.
    g.strokeStyle = `hsla(${hue}, 80%, 65%, 0.35)`;
    g.lineWidth = 1 * this.dpr;
    for (let lane = 0; lane <= LANES; lane++) {
      const off = (lane - LANES / 2) * this.laneW;
      g.beginPath();
      g.moveTo(cx, horizonY);
      g.lineTo(cx + off * bottomProj, bottomY);
      g.stroke();
    }

    // Glowing road edges (brighter with the beat and as the song ramps up).
    const edgeGlow = 0.55 + env * 0.45 + prog * 0.2;
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = `hsla(${hue}, 100%, 62%, ${Math.min(1, edgeGlow)})`;
    g.lineWidth = 3 * this.dpr;
    for (const side of [-1, 1]) {
      g.beginPath();
      g.moveTo(cx, horizonY);
      g.lineTo(cx + side * bottomHalf, bottomY);
      g.stroke();
    }
    g.restore();

    // Vignette bottom so tiles pop.
    const vig = g.createLinearGradient(0, hitY, 0, h);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.45)');
    g.fillStyle = vig;
    g.fillRect(0, hitY, this.w, h - hitY);
  }

  private drawNotes(g: CanvasRenderingContext2D, t: number, hue: number): void {
    const tJudge = t - this.offsetMs / 1000;
    const approach = this.approachAt(Math.max(0, t));

    g.save();
    for (const n of this.notes) {
      const d = (n.t - tJudge) / approach;
      if (d > 1.05) break; // notes sorted by time; rest are farther out
      if (d < -0.12) continue;
      if (n.judged && n.judged !== 'miss') {
        // brief shrink-out at the hit line
        const age = (performance.now() - n.judgedAt) / 160;
        if (age >= 1) continue;
        const pr = this.proj(0);
        this.drawTile(g, n.lane, pr, this.proj(TILE_LEN), hue, 1 - age, 1 + age * 0.4);
        continue;
      }
      const missed = n.judged === 'miss';
      const prNear = this.proj(d);
      const prFar = this.proj(d + TILE_LEN);
      const alpha = missed ? Math.max(0, 0.7 - (performance.now() - n.judgedAt) / 280) : 1;
      if (alpha <= 0) continue;
      this.drawTile(g, n.lane, prNear, prFar, missed ? -40 : hue, alpha, 1, missed);
    }
    g.restore();
  }

  private drawTile(
    g: CanvasRenderingContext2D,
    lane: number,
    prNear: number,
    prFar: number,
    hue: number,
    alpha: number,
    scale = 1,
    missed = false
  ): void {
    const yN = this.yAt(prNear);
    const yF = this.yAt(prFar);
    const cxN = this.laneX(lane, prNear);
    const cxF = this.laneX(lane, prFar);
    const halfN = this.laneW * 0.42 * prNear * scale;
    const halfF = this.laneW * 0.42 * prFar * scale;

    g.globalAlpha = alpha;

    // Under-glow
    g.save();
    g.globalCompositeOperation = 'lighter';
    const glowR = halfN * 1.7;
    if (glowR > 1) {
      const glow = g.createRadialGradient(cxN, (yN + yF) / 2, glowR * 0.15, cxN, (yN + yF) / 2, glowR);
      glow.addColorStop(0, `hsla(${hue}, 100%, 65%, ${0.5 * alpha})`);
      glow.addColorStop(1, 'hsla(0,0%,0%,0)');
      g.fillStyle = glow;
      g.fillRect(cxN - glowR, (yN + yF) / 2 - glowR, glowR * 2, glowR * 2);
    }
    g.restore();
    g.globalAlpha = alpha;

    // Tile body (trapezoid in perspective)
    const grad = g.createLinearGradient(0, yF, 0, yN);
    if (missed) {
      grad.addColorStop(0, 'hsla(350, 90%, 45%, 0.9)');
      grad.addColorStop(1, 'hsla(350, 95%, 60%, 0.95)');
    } else {
      grad.addColorStop(0, `hsla(${hue}, 95%, 46%, 0.95)`);
      grad.addColorStop(0.55, `hsla(${hue}, 100%, 62%, 0.97)`);
      grad.addColorStop(1, `hsla(${hue - 25}, 100%, 82%, 1)`);
    }
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(cxF - halfF, yF);
    g.lineTo(cxF + halfF, yF);
    g.lineTo(cxN + halfN, yN);
    g.lineTo(cxN - halfN, yN);
    g.closePath();
    g.fill();
    g.strokeStyle = missed
      ? 'hsla(350, 100%, 75%, 0.9)'
      : `hsla(${hue - 30}, 100%, 85%, 0.9)`;
    g.lineWidth = Math.max(1, 1.5 * prNear * this.dpr);
    g.stroke();

    // Inner shine strip
    if (!missed && halfN > 6) {
      g.globalAlpha = alpha * 0.5;
      g.fillStyle = `hsla(${hue - 40}, 100%, 90%, 0.8)`;
      g.beginPath();
      g.moveTo(cxF - halfF * 0.55, yF + (yN - yF) * 0.15);
      g.lineTo(cxF - halfF * 0.2, yF + (yN - yF) * 0.15);
      g.lineTo(cxN - halfN * 0.2, yN - (yN - yF) * 0.12);
      g.lineTo(cxN - halfN * 0.55, yN - (yN - yF) * 0.12);
      g.closePath();
      g.fill();
    }
    g.globalAlpha = 1;
  }

  private drawHitLine(g: CanvasRenderingContext2D, hue: number, now: number): void {
    const { cx, hitY, roadHalf, laneW } = this;

    // Bar across the road
    g.save();
    g.globalCompositeOperation = 'lighter';
    const barGrad = g.createLinearGradient(cx - roadHalf, 0, cx + roadHalf, 0);
    barGrad.addColorStop(0, 'hsla(0,0%,100%,0)');
    barGrad.addColorStop(0.5, `hsla(${hue}, 100%, 75%, 0.75)`);
    barGrad.addColorStop(1, 'hsla(0,0%,100%,0)');
    g.strokeStyle = barGrad;
    g.lineWidth = 2.5 * this.dpr;
    g.beginPath();
    g.moveTo(cx - roadHalf * 1.02, hitY);
    g.lineTo(cx + roadHalf * 1.02, hitY);
    g.stroke();
    g.restore();

    // Lane pads
    for (let lane = 0; lane < LANES; lane++) {
      const x = this.laneX(lane, 1);
      const pressed = now < this.pressUntil[lane];
      const r = laneW * 0.3 * (pressed ? 1.12 : 1);
      g.save();
      g.globalCompositeOperation = 'lighter';
      const pad = g.createRadialGradient(x, hitY, r * 0.1, x, hitY, r * 1.5);
      const inner = pressed ? 0.95 : 0.4;
      pad.addColorStop(0, `hsla(${hue}, 100%, 80%, ${inner})`);
      pad.addColorStop(0.55, `hsla(${hue}, 95%, 60%, ${pressed ? 0.5 : 0.18})`);
      pad.addColorStop(1, 'hsla(0,0%,0%,0)');
      g.fillStyle = pad;
      g.fillRect(x - r * 1.5, hitY - r * 1.5, r * 3, r * 3);
      g.restore();

      g.strokeStyle = `hsla(${hue}, 100%, ${pressed ? 85 : 70}%, ${pressed ? 1 : 0.6})`;
      g.lineWidth = (pressed ? 2.5 : 1.5) * this.dpr;
      g.beginPath();
      g.ellipse(x, hitY, r, r * 0.38, 0, 0, Math.PI * 2);
      g.stroke();
    }
  }

  private drawEffects(g: CanvasRenderingContext2D, now: number): void {
    // Expanding rings at the hit pads
    g.save();
    g.globalCompositeOperation = 'lighter';
    for (const r of this.rings) {
      const age = (now - r.born) / 450;
      if (age >= 1) continue;
      const x = this.laneX(r.lane, 1);
      const rad = this.laneW * 0.3 * (0.4 + easeOutCubic(age) * (r.ghost ? 1.1 : 2.1));
      g.globalAlpha = (1 - age) * (r.ghost ? 0.4 : 0.9);
      g.strokeStyle = r.color;
      g.lineWidth = (r.ghost ? 1.5 : 3) * (1 - age * 0.6) * this.dpr;
      g.beginPath();
      g.ellipse(x, this.hitY, rad, rad * 0.38, 0, 0, Math.PI * 2);
      g.stroke();
    }

    // Particles
    for (const p of this.particles) {
      const lifeFrac = p.life / p.maxLife;
      g.globalAlpha = (1 - lifeFrac) * 0.9;
      g.fillStyle = `hsl(${p.hue}, 100%, ${70 - lifeFrac * 25}%)`;
      g.beginPath();
      g.arc(p.x, p.y, p.size * (1 - lifeFrac * 0.5), 0, Math.PI * 2);
      g.fill();
    }
    g.restore();

    // Judgement labels floating up from the pads
    g.save();
    g.textAlign = 'center';
    for (const tx of this.texts) {
      const age = (now - tx.born) / 700;
      if (age >= 1) continue;
      const x = this.laneX(tx.lane, 1);
      const y = this.hitY - this.laneW * 0.5 - easeOutCubic(age) * this.h * 0.05;
      const pop = age < 0.18 ? 0.6 + (age / 0.18) * 0.4 : 1;
      g.globalAlpha = 1 - Math.max(0, age - 0.5) * 2;
      g.fillStyle = tx.color;
      g.font = `800 ${Math.round(this.laneW * 0.22 * pop)}px system-ui, sans-serif`;
      g.fillText(tx.text, x, y);
    }
    g.restore();
  }

  private drawHUD(
    g: CanvasRenderingContext2D,
    t: number,
    prog: number,
    now: number,
    hue: number
  ): void {
    const { w, h, dpr } = this;
    const pad = 14 * dpr;

    // Progress bar
    g.fillStyle = 'rgba(255,255,255,0.12)';
    g.fillRect(0, 0, w, 3 * dpr);
    g.fillStyle = `hsl(${hue}, 100%, 65%)`;
    g.fillRect(0, 0, w * prog, 3 * dpr);

    // Score
    g.textAlign = 'left';
    g.fillStyle = '#ffffff';
    g.font = `800 ${Math.round(20 * dpr)}px system-ui, sans-serif`;
    g.fillText(Math.round(this.shownScore).toLocaleString(), pad, pad + 20 * dpr);
    const judgedCount =
      this.counts.perfect + this.counts.great + this.counts.good + this.counts.miss;
    if (judgedCount > 0) {
      const acc =
        ((this.counts.perfect * 100 + this.counts.great * 60 + this.counts.good * 30) /
          (judgedCount * 100)) *
        100;
      g.fillStyle = 'rgba(255,255,255,0.55)';
      g.font = `600 ${Math.round(11 * dpr)}px system-ui, sans-serif`;
      g.fillText(`${acc.toFixed(1)}%`, pad, pad + 36 * dpr);
    }

    // Pause button
    g.fillStyle = 'rgba(255,255,255,0.7)';
    const px = w - 30 * dpr;
    const py = 16 * dpr;
    g.fillRect(px, py, 5 * dpr, 16 * dpr);
    g.fillRect(px + 9 * dpr, py, 5 * dpr, 16 * dpr);

    // Combo
    if (this.combo >= 2) {
      const age = Math.min(1, (now - this.lastComboChange) / 200);
      const pop = 1 + (1 - age) * 0.35;
      g.save();
      g.textAlign = 'center';
      g.globalAlpha = 0.92;
      g.fillStyle = `hsl(${hue - 20}, 100%, 78%)`;
      g.font = `900 ${Math.round(34 * dpr * pop)}px system-ui, sans-serif`;
      g.fillText(String(this.combo), w / 2, h * 0.32);
      g.globalAlpha = 0.6;
      g.font = `700 ${Math.round(11 * dpr)}px system-ui, sans-serif`;
      g.fillText('COMBO', w / 2, h * 0.32 + 16 * dpr);
      g.restore();
    }

    // Miss flash
    const missAge = now - this.lastMissAt;
    if (missAge < 220) {
      g.fillStyle = `rgba(255, 40, 80, ${0.16 * (1 - missAge / 220)})`;
      g.fillRect(0, 0, w, h);
    }

    // Countdown before the music starts
    if (t < 0) {
      g.save();
      g.textAlign = 'center';
      const count = Math.ceil(-t);
      const frac = -t - Math.floor(-t); // 1 → 0 within each second
      g.globalAlpha = Math.min(1, frac * 3);
      g.fillStyle = '#ffffff';
      g.font = `900 ${Math.round(64 * dpr * (0.8 + frac * 0.3))}px system-ui, sans-serif`;
      if (count <= 3) g.fillText(String(count), w / 2, h * 0.45);
      g.globalAlpha = 0.75;
      g.font = `700 ${Math.round(15 * dpr)}px system-ui, sans-serif`;
      g.fillText(this.title, w / 2, h * 0.53);
      g.globalAlpha = 0.5;
      g.font = `600 ${Math.round(11 * dpr)}px system-ui, sans-serif`;
      g.fillText('Tap the tiles when they reach the line', w / 2, h * 0.57);
      g.restore();
    }
  }
}

// Local tiny PRNG for scenery (decoupled from chart generation).
function mulberry32Local(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
