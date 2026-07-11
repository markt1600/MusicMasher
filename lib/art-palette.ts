/**
 * Extract the dominant hues from a song's album art so the game can tint
 * the sky, road and scenery to match. Runs entirely in the browser on a
 * tiny downscale; grays and near-blacks don't get a vote.
 */
export async function extractArtHues(url: string): Promise<number[] | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const S = 24;
        const c = document.createElement('canvas');
        c.width = S;
        c.height = S;
        const g = c.getContext('2d');
        if (!g) return resolve(null);
        g.drawImage(img, 0, 0, S, S);
        const data = g.getImageData(0, 0, S, S).data;

        // Saturation×value-weighted hue histogram in 10° buckets.
        const histo = new Float32Array(36);
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i] / 255;
          const gr = data[i + 1] / 255;
          const b = data[i + 2] / 255;
          const mx = Math.max(r, gr, b);
          const mn = Math.min(r, gr, b);
          const d = mx - mn;
          const s = mx === 0 ? 0 : d / mx;
          if (s < 0.25 || mx < 0.18) continue;
          let hDeg: number;
          if (d === 0) continue;
          else if (mx === r) hDeg = 60 * (((gr - b) / d + 6) % 6);
          else if (mx === gr) hDeg = 60 * ((b - r) / d + 2);
          else hDeg = 60 * ((r - gr) / d + 4);
          histo[Math.floor(((hDeg + 360) % 360) / 10)] += s * mx;
        }

        const order = Array.from(histo.keys()).sort((a, b) => histo[b] - histo[a]);
        if (histo[order[0]] <= 0.5) return resolve(null); // art is basically gray
        const hues = [order[0] * 10 + 5];
        // A second hue only counts if it's clearly a different color.
        for (const k of order.slice(1)) {
          const dd = Math.abs(k - order[0]);
          if (Math.min(dd, 36 - dd) >= 6 && histo[k] > 0.5) {
            hues.push(k * 10 + 5);
            break;
          }
        }
        resolve(hues);
      } catch {
        resolve(null); // tainted canvas or decode failure — skip theming
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
