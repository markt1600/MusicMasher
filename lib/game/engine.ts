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

/** Base hue per lane: cyan, magenta, amber. Tiles, pads and hit effects all
 * derive from these so each column reads as its own color. */
const LANE_HUES = [185, 310, 38];

/** Lane hue with a gentle drift as the song progresses. */
function laneHue(lane: number, prog: number): number {
  return LANE_HUES[lane] + prog * 18;
}

interface ActiveNote extends Note {
  judged: Judgement | null;
  judgedAt: number;
  /** double: taps received so far (needs 2). */
  tapsGot: number;
  /** double: |dt| of the first tap, used to grade the pair. */
  tapDt?: number;
  /** hold: currently being held down. */
  holding: boolean;
  /** hold: resolved (bonus decided), with timestamp for the fade-out. */
  holdDone: boolean;
  holdDoneAt: number;
  /** hold: song-time when the lane was released (0 = held to the end). */
  releasedT: number;
  /** hold: song-time up to which combo/score ticks have been credited. */
  lastTickT: number;
}

/** While a hold is ridden, every 0.1 s credits +1 combo and a score tick. */
const HOLD_TICK = 0.1;
const HOLD_TICK_SCORE = 12;

/** Extra time (s) after a double's hit moment to land the second tap. */
const DOUBLE_EXTRA = 0.5;

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

/** Background spectacle objects that appear as combos climb past 20. */
type SkyEventType =
  | 'star'
  | 'firework'
  | 'rocket'
  | 'ufo'
  | 'comet'
  | 'bird'
  | 'balloon'
  | 'heli';

interface SkyEvent {
  type: SkyEventType;
  born: number;
  dur: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  hue: number;
  seed: number;
}

/** Background themes: distinct palette, scenery, and combo-event mix. */
export const THEMES = ['synthwave', 'city', 'beach', 'space', 'aurora'] as const;
export type ThemeName = (typeof THEMES)[number];

const THEME_BASE_HUE: Record<ThemeName, number> = {
  synthwave: 178,
  city: 222,
  beach: 165,
  space: 258,
  aurora: 130,
};

/** Weighted sky-event pools per theme (repeats = higher weight). */
const THEME_EVENTS: Record<ThemeName, SkyEventType[]> = {
  synthwave: ['star', 'star', 'firework', 'rocket', 'ufo'],
  city: ['firework', 'firework', 'heli', 'star', 'balloon'],
  beach: ['bird', 'bird', 'balloon', 'firework', 'star'],
  space: ['comet', 'comet', 'rocket', 'ufo', 'firework'],
  aurora: ['star', 'comet', 'comet', 'firework', 'balloon'],
};

export interface EngineOptions {
  /** Background theme index (wraps around THEMES). */
  theme?: number;
  /** 1 = normal; higher = faster scroll (gauntlet stages). */
  difficulty?: number;
  /** Shown in the HUD during gauntlet runs, e.g. "STAGE 2/5". */
  stageLabel?: string;
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

function easeOutBack(x: number): number {
  const c = 1.70158;
  return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2;
}

/** Chunky, playful font stack for the score and celebration popups. */
const COMIC_FONT =
  `'Comic Sans MS', 'Chalkboard SE', 'Comic Neue', 'Marker Felt', ` +
  `ui-rounded, system-ui, sans-serif`;

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
  private lastScoreAt = -10;
  private lastMilestoneAt = -10;
  private popups: { born: number; title: string; sub: string }[] = [];

  // effects
  private particles: Particle[] = [];
  private rings: Ring[] = [];
  private texts: FloatText[] = [];
  private pressUntil = new Float64Array(LANES);

  private skyEvents: SkyEvent[] = [];

  // hold-note input state
  private laneHeld = new Int8Array(LANES); // count of pointers+keys down
  private pointerLanes = new Map<number, number>();
  private keysDown = new Set<string>();
  private liveHolds: ActiveNote[] = [];

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
  private cityWindows: { x: number; y: number }[] = [];
  private planet = { x: 0, y: 0, r: 0 };
  private resizeObserver: ResizeObserver | null = null;

  // mode
  private theme: ThemeName = 'synthwave';
  private difficulty = 1;
  private stageLabel = '';

