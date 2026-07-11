# 🎵 MusicMasher

A beat-synced, pseudo-3D tile rhythm game for the web. Drop in a song —
**MP3, AAC (.aac/.m4a), AIFF, or WAV** — it's stored server-side so everyone
can play it, and MusicMasher analyzes the audio and generates a tap chart
synced to the music. Tiles rush down a neon highway toward you; tap the three
lanes as they cross the line. The chart gets denser, faster, and starts
throwing two-tile chords as the song builds. Pick any song from the shared
library, or hit **🎲 Random** to let the game choose.

Built for mobile touch screens first, with full desktop keyboard support.

## How it works

- **Track info** — embedded tags (ID3, MP4 atoms, RIFF INFO, AIFF chunks) are
  read in the browser at upload time via `music-metadata`. If the file doesn't
  carry a track name and artist, the uploader is prompted to fill them in.
- **Uploads** — audio files are uploaded directly from the browser to
  [Vercel Blob](https://vercel.com/docs/storage/vercel-blob) (bypassing the
  4.5 MB serverless body limit), and a small `meta.json` is registered per
  song to build the shared library. In local dev without a Blob token, files
  are stored on disk under `.data/` instead — no config needed.
- **Beat detection** — runs client-side with the Web Audio API: mono downmix →
  STFT → spectral-flux onset detection with adaptive thresholds, a BPM
  estimate from autocorrelation, and a fitted beat grid (tempo + phase +
  downbeats). When the tempo fit is confident, notes quantize to 16th-note
  subdivisions so tiles land squarely on the music, chords prefer downbeats,
  and chart density follows the song's energy arc (drops dense, bridges
  sparse). Charts are fully deterministic, so every player gets the same
  tiles — and the first player's chart is cached server-side so everyone
  after loads instantly.
- **Album art** — cover art embedded in the file's tags is extracted at
  upload, downscaled in the browser, and shown in the library and on the
  song's ready screen.
- **Ghost battles** — your best runs are recorded as replays. Playing a song
  automatically races the world-record holder's ghost (live score + hit
  sparks), and a "Challenge friends" button shares a link that races *your*
  ghost: `/play/<song>?vs=<name>`.
- **PWA** — installable to the home screen (manifest + service worker),
  vibration feedback on hits and milestones where supported, and automatic
  audio output-latency compensation on top of the manual offset.
- **Difficulty ramp** — early in a song only the strongest beats become tiles
  with generous spacing; as the song progresses the density threshold drops,
  minimum spacing shrinks (0.42 s → 0.16 s), scroll speed increases, and
  chords appear.
- **Tile variety, driven by the music** — quick double-hits in the audio
  become split **double-tap** tiles; sustained loud stretches become **hold**
  tiles you ride; rapid fills become alternating **streams**; accented hits
  occasionally spawn a spinning iridescent **bonus gem** worth extra points.
  All of it ramps up with song progress.
- **Scores** — per-song personal bests and a cumulative total score are kept
  on your device; shared play counts power a "Most played" sort in the
  library. Combo milestones celebrate on screen as you stack them, and world
  records plus a cumulative all-players leaderboard persist server-side.
- **Gauntlet mode** — survive 5 randomly-chosen songs of rising difficulty
  (denser charts, faster scroll) to win. Each stage plays in a different
  world — synthwave, city, beach, space, aurora — each with its own
  combo-driven sky spectacle (shooting stars, fireworks, rockets, UFOs,
  birds, balloons, helicopters, comets). A stage needs ≥60% accuracy to
  advance.
- **Survival** — miss more than 70% of the notes over any trailing 10
  seconds and it's game over; past 30% a pulsing DANGER bar counts down how
  close you are to the edge.
- **Rendering** — a single 2D canvas with a hand-rolled perspective
  projection: a three-lane road converging on a horizon vanishing point,
  glowing tiles, hit rings, particles, a sun that pulses with the song's
  loudness envelope, and a color palette that drifts from teal to pink as the
  song intensifies. The AudioContext clock drives everything, so visuals and
  judging can't drift from the music.
- **Demo track** — "Neon Dreams" is synthesized in the browser with an
  OfflineAudioContext, so the game is playable before anyone uploads a song
  (and no audio files ship in the repo).

## Controls

| Input | Lanes |
| --- | --- |
| Touch | tap the left / middle / right of the screen (multi-touch for chords) |
| Keyboard | `A S D`, `J K L`, `← ↓ →`, or `1 2 3` |
| Pause | `Esc` / `P` or the pause button |

If hits feel consistently early or late (e.g. on Bluetooth audio), adjust the
audio offset from the pause menu — it's saved per device.

## Development

```bash
npm install
npm run dev
```

Open http://localhost:3000. Uploads are stored in `.data/` (gitignored).

## Deploying to Vercel

1. Push this repo to GitHub and import it into Vercel (defaults are fine).
2. In the Vercel dashboard: **Storage → Create Database → Blob**, and connect
   it to the project. This sets the `BLOB_READ_WRITE_TOKEN` environment
   variable automatically.
3. Redeploy. Uploads now go to Blob storage and are shared by all players.

Without a Blob store the app still runs, but uploads fail on Vercel (the
serverless filesystem is ephemeral) — the Blob store is the one required
piece of setup.

## Admin

`/admin` (also linked from the library footer) lets you edit song titles and
artists, delete uploaded songs, and open the **Chart Studio** for any song:
the song plays while you tap the lanes where tiles should fall (long-press to
place hold tiles), taps are quantized to the beat grid, and after previewing
you can save the take as the song's chart — a hand-authored, pre-determined
level that replaces procedural generation for every player (removable to
revert). Saved charts reload for editing, and a scrubber lets you punch-in
re-record from any point, keeping everything before it (with a 3-second
audio run-up). It's password-protected: the password is
whatever the `ADMIN_PASSWORD` environment variable is set to (in Vercel, or
`.env.local` for local dev). If the variable isn't set, admin features are
disabled entirely. Deletion removes both the audio and its metadata for
everyone.

## Notes

- Max upload: 50 MB / 20 minutes; MP3, AAC, AIFF, or WAV. Files are validated
  by actually decoding them in the uploader's browser.
- Everything uploaded is public to all players by design.
