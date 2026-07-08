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
  STFT → spectral-flux onset detection with adaptive thresholds, plus a BPM
  estimate from autocorrelation. Charts are fully deterministic, so every
  player gets the same tiles for the same song.
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
  library. Combo milestones celebrate on screen as you stack them.
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
artists, and delete uploaded songs.
The default password is `yippy`; set the `ADMIN_PASSWORD` environment variable
in Vercel to change it. Deletion removes both the audio and its metadata for
everyone.

## Notes

- Max upload: 50 MB / 20 minutes; MP3, AAC, AIFF, or WAV. Files are validated
  by actually decoding them in the uploader's browser.
- Everything uploaded is public to all players by design.
