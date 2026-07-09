/**
 * Renders a shareable challenge card (1080×1080 PNG) in the game's neon
 * style: sky, mountains, glowing road, pads, album art, grade and score.
 */

export interface ShareCardData {
  /** Display title, e.g. "Song — Artist". */
  title: string;
  grade: string;
  score: number;
  acc: number;
  maxCombo: number;
  player: string;
  artUrl?: string | null;
  url: string;
}

const COMIC =
  `'Comic Sans MS', 'Chalkboard SE', 'Comic Neue', 'Marker Felt', ` +
  `ui-rounded, system-ui, sans-serif`;

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export async function renderShareCard(d: ShareCardData): Promise<Blob | null> {
  try {
    const S = 1080;
    const canvas = document.createElement('canvas');
    canvas.width = S;
    canvas.height = S;
    const g = canvas.getContext('2d');
    if (!g) return null;

    // --- sky -----------------------------------------------------------------
    const sky = g.createLinearGradient(0, 0, 0, S);
    sky.addColorStop(0, '#0a0524');
    sky.addColorStop(0.45, '#140a38');
    sky.addColorStop(0.62, '#0b3038');
    sky.addColorStop(1, '#07031a');
    g.fillStyle = sky;
    g.fillRect(0, 0, S, S);

    // stars
    for (let i = 0; i < 90; i++) {
      g.globalAlpha = 0.25 + Math.random() * 0.6;
      g.fillStyle = '#dff6ff';
      g.beginPath();
      g.arc(Math.random() * S, Math.random() * S * 0.5, 1 + Math.random() * 2, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;

    // sun glow on the horizon
    const horizonY = S * 0.56;
    const sun = g.createRadialGradient(S / 2, horizonY, 20, S / 2, horizonY, 260);
    sun.addColorStop(0, 'hsla(178, 100%, 78%, 0.9)');
    sun.addColorStop(0.3, 'hsla(178, 95%, 62%, 0.4)');
    sun.addColorStop(1, 'hsla(0,0%,0%,0)');
    g.fillStyle = sun;
    g.fillRect(S / 2 - 300, horizonY - 300, 600, 600);

    // mountains
    g.fillStyle = '#0b1226';
    g.beginPath();
    g.moveTo(0, horizonY);
    for (let i = 0; i <= 12; i++) {
      g.lineTo((i / 12) * S, horizonY - Math.abs(Math.sin(i * 2.3)) * 70 * (0.5 + (i % 3) * 0.3));
    }
    g.lineTo(S, horizonY);
    g.closePath();
    g.fill();

    // road
    const roadHalf = S * 0.34;
    const road = g.createLinearGradient(0, horizonY, 0, S);
    road.addColorStop(0, 'hsla(190, 70%, 30%, 0.1)');
    road.addColorStop(1, 'hsla(210, 55%, 8%, 0.85)');
    g.fillStyle = road;
    g.beginPath();
    g.moveTo(S / 2, horizonY);
    g.lineTo(S / 2 - roadHalf, S);
    g.lineTo(S / 2 + roadHalf, S);
    g.closePath();
    g.fill();
    g.strokeStyle = 'hsla(185, 100%, 62%, 0.9)';
    g.lineWidth = 6;
    for (const side of [-1, 1]) {
      g.beginPath();
      g.moveTo(S / 2, horizonY);
      g.lineTo(S / 2 + side * roadHalf, S);
      g.stroke();
    }

    // pads
    const padHues = [185, 310, 38];
    for (let lane = 0; lane < 3; lane++) {
      const x = S / 2 + (lane - 1) * roadHalf * 0.62;
      const y = S * 0.94;
      const hue = padHues[lane];
      g.fillStyle = `hsl(${hue}, 90%, 16%)`;
      g.beginPath();
      g.ellipse(x, y + 12, 64, 25, 0, 0, Math.PI * 2);
      g.fill();
      const top = g.createRadialGradient(x - 18, y - 10, 8, x, y, 74);
      top.addColorStop(0, `hsl(${hue}, 100%, 74%)`);
      top.addColorStop(1, `hsl(${hue}, 95%, 42%)`);
      g.fillStyle = top;
      g.beginPath();
      g.ellipse(x, y, 64, 25, 0, 0, Math.PI * 2);
      g.fill();
    }

    // a couple of falling tiles
    for (const [fr, lane] of [
      [0.28, 0],
      [0.46, 2],
      [0.9, 1],
    ] as [number, number][]) {
      const pr = 0.18 + fr * 0.82;
      const y = horizonY + (S * 0.94 - horizonY) * fr;
      const x = S / 2 + (lane - 1) * roadHalf * 0.62 * pr;
      const half = 52 * pr;
      const hue = padHues[lane];
      g.fillStyle = `hsl(${hue}, 100%, 62%)`;
      g.beginPath();
      g.roundRect(x - half, y - half * 0.7, half * 2, half * 1.4, 10 * pr);
      g.fill();
    }

    // --- text helpers ----------------------------------------------------------
    const comic = (px: number) => `900 ${px}px ${COMIC}`;
    const outlined = (text: string, x: number, y: number, px: number, fill: string | CanvasGradient) => {
      g.font = comic(px);
      g.textAlign = 'center';
      g.lineJoin = 'round';
      g.lineWidth = px * 0.18;
      g.strokeStyle = 'rgba(8, 5, 28, 0.95)';
      g.strokeText(text, x, y);
      g.fillStyle = fill;
      g.fillText(text, x, y);
    };

    // logo
    const logoGrad = g.createLinearGradient(S * 0.3, 0, S * 0.7, 0);
    logoGrad.addColorStop(0, '#37f5e4');
    logoGrad.addColorStop(0.6, '#b44dff');
    logoGrad.addColorStop(1, '#ff4dd2');
    outlined('MusicMasher', S / 2, 96, 64, logoGrad);

    // album art
    let textTop = 150;
    if (d.artUrl) {
      const img = await loadImage(d.artUrl);
      if (img) {
        const size = 190;
        const x = S / 2 - size / 2;
        const y = 130;
        g.save();
        g.beginPath();
        g.roundRect(x, y, size, size, 28);
        g.clip();
        g.drawImage(img, x, y, size, size);
        g.restore();
        g.strokeStyle = 'rgba(140, 160, 255, 0.6)';
        g.lineWidth = 4;
        g.beginPath();
        g.roundRect(x, y, size, size, 28);
        g.stroke();
        textTop = 370;
      }
    }

    // song title (ellipsized)
    let title = d.title;
    g.font = `800 44px system-ui, sans-serif`;
    while (g.measureText(title).width > S * 0.86 && title.length > 4) {
      title = title.slice(0, -2);
    }
    if (title !== d.title) title += '…';
    g.textAlign = 'center';
    g.fillStyle = '#eef2ff';
    g.fillText(title, S / 2, textTop + 20);

    // grade + score
    const gradeGrad = g.createLinearGradient(0, textTop + 60, 0, textTop + 240);
    gradeGrad.addColorStop(0, '#ffffff');
    gradeGrad.addColorStop(0.6, '#37f5e4');
    gradeGrad.addColorStop(1, '#b44dff');
    outlined(d.grade, S / 2, textTop + 230, 190, gradeGrad);
    outlined(d.score.toLocaleString(), S / 2, textTop + 330, 84, '#ffffff');
    g.font = `700 34px system-ui, sans-serif`;
    g.fillStyle = 'rgba(238, 242, 255, 0.75)';
    g.fillText(
      `accuracy ${d.acc.toFixed(1)}%  ·  best combo ${d.maxCombo}`,
      S / 2,
      textTop + 385
    );

    // challenge line
    outlined(`👻 ${d.player} challenges you!`, S / 2, S * 0.795, 46, '#ffd76e');
    g.font = `700 30px system-ui, sans-serif`;
    g.fillStyle = 'rgba(238, 242, 255, 0.65)';
    g.fillText('Can you beat this score?', S / 2, S * 0.795 + 44);

    return await new Promise((res) => canvas.toBlob(res, 'image/png'));
  } catch {
    return null;
  }
}