  constructor(
    canvas: HTMLCanvasElement,
    audioCtx: AudioContext,
    buffer: AudioBuffer,
    map: Beatmap,
    title: string,
    cb: EngineCallbacks,
    opts: EngineOptions = {}
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
    this.theme = THEMES[Math.abs(Math.round(opts.theme ?? 0)) % THEMES.length];
    this.difficulty = Math.max(1, Math.min(5, opts.difficulty ?? 1));
    this.stageLabel = opts.stageLabel ?? '';
    this.notes = [...map.notes]
      .sort((a, b) => a.t - b.t)
      .map((n) => ({
        ...n,
        judged: null,
        judgedAt: 0,
        tapsGot: 0,
        holding: false,
        holdDone: false,
        holdDoneAt: 0,
        releasedT: 0,
        lastTickT: 0,
      }));

    this.handleResize();
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(canvas);

    canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
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
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
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
    // Gauntlet stages scroll faster across the board.
    const diffScale = Math.max(0.72, 1 - 0.055 * (this.difficulty - 1));
    return (1.95 - 0.7 * easeInOut(p)) * diffScale;
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  private onPointerDown = (e: PointerEvent) => {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * this.w;
    const y = ((e.clientY - rect.top) / rect.height) * this.h;
    // pause button (top-right) — generous tap target for mobile
    if (x > this.w - 84 * this.dpr && y < 60 * this.dpr) {
      if (!this.paused && !this.ended) {
        this.pause();
        this.cb.onPauseRequest();
      }
      return;
    }
    if (this.paused || this.ended) return;
    const lane = Math.max(0, Math.min(LANES - 1, Math.floor((x / this.w) * LANES)));
    this.pointerLanes.set(e.pointerId, lane);
    this.laneHeld[lane]++;
    this.tapLane(lane);
  };

  private onPointerUp = (e: PointerEvent) => {
    const lane = this.pointerLanes.get(e.pointerId);
    if (lane === undefined) return;
    this.pointerLanes.delete(e.pointerId);
    this.laneHeld[lane] = Math.max(0, this.laneHeld[lane] - 1);
    if (this.laneHeld[lane] === 0) this.releaseLane(lane);
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
    const lane = keyLane(k);
    if (lane >= 0 && !this.keysDown.has(k)) {
      e.preventDefault();
      this.keysDown.add(k);
      this.laneHeld[lane]++;
      this.tapLane(lane);
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (!this.keysDown.has(k)) return;
    this.keysDown.delete(k);
    const lane = keyLane(k);
    if (lane >= 0) {
      this.laneHeld[lane] = Math.max(0, this.laneHeld[lane] - 1);
      if (this.laneHeld[lane] === 0) this.releaseLane(lane);
    }
  };

  /** A lane went fully up — settle any hold riding it. */
  private releaseLane(lane: number): void {
    const t = this.songTime() - this.offsetMs / 1000;
    for (const n of this.liveHolds) {
      if (n.lane === lane && n.holding && !n.holdDone) {
        n.holding = false;
        this.finishHold(n, t);
      }
    }
  }

  private finishHold(n: ActiveNote, endT: number): void {
    if (n.holdDone) return;
    n.holdDone = true;
    n.holdDoneAt = performance.now();
    n.releasedT = endT;
    const dur = n.dur ?? 1;
    const ratio = Math.max(0, Math.min(1, (endT - n.t) / dur));
    if (ratio >= 0.65) {
      const mult = 1 + Math.min(this.combo, 100) / 100;
      this.score += 80 * ratio * mult;
      this.lastScoreAt = n.holdDoneAt;
      this.texts.push({
        lane: n.lane,
        born: n.holdDoneAt,
        text: 'HOLD ✓',
        color: '#9dffc9',
      });
      this.spawnHitEffects(n.lane, 'great');
    }
  }

  private tapLane(lane: number): void {
    const now = performance.now();
    this.pressUntil[lane] = now + 130;
    const t = this.songTime() - this.offsetMs / 1000;

    // A double waiting for its second tap takes priority.
    for (let i = this.nextJudgeIdx; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.t > t + WINDOW_GOOD + 0.05) break;
      if (n.judged || n.lane !== lane) continue;
      if (n.kind === 'double' && n.tapsGot === 1 && t <= n.t + DOUBLE_EXTRA) {
        // The pair is graded by the first tap's timing.
        const judgement: Judgement =
          n.tapDt! <= WINDOW_PERFECT ? 'perfect' : n.tapDt! <= WINDOW_GREAT ? 'great' : 'good';
        this.judge(n, judgement);
        return;
      }
    }

    // Find the closest unjudged note in this lane within the good window.
    let best: ActiveNote | null = null;
    let bestAbs = Infinity;
    for (let i = this.nextJudgeIdx; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.t > t + WINDOW_GOOD + 0.05) break;
      if (n.judged || n.lane !== lane || (n.kind === 'double' && n.tapsGot > 0)) continue;
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

    if (best.kind === 'double') {
      // First of two taps: flash, remember the timing, wait for the second.
      best.tapsGot = 1;
      best.tapDt = bestAbs;
      this.rings.push({
        lane,
        born: now,
        color: `hsl(${LANE_HUES[lane]}, 100%, 75%)`,
        ghost: false,
      });
      return;
    }

    const judgement: Judgement =
      bestAbs <= WINDOW_PERFECT ? 'perfect' : bestAbs <= WINDOW_GREAT ? 'great' : 'good';
    this.judge(best, judgement);

    // Holds start riding once the head is hit.
    if (best.kind === 'hold') {
      best.holding = true;
      best.lastTickT = best.t;
      this.liveHolds.push(best);
    }
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
      this.lastScoreAt = note.judgedAt;
      const mult = 1 + Math.min(this.combo, 100) / 100;
      this.score += SCORE_VALUE[j] * mult;
      this.spawnHitEffects(note.lane, j);
      if (note.kind === 'bonus') {
        this.score += 300 * mult;
        this.popups.push({
          born: note.judgedAt,
          title: 'BONUS! ✦',
          sub: `+${Math.round(300 * mult)}`,
        });
        this.lastMilestoneAt = note.judgedAt;
        for (let i = 0; i < 24; i++) {
          const a = (i / 24) * Math.PI * 2;
          const sp = (0.7 + Math.random() * 1.2) * this.w * 0.004;
          this.particles.push({
            x: this.laneX(note.lane, 1),
            y: this.hitY,
            vx: Math.cos(a) * sp,
            vy: Math.sin(a) * sp * 0.7 - this.w * 0.002,
            life: 0,
            maxLife: 600 + Math.random() * 400,
            size: (2 + Math.random() * 4) * this.dpr,
            hue: 45 + Math.random() * 30,
          });
        }
      }
      this.checkMilestone(note.judgedAt);
    }
    this.texts.push({
      lane: note.lane,
      born: note.judgedAt,
      text: JUDGE_LABEL[j],
      color: JUDGE_COLOR[j],
    });
  }

