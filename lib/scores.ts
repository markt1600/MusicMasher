/** Per-device score records, kept in localStorage. */

export interface BestEntry {
  score: number;
  acc: number;
  maxCombo: number;
  grade: string;
}

const KEY = 'mm-best-v1';

function readAll(): Record<string, BestEntry> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, BestEntry>;
  } catch {
    return {};
  }
}

export function getAllBest(): Record<string, BestEntry> {
  return readAll();
}

export function getBest(songId: string): BestEntry | null {
  return readAll()[songId] ?? null;
}

/** Record a result; returns whether it's a new personal best for the song. */
export function submitScore(
  songId: string,
  entry: BestEntry
): { newBest: boolean; prev: BestEntry | null } {
  const all = readAll();
  const prev = all[songId] ?? null;
  if (!prev || entry.score > prev.score) {
    all[songId] = entry;
    try {
      localStorage.setItem(KEY, JSON.stringify(all));
    } catch {
      // storage full/blocked — non-fatal
    }
    return { newBest: true, prev };
  }
  return { newBest: false, prev };
}

/** Sum of personal bests across all songs — the cumulative score. */
export function totalScore(): number {
  return Object.values(readAll()).reduce((sum, e) => sum + (e.score || 0), 0);
}

// --- player identity for the shared scoreboards ----------------------------

const NAME_KEY = 'mm-player-name';

export function getPlayerName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setPlayerName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name.slice(0, 16).trim());
  } catch {
    // blocked storage — non-fatal
  }
}