  /** Escalating combo-milestone celebration: popup + firework burst. */
  private checkMilestone(now: number): void {
    const words: [number, string][] = [
      [10, 'NICE!'],
      [20, 'GREAT!'],
      [30, 'AWESOME!'],
      [50, 'ON FIRE! 🔥'],
      [75, 'BLAZING!'],
      [100, 'UNSTOPPABLE!'],
      [125, 'YOU ARE A MUSICAL GOD!!!'],
      [150, 'GODLIKE!'],
      [200, 'LEGENDARY!'],
      [300, 'LEGENDARY!'],
      [400, 'LEGENDARY!'],
      [500, 'LEGENDARY!'],
    ];
    const hit = words.find(([c]) => c === this.combo);
    if (!hit) return;
    this.popups.push({ born: now, title: hit[1], sub: `${this.combo} COMBO` });
    this.lastMilestoneAt = now;
    // Firework burst from the middle of the road.
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * Math.PI * 2;
      const sp = (0.8 + Math.random() * 1.4) * this.w * 0.004;
      this.particles.push({
        x: this.cx,
        y: this.h * 0.42,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp * 0.7,
        life: 0,
        maxLife: 600 + Math.random() * 400,
        size: (2 + Math.random() * 4) * this.dpr,
        hue: LANE_HUES[i % 3] + Math.random() * 20,
      });
    }
  }

  private spawnHitEffects(lane: number, j: Judgement): void {
    const now = performance.now();
    const hue = LANE_HUES[lane];
    this.rings.push({
      lane,
      born: now,
      color: `hsl(${hue}, 100%, 72%)`,
      ghost: false,
    });
    const x = this.laneX(lane, 1);
    const count = j === 'perfect' ? 16 : j === 'great' ? 10 : 6;
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
    const starCount = this.theme === 'space' ? 150 : 90;
    for (let i = 0; i < starCount; i++) {
      this.stars.push({
        x: rng() * this.w,
        y: rng() * this.horizonY * 0.95,
        r: (0.5 + rng() * 1.3) * this.dpr,
        phase: rng() * Math.PI * 2,
      });
    }
    this.mountains = [];
    this.cityWindows = [];
    const base = this.horizonY + this.h * 0.002;

    if (this.theme === 'city') {
      // Blocky skyline with lit windows.
      const path = new Path2D();
      path.moveTo(0, base);
      let x = 0;
      while (x < this.w) {
        const bw = this.w * (0.05 + rng() * 0.09);
        const bh = this.h * (0.035 + rng() * 0.09);
        path.lineTo(x, base - bh);
        path.lineTo(x + bw, base - bh);
        path.lineTo(x + bw, base);
        // windows for this building
        const cols = Math.max(1, Math.floor(bw / (7 * this.dpr)));
        const rows = Math.max(1, Math.floor(bh / (9 * this.dpr)));
        for (let c = 0; c < cols; c++) {
          for (let r = 0; r < rows; r++) {
            if (rng() < 0.4) {
              this.cityWindows.push({
                x: x + (c + 0.5) * (bw / cols),
                y: base - bh + (r + 0.5) * (bh / rows),
              });
            }
          }
        }
        x += bw;
      }
      path.lineTo(this.w, base);
      path.closePath();
      this.mountains.push(path, new Path2D());
    } else if (this.theme === 'beach') {
      // Low dunes/islands at the edges; open ocean in the middle.
      for (let layer = 0; layer < 2; layer++) {
        const path = new Path2D();
        const amp = this.h * (layer === 0 ? 0.03 : 0.018);
        path.moveTo(0, base);
        for (let i = 0; i <= 14; i++) {
          const px = (i / 14) * this.w;
          const edge = Math.max(0, Math.abs(px - this.w / 2) / (this.w / 2) - 0.35);
          path.lineTo(px, base - edge * Math.abs(Math.sin(i * 1.7 + layer * 3)) * amp * 18);
        }
        path.lineTo(this.w, base);
        path.closePath();
        this.mountains.push(path);
      }
    } else if (this.theme === 'space') {
      // Cratered ridge plus a big ringed planet.
      const path = new Path2D();
      path.moveTo(0, base);
      for (let i = 0; i <= 20; i++) {
        const px = (i / 20) * this.w;
        path.lineTo(px, base - Math.abs(Math.sin(i * 2.7)) * this.h * 0.02 * (0.4 + rng() * 0.6));
      }
      path.lineTo(this.w, base);
      path.closePath();
      this.mountains.push(path, new Path2D());
      this.planet = {
        x: this.w * 0.74,
        y: this.horizonY * 0.4,
        r: this.h * 0.075,
      };
    } else {
      // synthwave + aurora: jagged peaks (aurora's are steeper).
      const steep = this.theme === 'aurora' ? 1.6 : 1;
      for (let layer = 0; layer < 2; layer++) {
        const path = new Path2D();
        const amp = this.h * (layer === 0 ? 0.085 : 0.05) * steep;
        path.moveTo(0, base);
        const segs = 9 + layer * 4;
        for (let i = 0; i <= segs; i++) {
          const px = (i / segs) * this.w;
          const py = base - Math.abs(Math.sin(i * (2.3 + layer) + layer * 7)) * amp * (0.4 + rng() * 0.6);
          path.lineTo(px, py);
        }
        path.lineTo(this.w, base);
        path.closePath();
        this.mountains.push(path);
      }
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

    // Auto-miss notes that scrolled past the window. Doubles get extra time
    // for their second tap; one-of-two lands as a 'good'.
    for (let i = this.nextJudgeIdx; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.t > t - WINDOW_GOOD) break;
      if (n.judged) continue;
      if (n.kind === 'double') {
        if (t < n.t + DOUBLE_EXTRA + 0.05) continue; // still tappable
        this.judge(n, n.tapsGot >= 1 ? 'good' : 'miss');
      } else {
        this.judge(n, 'miss');
      }
    }

    // Holds being ridden shower combo + score: one tick per 0.1 s held.
    for (const n of this.liveHolds) {
      if (!n.holding || n.holdDone) continue;
      const end = n.t + (n.dur ?? 0);
      while (n.lastTickT + HOLD_TICK <= Math.min(t, end)) {
        n.lastTickT += HOLD_TICK;
        this.combo++;
        this.maxCombo = Math.max(this.maxCombo, this.combo);
        const nowMs = performance.now();
        this.lastComboChange = nowMs;
        this.lastScoreAt = nowMs;
        const mult = 1 + Math.min(this.combo, 100) / 100;
        this.score += HOLD_TICK_SCORE * mult;
        this.checkMilestone(nowMs);
      }
    }

    // Settle holds that were ridden all the way to the end.
    for (let i = this.liveHolds.length - 1; i >= 0; i--) {
      const n = this.liveHolds[i];
      if (!n.holdDone && n.holding && t >= n.t + (n.dur ?? 0)) {
        this.finishHold(n, n.t + (n.dur ?? 0));
      }
      if (n.holdDone && performance.now() - n.holdDoneAt > 400) {
        this.liveHolds.splice(i, 1);
      }
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
    this.popups = this.popups.filter((p) => now - p.born < 1300);

    // Sky spectacle: past 20 combo the sky comes alive, more so as it climbs.
    if (this.combo > 20 && t >= 0 && this.skyEvents.length < 14) {
      const k = Math.min(1, (this.combo - 20) / 120); // 0 → 1 frenzy
      if (Math.random() < 0.012 + 0.06 * k) this.spawnSkyEvent();
    }
    for (let i = this.skyEvents.length - 1; i >= 0; i--) {
      const e = this.skyEvents[i];
      e.x += e.vx;
      e.y += e.vy;
      if (now - e.born > e.dur) this.skyEvents.splice(i, 1);
    }

    // Song end.
    if (!this.ended && this.songTime() > this.map.duration + 0.6) {
      this.ended = true;
      cancelAnimationFrame(this.raf);
      this.cb.onEnd(this.stats());
    }
  }

  private spawnSkyEvent(): void {
    const { w, horizonY } = this;
    const now = performance.now();
    const seed = Math.random() * 1000;
    const pool = THEME_EVENTS[this.theme];
    const type = pool[Math.floor(Math.random() * pool.length)];
    if (type === 'star' || type === 'comet') {
      // shooting star: fast streak across the upper sky
      const dir = Math.random() < 0.5 ? 1 : -1;
      const comet = type === 'comet';
      this.skyEvents.push({
        type,
        born: now,
        dur: (comet ? 1100 : 700) + Math.random() * 500,
        x: dir > 0 ? -w * 0.05 : w * 1.05,
        y: horizonY * (0.05 + Math.random() * 0.5),
        vx: dir * w * ((comet ? 0.007 : 0.012) + Math.random() * 0.008),
        vy: w * 0.002,
        hue: 190 + Math.random() * 120,
        seed,
      });
    } else if (type === 'firework') {
      // firework burst in the sky
      this.skyEvents.push({
        type: 'firework',
        born: now,
        dur: 1000,
        x: w * (0.12 + Math.random() * 0.76),
        y: horizonY * (0.15 + Math.random() * 0.6),
        vx: 0,
        vy: 0,
        hue: Math.random() * 360,
        seed,
      });
    } else if (type === 'rocket') {
      // rocket launching from behind the mountains
      this.skyEvents.push({
        type: 'rocket',
        born: now,
        dur: 2100,
        x: w * (0.1 + Math.random() * 0.8),
        y: horizonY * 1.02,
        vx: (Math.random() - 0.5) * w * 0.0006,
        vy: -horizonY * 0.011,
        hue: 25,
        seed,
      });
    } else if (type === 'ufo' || type === 'heli' || type === 'bird') {
      // horizontal cruisers with their own bob/flap animation
      const dir = Math.random() < 0.5 ? 1 : -1;
      const speed =
        type === 'bird' ? 0.004 : type === 'heli' ? 0.0035 : 0.0028;
      this.skyEvents.push({
        type,
        born: now,
        dur: type === 'ufo' ? 3800 : 4500,
        x: dir > 0 ? -w * 0.08 : w * 1.08,
        y: horizonY * (0.15 + Math.random() * 0.55),
        vx: dir * w * (speed + Math.random() * 0.0015),
        vy: 0,
        hue: 130 + Math.random() * 100,
        seed,
      });
    } else {
      // balloon drifting up with a sway
      this.skyEvents.push({
        type: 'balloon',
        born: now,
        dur: 6000,
        x: w * (0.1 + Math.random() * 0.8),
        y: horizonY * 1.0,
        vx: (Math.random() - 0.5) * w * 0.0004,
        vy: -horizonY * 0.0022,
        hue: Math.random() * 360,
        seed,
      });
    }
  }

  private drawSkyEvents(g: CanvasRenderingContext2D): void {
    if (this.skyEvents.length === 0) return;
    const now = performance.now();
    const { dpr } = this;
    g.save();
    for (const e of this.skyEvents) {
      const age = (now - e.born) / e.dur;
      if (age >= 1) continue;
      if (e.type === 'star' || e.type === 'comet') {
        g.globalCompositeOperation = 'lighter';
        g.globalAlpha = Math.min(1, (1 - age) * 1.5);
        const tail = (e.type === 'comet' ? 70 : 22) * dpr;
        const grad = g.createLinearGradient(
          e.x - e.vx * tail * 0.1,
          e.y - e.vy * tail * 0.1,
          e.x,
          e.y
        );
        grad.addColorStop(0, 'hsla(0,0%,100%,0)');
        grad.addColorStop(1, `hsla(${e.hue}, 100%, 85%, 0.95)`);
        g.strokeStyle = grad;
        g.lineWidth = (e.type === 'comet' ? 3 : 2) * dpr;
        g.beginPath();
        g.moveTo(e.x - e.vx * tail * 0.1, e.y - e.vy * tail * 0.1);
        g.lineTo(e.x, e.y);
        g.stroke();
        g.fillStyle = '#ffffff';
        g.beginPath();
        g.arc(e.x, e.y, 1.6 * dpr, 0, Math.PI * 2);
        g.fill();
      } else if (e.type === 'firework') {
        g.globalCompositeOperation = 'lighter';
        const rMax = this.horizonY * 0.35;
        const burst = easeOutCubic(Math.min(1, age * 1.6));
        g.globalAlpha = 1 - age;
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * Math.PI * 2 + e.seed;
          const rr = rMax * burst * (0.75 + ((i * 37) % 10) / 40);
          g.fillStyle = `hsl(${e.hue + (i % 3) * 25}, 100%, ${75 - age * 25}%)`;
          g.beginPath();
          g.arc(
            e.x + Math.cos(a) * rr,
            e.y + Math.sin(a) * rr * 0.85 + age * age * 18 * dpr,
            Math.max(0.5, (2.4 - age * 1.8) * dpr),
            0,
            Math.PI * 2
          );
          g.fill();
        }
        // core flash
        if (age < 0.25) {
          g.globalAlpha = (1 - age / 0.25) * 0.8;
          g.fillStyle = '#ffffff';
          g.beginPath();
          g.arc(e.x, e.y, 4 * dpr * (1 - age), 0, Math.PI * 2);
          g.fill();
        }
      } else if (e.type === 'rocket') {
        const wob = Math.sin(now / 90 + e.seed) * 1.2 * dpr;
        const x = e.x + wob;
        g.globalAlpha = Math.min(1, (1 - age) * 2);
        // flame
        g.save();
        g.globalCompositeOperation = 'lighter';
        const flick = 1 + Math.sin(now / 35 + e.seed) * 0.3;
        const fl = g.createRadialGradient(x, e.y + 8 * dpr, 0, x, e.y + 8 * dpr, 14 * dpr * flick);
        fl.addColorStop(0, 'hsla(45, 100%, 80%, 0.95)');
        fl.addColorStop(0.5, 'hsla(25, 100%, 60%, 0.6)');
        fl.addColorStop(1, 'hsla(15, 100%, 50%, 0)');
        g.fillStyle = fl;
        g.beginPath();
        g.moveTo(x - 3 * dpr, e.y + 6 * dpr);
        g.lineTo(x + 3 * dpr, e.y + 6 * dpr);
        g.lineTo(x, e.y + (16 + 8 * flick) * dpr);
        g.closePath();
        g.fill();
        g.restore();
        // body
        g.fillStyle = '#e8ecf5';
        g.beginPath();
        g.moveTo(x, e.y - 10 * dpr); // nose
        g.lineTo(x + 3.5 * dpr, e.y - 2 * dpr);
        g.lineTo(x + 3.5 * dpr, e.y + 6 * dpr);
        g.lineTo(x - 3.5 * dpr, e.y + 6 * dpr);
        g.lineTo(x - 3.5 * dpr, e.y - 2 * dpr);
        g.closePath();
        g.fill();
        g.fillStyle = '#ff5d7d';
        g.beginPath(); // fins
        g.moveTo(x - 3.5 * dpr, e.y + 6 * dpr);
        g.lineTo(x - 7 * dpr, e.y + 10 * dpr);
        g.lineTo(x - 3.5 * dpr, e.y + 1 * dpr);
        g.moveTo(x + 3.5 * dpr, e.y + 6 * dpr);
        g.lineTo(x + 7 * dpr, e.y + 10 * dpr);
        g.lineTo(x + 3.5 * dpr, e.y + 1 * dpr);
        g.fill();
      } else if (e.type === 'bird') {
        // gliding bird silhouette with flapping wings
        const flap = Math.sin(now / 110 + e.seed) * 5 * dpr;
        const y = e.y + Math.sin(now / 500 + e.seed) * 6 * dpr;
        g.globalAlpha = Math.min(1, (1 - age) * 3);
        g.strokeStyle = 'rgba(18, 22, 38, 0.95)';
        g.lineWidth = 2 * dpr;
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(e.x - 7 * dpr, y - flap);
        g.quadraticCurveTo(e.x - 2 * dpr, y + 2 * dpr, e.x, y);
        g.quadraticCurveTo(e.x + 2 * dpr, y + 2 * dpr, e.x + 7 * dpr, y - flap);
        g.stroke();
      } else if (e.type === 'balloon') {
        // hot-air balloon drifting upward
        const x = e.x + Math.sin(now / 700 + e.seed) * 8 * dpr;
        const r = 9 * dpr;
        g.globalAlpha = Math.min(1, (1 - age) * 2.5);
        const env2 = g.createRadialGradient(x - r * 0.3, e.y - r * 0.3, r * 0.2, x, e.y, r);
        env2.addColorStop(0, `hsl(${e.hue}, 95%, 70%)`);
        env2.addColorStop(1, `hsl(${e.hue}, 85%, 45%)`);
        g.fillStyle = env2;
        g.beginPath();
        g.arc(x, e.y, r, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = `hsl(${(e.hue + 40) % 360}, 90%, 75%)`;
        g.lineWidth = 1 * dpr;
        g.beginPath();
        g.ellipse(x, e.y, r * 0.45, r, 0, 0, Math.PI * 2);
        g.stroke();
        // basket
        g.strokeStyle = 'rgba(200, 205, 220, 0.7)';
        g.beginPath();
        g.moveTo(x - r * 0.4, e.y + r * 0.9);
        g.lineTo(x - r * 0.25, e.y + r * 1.5);
        g.moveTo(x + r * 0.4, e.y + r * 0.9);
        g.lineTo(x + r * 0.25, e.y + r * 1.5);
        g.stroke();
        g.fillStyle = '#7a5c3e';
        g.fillRect(x - r * 0.3, e.y + r * 1.5, r * 0.6, r * 0.4);
      } else if (e.type === 'heli') {
        // helicopter with spinning rotor and blinking light
        const y = e.y + Math.sin(now / 300 + e.seed) * 5 * dpr;
        const dir = Math.sign(e.vx) || 1;
        g.globalAlpha = Math.min(1, (1 - age) * 3);
        g.fillStyle = '#2a3148';
        g.beginPath();
        g.ellipse(e.x, y, 8 * dpr, 3.6 * dpr, 0, 0, Math.PI * 2);
        g.fill();
        // tail boom + fin
        g.strokeStyle = '#2a3148';
        g.lineWidth = 1.8 * dpr;
        g.beginPath();
        g.moveTo(e.x - dir * 7 * dpr, y);
        g.lineTo(e.x - dir * 15 * dpr, y - 1.5 * dpr);
        g.stroke();
        // cockpit glint
        g.fillStyle = 'rgba(150, 230, 255, 0.75)';
        g.beginPath();
        g.arc(e.x + dir * 4.5 * dpr, y - 1 * dpr, 2 * dpr, 0, Math.PI * 2);
        g.fill();
        // rotor blur
        const rot = Math.sin(now / 25 + e.seed);
        g.strokeStyle = `rgba(220, 228, 250, ${0.35 + Math.abs(rot) * 0.4})`;
        g.lineWidth = 1.2 * dpr;
        g.beginPath();
        g.moveTo(e.x - 12 * dpr * Math.abs(rot) - 2 * dpr, y - 5 * dpr);
        g.lineTo(e.x + 12 * dpr * Math.abs(rot) + 2 * dpr, y - 5 * dpr);
        g.stroke();
        // blinking tail light
        if (Math.floor(now / 220) % 2 === 0) {
          g.fillStyle = '#ff4d5e';
          g.beginPath();
          g.arc(e.x - dir * 15 * dpr, y - 2.5 * dpr, 1.5 * dpr, 0, Math.PI * 2);
          g.fill();
        }
      } else {
        // UFO: metallic saucer with dome and blinking lights
        const y = e.y + Math.sin(now / 260 + e.seed) * 9 * dpr;
        const rw = 16 * dpr;
        const rh = 5.5 * dpr;
        g.globalAlpha = Math.min(1, (1 - age) * 3);
        // dome
        g.fillStyle = 'rgba(140, 240, 255, 0.55)';
        g.beginPath();
        g.arc(e.x, y - rh * 0.6, rw * 0.42, Math.PI, 0);
        g.fill();
        // body
        const body = g.createLinearGradient(e.x, y - rh, e.x, y + rh);
        body.addColorStop(0, '#cdd6e8');
        body.addColorStop(0.6, '#8b96ad');
        body.addColorStop(1, '#5a6378');
        g.fillStyle = body;
        g.beginPath();
        g.ellipse(e.x, y, rw, rh, 0, 0, Math.PI * 2);
        g.fill();
        // blinking lights
        for (let i = -1; i <= 1; i++) {
          const on = Math.floor(now / 160 + i + e.seed) % 2 === 0;
          g.fillStyle = on ? `hsl(${e.hue}, 100%, 70%)` : 'rgba(30,34,48,0.9)';
          g.beginPath();
          g.arc(e.x + i * rw * 0.5, y + rh * 0.45, 1.8 * dpr, 0, Math.PI * 2);
          g.fill();
        }
      }
    }
    g.restore();
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
    // Base hue is set by the theme and drifts as the song intensifies.
    const hue = THEME_BASE_HUE[this.theme] + prog * 110;

    this.drawBackground(g, t, hue, env);
    this.drawSkyEvents(g);
    this.drawRoad(g, t, hue, env, prog);
    this.drawNotes(g, t, prog);
    this.drawHitLine(g, hue, prog, now);
    this.drawEffects(g, now);
    this.drawComboPulse(g, t, env, hue);
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

    // Theme landmark behind the silhouettes.
    if (this.theme === 'synthwave' || this.theme === 'beach') {
      // Sun glow on the horizon, pulsing with the music.
      const sunR = (this.h * (this.theme === 'beach' ? 0.13 : 0.11)) * (1 + env * 0.16);
      const sun = g.createRadialGradient(cx, horizonY, sunR * 0.1, cx, horizonY, sunR * 2.6);
      const sunHue = this.theme === 'beach' ? 32 : hue;
      sun.addColorStop(0, `hsla(${sunHue}, 100%, 78%, 0.95)`);
      sun.addColorStop(0.25, `hsla(${sunHue}, 95%, 62%, 0.5)`);
      sun.addColorStop(1, 'hsla(0, 0%, 0%, 0)');
      g.fillStyle = sun;
      g.fillRect(cx - sunR * 3, horizonY - sunR * 3, sunR * 6, sunR * 6);
    } else if (this.theme === 'city') {
      // Pale moon, upper right.
      const mx = w * 0.76;
      const my = horizonY * 0.32;
      const mr = this.h * 0.035 * (1 + env * 0.06);
      const glow = g.createRadialGradient(mx, my, mr * 0.3, mx, my, mr * 4);
      glow.addColorStop(0, 'rgba(235, 240, 255, 0.5)');
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = glow;
      g.fillRect(mx - mr * 4, my - mr * 4, mr * 8, mr * 8);
      g.fillStyle = '#e9edfa';
      g.beginPath();
      g.arc(mx, my, mr, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = 'rgba(180, 190, 215, 0.5)';
      g.beginPath();
      g.arc(mx - mr * 0.3, my - mr * 0.2, mr * 0.22, 0, Math.PI * 2);
      g.arc(mx + mr * 0.35, my + mr * 0.3, mr * 0.15, 0, Math.PI * 2);
      g.fill();
    } else if (this.theme === 'space') {
      // Nebula wisps + a big ringed planet.
      g.save();
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 2; i++) {
        const nx = w * (0.25 + i * 0.4) + Math.sin(t * 0.05 + i * 3) * w * 0.02;
        const ny = horizonY * (0.3 + i * 0.25);
        const nr = this.h * 0.16;
        const neb = g.createRadialGradient(nx, ny, 0, nx, ny, nr);
        neb.addColorStop(0, `hsla(${hue + i * 60}, 90%, 55%, 0.12)`);
        neb.addColorStop(1, 'hsla(0,0%,0%,0)');
        g.fillStyle = neb;
        g.fillRect(nx - nr, ny - nr, nr * 2, nr * 2);
      }
      g.restore();
      const { x: px, y: py, r: pr } = this.planet;
      const body = g.createRadialGradient(px - pr * 0.4, py - pr * 0.4, pr * 0.2, px, py, pr);
      body.addColorStop(0, `hsl(${hue + 60}, 65%, 68%)`);
      body.addColorStop(1, `hsl(${hue + 30}, 60%, 30%)`);
      g.fillStyle = body;
      g.beginPath();
      g.arc(px, py, pr, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = `hsla(${hue + 80}, 80%, 75%, 0.75)`;
      g.lineWidth = 2.5 * this.dpr;
      g.beginPath();
      g.ellipse(px, py, pr * 1.75, pr * 0.42, -0.3, 0, Math.PI * 2);
      g.stroke();
    } else if (this.theme === 'aurora') {
      // Rippling aurora ribbons.
      g.save();
      g.globalCompositeOperation = 'lighter';
      for (let b = 0; b < 3; b++) {
        g.beginPath();
        const baseY = horizonY * (0.2 + b * 0.16);
        const amp = horizonY * 0.09;
        for (let i = 0; i <= 24; i++) {
          const rx = (i / 24) * w;
          const ry = baseY + Math.sin(i * 0.55 + t * (0.6 + b * 0.25) + b * 2.1) * amp;
          if (i === 0) g.moveTo(rx, ry);
          else g.lineTo(rx, ry);
        }
        for (let i = 24; i >= 0; i--) {
          const rx = (i / 24) * w;
          const ry =
            baseY +
            Math.sin(i * 0.55 + t * (0.6 + b * 0.25) + b * 2.1) * amp +
            this.h * 0.055;
          g.lineTo(rx, ry);
        }
        g.closePath();
        g.fillStyle = `hsla(${125 + b * 35}, 95%, 60%, ${0.09 + env * 0.06})`;
        g.fill();
      }
      g.restore();
    }

    // Silhouettes (mountains / skyline / dunes / ridge).
    g.fillStyle = `hsl(${hue + 45}, 45%, 6%)`;
    g.fill(this.mountains[0]);
    g.fillStyle = `hsl(${hue + 45}, 40%, 9%)`;
    g.fill(this.mountains[1]);

    // City windows glitter on top of the skyline.
    if (this.theme === 'city') {
      for (let i = 0; i < this.cityWindows.length; i++) {
        const wd = this.cityWindows[i];
        const flicker = Math.floor(t * 1.5 + i * 7) % 11 !== 0;
        if (!flicker) continue;
        g.fillStyle = i % 5 === 0 ? 'rgba(255, 214, 140, 0.9)' : 'rgba(255, 235, 190, 0.6)';
        g.fillRect(wd.x, wd.y, 1.6 * this.dpr, 2.2 * this.dpr);
      }
    }

    // Ocean shimmer at the beach horizon.
    if (this.theme === 'beach') {
      g.save();
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 10; i++) {
        const sy = horizonY + (2 + i * 3.2) * this.dpr;
        const phase = Math.sin(t * 1.4 + i * 1.9);
        g.globalAlpha = 0.14 + 0.1 * phase;
        g.strokeStyle = 'hsl(45, 100%, 78%)';
        g.lineWidth = 1.2 * this.dpr;
        const sw = w * (0.1 + 0.06 * phase);
        g.beginPath();
        g.moveTo(cx - sw + Math.sin(i * 5) * w * 0.05, sy);
        g.lineTo(cx + sw + Math.sin(i * 5) * w * 0.05, sy);
        g.stroke();
      }
      g.restore();
    }

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

  private drawNotes(g: CanvasRenderingContext2D, t: number, prog: number): void {
    const tJudge = t - this.offsetMs / 1000;
    const approach = this.approachAt(Math.max(0, t));

    g.save();
    for (const n of this.notes) {
      const d = (n.t - tJudge) / approach;
      if (d > 1.05) break; // notes sorted by time; rest are farther out
      const hue = laneHue(n.lane, prog);

      if (n.kind === 'hold') {
        this.drawHold(g, n, d, approach, hue, tJudge);
        continue;
      }
      if (d < -0.12) continue;

      if (n.judged && n.judged !== 'miss') {
        // brief shrink-out at the hit line
        const age = (performance.now() - n.judgedAt) / 160;
        if (age >= 1) continue;
        const pr = this.proj(0);
        this.drawTile(g, n.lane, pr, this.proj(TILE_LEN), hue, 1 - age, 1 + age * 0.4);
        continue;
      }

      // Bonus gem: spinning faceted jewel.
      if (n.kind === 'bonus' && !n.judged) {
        this.drawGem(g, n.lane, d);
        continue;
      }

      // Double waiting for its second tap: pinned at the line, pulsing.
      if (n.kind === 'double' && n.tapsGot === 1 && !n.judged) {
        const dp = Math.max(d, 0);
        const pulse = 1 + 0.06 * Math.sin(performance.now() / 45);
        this.drawTile(g, n.lane, this.proj(dp), this.proj(dp + TILE_LEN), hue, 1, pulse, false, true);
        continue;
      }

      const missed = n.judged === 'miss';
      const prNear = this.proj(d);
      const prFar = this.proj(d + TILE_LEN);
      const alpha = missed ? Math.max(0, 0.7 - (performance.now() - n.judgedAt) / 280) : 1;
      if (alpha <= 0) continue;
      this.drawTile(
        g,
        n.lane,
        prNear,
        prFar,
        missed ? -40 : hue,
        alpha,
        1,
        missed,
        n.kind === 'double'
      );
    }
    g.restore();
  }

  /** Bonus gem: an iridescent faceted jewel that spins as it approaches. */
  private drawGem(g: CanvasRenderingContext2D, lane: number, d: number): void {
    const pr = this.proj(d + TILE_LEN / 2);
    const x = this.laneX(lane, pr);
    const y = this.yAt(pr);
    const now = performance.now();
    const s = this.laneW * 0.34 * pr;
    if (s < 2) return;
    // fake Y-axis spin by squashing horizontally
    const spin = 0.45 + 0.55 * Math.abs(Math.cos(now / 350 + lane * 2));
    const hue = (now / 12 + lane * 60) % 360; // slow iridescent cycle
    const rx = s * 0.85 * spin;
    const ry = s * 0.62;

    // halo
    g.save();
    g.globalCompositeOperation = 'lighter';
    const halo = g.createRadialGradient(x, y, s * 0.2, x, y, s * 2.2);
    halo.addColorStop(0, `hsla(${hue}, 100%, 75%, ${0.5 + 0.2 * Math.sin(now / 120)})`);
    halo.addColorStop(1, 'hsla(0,0%,0%,0)');
    g.fillStyle = halo;
    g.fillRect(x - s * 2.2, y - s * 2.2, s * 4.4, s * 4.4);
    g.restore();

    // faceted diamond: four triangles from the center, each lit differently
    const pts = [
      [x, y - ry], // top
      [x + rx, y], // right
      [x, y + ry], // bottom
      [x - rx, y], // left
    ];
    const light = [82, 60, 45, 68];
    for (let i = 0; i < 4; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % 4];
      g.fillStyle = `hsl(${(hue + i * 14) % 360}, 95%, ${light[i]}%)`;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(a[0], a[1]);
      g.lineTo(b[0], b[1]);
      g.closePath();
      g.fill();
    }
    g.strokeStyle = `hsla(${hue}, 100%, 88%, 0.95)`;
    g.lineWidth = Math.max(1, 1.4 * pr * this.dpr);
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < 4; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath();
    g.stroke();

    // glint
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.beginPath();
    g.arc(x - rx * 0.3, y - ry * 0.35, Math.max(1, s * 0.1), 0, Math.PI * 2);
    g.fill();
    g.restore();

    // trailing sparkles
    if (Math.random() < 0.25) {
      this.particles.push({
        x: x + (Math.random() - 0.5) * rx * 1.6,
        y: y + (Math.random() - 0.5) * ry * 1.6,
        vx: (Math.random() - 0.5) * this.w * 0.001,
        vy: -this.w * 0.001,
        life: 0,
        maxLife: 350,
        size: (1 + Math.random() * 2) * this.dpr,
        hue,
      });
    }
  }

  /** Hold tile: a head cap plus a glowing tail lasting `dur` seconds. While
   * ridden, the head pins to the hit line and the tail feeds into it. */
  private drawHold(
    g: CanvasRenderingContext2D,
    n: ActiveNote,
    dHead: number,
    approach: number,
    hue: number,
    tJudge: number
  ): void {
    const dur = n.dur ?? 0.5;
    const dTail = (n.t + dur - tJudge) / approach;
    if (dTail < -0.12) return;

    const now = performance.now();
    let alpha = 1;
    if (n.judged === 'miss') {
      alpha = Math.max(0, 0.7 - (now - n.judgedAt) / 280);
      hue = -40;
    } else if (n.holdDone) {
      alpha = Math.max(0, 1 - (now - n.holdDoneAt) / 300);
    }
    if (alpha <= 0) return;

    const riding = n.judged && n.judged !== 'miss' && !n.holdDone;
    const dH = riding ? Math.max(dHead, 0) : dHead;
    if (dH < -0.12 && !riding) return;

    const prHead = this.proj(Math.max(dH, -0.1));
    const prTail = this.proj(Math.min(dTail, 1.05));

    // Tail body: narrower, translucent, with bright rails.
    const yH = this.yAt(prHead);
    const yT = this.yAt(prTail);
    const cxH = this.laneX(n.lane, prHead);
    const cxT = this.laneX(n.lane, prTail);
    const halfH = this.laneW * 0.2 * prHead;
    const halfT = this.laneW * 0.2 * prTail;

    g.globalAlpha = alpha * (riding ? 0.85 : 0.55);
    const grad = g.createLinearGradient(0, yT, 0, yH);
    grad.addColorStop(0, `hsla(${hue}, 90%, 55%, 0.5)`);
    grad.addColorStop(1, `hsla(${hue}, 100%, ${riding ? 75 : 62}%, 0.9)`);
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(cxT - halfT, yT);
    g.lineTo(cxT + halfT, yT);
    g.lineTo(cxH + halfH, yH);
    g.lineTo(cxH - halfH, yH);
    g.closePath();
    g.fill();
    g.strokeStyle = `hsla(${hue}, 100%, 80%, ${0.8 * alpha})`;
    g.lineWidth = Math.max(1, 1.2 * prHead * this.dpr);
    g.stroke();
    g.globalAlpha = 1;

    // Head cap.
    this.drawTile(
      g,
      n.lane,
      prHead,
      this.proj(Math.max(dH, -0.1) + TILE_LEN * 0.8),
      hue,
      alpha,
      riding ? 1 + 0.05 * Math.sin(now / 40) : 1,
      n.judged === 'miss'
    );

    // Sparks while riding.
    if (riding && Math.random() < 0.35) {
      const x = this.laneX(n.lane, 1);
      this.particles.push({
        x: x + (Math.random() - 0.5) * this.laneW * 0.4,
        y: this.hitY,
        vx: (Math.random() - 0.5) * this.w * 0.002,
        vy: -this.w * (0.002 + Math.random() * 0.003),
        life: 0,
        maxLife: 300 + Math.random() * 200,
        size: (1.5 + Math.random() * 2.5) * this.dpr,
        hue: LANE_HUES[n.lane],
      });
    }
  }

  private drawTile(
    g: CanvasRenderingContext2D,
    lane: number,
    prNear: number,
    prFar: number,
    hue: number,
    alpha: number,
    scale = 1,
    missed = false,
    split = false
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

    // Double-tap tile: split into two segments so it reads "tap twice".
    if (split && halfN > 4) {
      const seg = (fr: number) => ({
        y: yF + (yN - yF) * fr,
        cx: cxF + (cxN - cxF) * fr,
        half: halfF + (halfN - halfF) * fr,
      });
      const a = seg(0.42);
      const b = seg(0.58);
      g.globalAlpha = alpha * 0.85;
      g.fillStyle = 'rgba(5, 9, 26, 0.75)';
      g.beginPath();
      g.moveTo(a.cx - a.half, a.y);
      g.lineTo(a.cx + a.half, a.y);
      g.lineTo(b.cx + b.half, b.y);
      g.lineTo(b.cx - b.half, b.y);
      g.closePath();
      g.fill();
    }
    g.globalAlpha = 1;
  }

  private drawHitLine(
    g: CanvasRenderingContext2D,
    hue: number,
    prog: number,
    now: number
  ): void {
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

    // Extruded 3D buttons, one color per lane. Each is a squat cylinder whose
    // top face sinks toward the base while pressed.
    for (let lane = 0; lane < LANES; lane++) {
      const x = this.laneX(lane, 1);
      const pressed = now < this.pressUntil[lane];
      const padHue = laneHue(lane, prog);
      const rx = laneW * 0.31;
      const ry = rx * 0.4;
      const height = laneW * 0.17;
      const baseY = hitY + ry * 0.4;
      const topY = baseY - (pressed ? height * 0.35 : height);

      // Colored glow pooling under the button.
      g.save();
      g.globalCompositeOperation = 'lighter';
      const glowR = rx * (pressed ? 2.1 : 1.5);
      const pool = g.createRadialGradient(x, baseY, rx * 0.2, x, baseY, glowR);
      pool.addColorStop(0, `hsla(${padHue}, 100%, 65%, ${pressed ? 0.6 : 0.28})`);
      pool.addColorStop(1, 'hsla(0,0%,0%,0)');
      g.fillStyle = pool;
      g.fillRect(x - glowR, baseY - glowR * 0.6, glowR * 2, glowR * 1.2);
      g.restore();

      // Base rim (dark ellipse peeking out below the wall).
      g.fillStyle = `hsl(${padHue}, 70%, 10%)`;
      g.beginPath();
      g.ellipse(x, baseY, rx * 1.04, ry * 1.04, 0, 0, Math.PI * 2);
      g.fill();

      // Side wall: lower arc of the base ellipse up to the lower arc of the
      // top ellipse.
      const wall = g.createLinearGradient(0, topY, 0, baseY + ry);
      wall.addColorStop(0, `hsl(${padHue}, 85%, ${pressed ? 45 : 38}%)`);
      wall.addColorStop(1, `hsl(${padHue}, 90%, ${pressed ? 22 : 16}%)`);
      g.fillStyle = wall;
      g.beginPath();
      g.ellipse(x, baseY, rx, ry, 0, 0, Math.PI, false);
      g.lineTo(x - rx, topY);
      g.ellipse(x, topY, rx, ry, 0, Math.PI, 0, true);
      g.closePath();
      g.fill();

      // Top face.
      const top = g.createRadialGradient(
        x - rx * 0.25,
        topY - ry * 0.4,
        rx * 0.1,
        x,
        topY,
        rx * 1.15
      );
      top.addColorStop(0, `hsl(${padHue}, 100%, ${pressed ? 88 : 74}%)`);
      top.addColorStop(0.65, `hsl(${padHue}, 95%, ${pressed ? 70 : 52}%)`);
      top.addColorStop(1, `hsl(${padHue}, 95%, ${pressed ? 55 : 38}%)`);
      g.fillStyle = top;
      g.beginPath();
      g.ellipse(x, topY, rx, ry, 0, 0, Math.PI * 2);
      g.fill();

      // Bright rim on the top face.
      g.strokeStyle = `hsla(${padHue}, 100%, ${pressed ? 92 : 80}%, ${pressed ? 1 : 0.75})`;
      g.lineWidth = (pressed ? 2.5 : 1.5) * this.dpr;
      g.beginPath();
      g.ellipse(x, topY, rx, ry, 0, 0, Math.PI * 2);
      g.stroke();

      // Inner marker ring so the tap target reads at a glance.
      g.strokeStyle = `hsla(${padHue}, 100%, 90%, ${pressed ? 0.9 : 0.4})`;
      g.lineWidth = 1 * this.dpr;
      g.beginPath();
      g.ellipse(x, topY, rx * 0.55, ry * 0.55, 0, 0, Math.PI * 2);
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

  /** As combos grow, the whole screen pulses gently to the beat, cycling
   * through colors — subtle at 10, unmistakable past 100. */
  private drawComboPulse(
    g: CanvasRenderingContext2D,
    t: number,
    env: number,
    hue: number
  ): void {
    if (this.combo < 10 || t < 0) return;
    const { w, h } = this;
    const beat = 1 - ((t * this.map.bpm) / 60) % 1; // 1 on the beat, decaying
    const strength = Math.min(1, this.combo / 120);
    const alpha = strength * (0.05 + 0.16 * beat * beat) * (0.55 + env * 0.45);
    if (alpha <= 0.01) return;
    const pulseHue = (hue + t * 55 + this.combo * 2.5) % 360;
    g.save();
    g.globalCompositeOperation = 'lighter';
    const grad = g.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, h * 0.78);
    grad.addColorStop(0, 'hsla(0,0%,0%,0)');
    grad.addColorStop(1, `hsla(${pulseHue}, 100%, 62%, ${alpha})`);
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
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

    // Progress bar
    g.fillStyle = 'rgba(255,255,255,0.12)';
    g.fillRect(0, 0, w, 3 * dpr);
    g.fillStyle = `hsl(${hue}, 100%, 65%)`;
    g.fillRect(0, 0, w * prog, 3 * dpr);

    // Gauntlet stage badge, top-left
    if (this.stageLabel) {
      g.save();
      g.textAlign = 'left';
      g.font = `900 ${Math.round(13 * dpr)}px ${COMIC_FONT}`;
      g.lineJoin = 'round';
      g.lineWidth = 4 * dpr;
      g.strokeStyle = 'rgba(8, 5, 28, 0.9)';
      g.strokeText(this.stageLabel, 12 * dpr, 26 * dpr);
      g.fillStyle = `hsl(${hue + 40}, 100%, 75%)`;
      g.fillText(this.stageLabel, 12 * dpr, 26 * dpr);
      g.restore();
    }

    // Big bouncy score, centered at the top. While a hold is being ridden it
    // grows larger and blinks gold to sell the rapid accumulation.
    const holdActive = this.liveHolds.some((n) => n.holding && !n.holdDone);
    const bump = Math.max(0, 1 - (now - this.lastScoreAt) / 260);
    const pop = holdActive
      ? 1.3 + 0.09 * Math.sin(now / 42)
      : 1 + bump * bump * 0.28;
    const wobble = Math.sin(now / 320) * 0.035;
    const scoreStr = Math.round(this.shownScore).toLocaleString();
    g.save();
    g.translate(w / 2, 46 * dpr);
    g.rotate(wobble);
    g.scale(pop, pop);
    g.textAlign = 'center';
    g.font = `900 ${Math.round(36 * dpr)}px ${COMIC_FONT}`;
    g.lineJoin = 'round';
    g.lineWidth = 7 * dpr;
    g.strokeStyle = 'rgba(8, 5, 28, 0.9)';
    g.strokeText(scoreStr, 0, 0);
    const sg = g.createLinearGradient(0, -26 * dpr, 0, 12 * dpr);
    if (holdActive) {
      const flash = 0.5 + 0.5 * Math.sin(now / 55);
      sg.addColorStop(0, '#ffffff');
      sg.addColorStop(0.5, `hsl(48, 100%, ${62 + flash * 26}%)`);
      sg.addColorStop(1, `hsl(38, 100%, ${55 + flash * 20}%)`);
      g.globalAlpha = 0.88 + 0.12 * flash;
    } else {
      sg.addColorStop(0, '#ffffff');
      sg.addColorStop(0.55, `hsl(${hue}, 100%, 72%)`);
      sg.addColorStop(1, `hsl(${hue + 45}, 100%, 62%)`);
    }
    g.fillStyle = sg;
    g.fillText(scoreStr, 0, 0);
    g.restore();

    const judgedCount =
      this.counts.perfect + this.counts.great + this.counts.good + this.counts.miss;
    if (judgedCount > 0) {
      const acc =
        ((this.counts.perfect * 100 + this.counts.great * 60 + this.counts.good * 30) /
          (judgedCount * 100)) *
        100;
      g.textAlign = 'center';
      g.fillStyle = 'rgba(255,255,255,0.55)';
      g.font = `700 ${Math.round(11 * dpr)}px system-ui, sans-serif`;
      g.fillText(`${acc.toFixed(1)}%`, w / 2, 64 * dpr);
    }

    // Milestone flash: a quick colored glow around the screen edges.
    const flashAge = (now - this.lastMilestoneAt) / 600;
    if (flashAge < 1) {
      g.save();
      g.globalCompositeOperation = 'lighter';
      const fl = g.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, h * 0.75);
      fl.addColorStop(0, 'hsla(0,0%,0%,0)');
      fl.addColorStop(1, `hsla(${hue}, 100%, 65%, ${0.35 * (1 - flashAge)})`);
      g.fillStyle = fl;
      g.fillRect(0, 0, w, h);
      g.restore();
    }

    // Combo milestone popups: big comic word + combo count, easing in with
    // overshoot, fading out — placed above the road so tiles stay visible.
    g.save();
    g.textAlign = 'center';
    for (const p of this.popups) {
      const age = (now - p.born) / 1300;
      if (age >= 1) continue;
      const scaleIn = easeOutBack(Math.min(1, age * 4));
      const alpha = age < 0.65 ? 1 : 1 - (age - 0.65) / 0.35;
      g.save();
      g.translate(w / 2, h * 0.4);
      g.rotate(-0.04 + Math.sin(now / 130) * 0.015);
      g.scale(scaleIn, scaleIn);
      g.globalAlpha = alpha;
      g.font = `900 ${Math.round(15 * dpr)}px ${COMIC_FONT}`;
      g.fillStyle = 'rgba(255,255,255,0.75)';
      g.fillText(p.sub, 0, -30 * dpr);
      // Shrink long callouts to fit the screen width.
      const titleSize = Math.min(38, (w / dpr / p.title.length) * 1.55);
      g.font = `900 ${Math.round(titleSize * dpr)}px ${COMIC_FONT}`;
      g.lineJoin = 'round';
      g.lineWidth = 8 * dpr;
      g.strokeStyle = 'rgba(8, 5, 28, 0.92)';
      g.strokeText(p.title, 0, 0);
      const pg = g.createLinearGradient(0, -30 * dpr, 0, 10 * dpr);
      pg.addColorStop(0, '#fff7ae');
      pg.addColorStop(0.5, `hsl(${(hue + 140) % 360}, 100%, 68%)`);
      pg.addColorStop(1, `hsl(${hue}, 100%, 60%)`);
      g.fillStyle = pg;
      g.fillText(p.title, 0, 0);
      g.restore();
    }
    g.restore();

    // Pause button: visible pill, top-right
    const pw = 48 * dpr;
    const ph = 32 * dpr;
    const px = w - pw - 12 * dpr;
    const py = 12 * dpr;
    const pr = ph / 2;
    g.beginPath();
    g.moveTo(px + pr, py);
    g.lineTo(px + pw - pr, py);
    g.arc(px + pw - pr, py + pr, pr, -Math.PI / 2, Math.PI / 2);
    g.lineTo(px + pr, py + ph);
    g.arc(px + pr, py + pr, pr, Math.PI / 2, -Math.PI / 2);
    g.closePath();
    g.fillStyle = 'rgba(10, 8, 30, 0.55)';
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.4)';
    g.lineWidth = 1.2 * dpr;
    g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.9)';
    const bx = px + pw / 2 - 6.5 * dpr;
    const by = py + 9 * dpr;
    g.fillRect(bx, by, 4.5 * dpr, 14 * dpr);
    g.fillRect(bx + 8.5 * dpr, by, 4.5 * dpr, 14 * dpr);

    // Combo
    if (this.combo >= 2) {
      const age = Math.min(1, (now - this.lastComboChange) / 200);
      const pop = 1 + (1 - age) * 0.35;
      g.save();
      g.textAlign = 'center';
      g.globalAlpha = 0.92;
      g.fillStyle = `hsl(${hue - 20}, 100%, 78%)`;
      g.font = `900 ${Math.round(30 * dpr * pop)}px ${COMIC_FONT}`;
      g.fillText(String(this.combo), w / 2, h * 0.3);
      g.globalAlpha = 0.6;
      g.font = `700 ${Math.round(11 * dpr)}px system-ui, sans-serif`;
      g.fillText('COMBO', w / 2, h * 0.3 + 16 * dpr);
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

function keyLane(k: string): number {
  if (k === 'a' || k === 'j' || k === 'arrowleft' || k === '1') return 0;
  if (k === 's' || k === 'k' || k === 'arrowdown' || k === '2') return 1;
  if (k === 'd' || k === 'l' || k === 'arrowright' || k === '3') return 2;
  return -1;
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
