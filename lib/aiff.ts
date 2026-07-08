/**
 * Minimal AIFF / AIFF-C decoder. Chrome and Firefox can't decode AIFF via
 * decodeAudioData (only Safari can), but AIFF is just PCM in an IFF
 * container, so we parse it ourselves and hand back an AudioBuffer that
 * works in every browser.
 *
 * Supports uncompressed PCM: 8/16/24/32-bit big-endian ints ('NONE'/'twos'),
 * little-endian 16-bit ('sowt'), and 32/64-bit floats ('fl32'/'fl64').
 */

export function looksLikeAiff(data: ArrayBuffer): boolean {
  if (data.byteLength < 12) return false;
  const v = new DataView(data);
  const tag = (off: number) =>
    String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
  return tag(0) === 'FORM' && (tag(8) === 'AIFF' || tag(8) === 'AIFC');
}

/** 80-bit IEEE 754 extended float (used for the sample rate in COMM). */
function readFloat80(v: DataView, off: number): number {
  const head = v.getUint16(off);
  const sign = head & 0x8000 ? -1 : 1;
  const exp = head & 0x7fff;
  const hi = v.getUint32(off + 2);
  const lo = v.getUint32(off + 6);
  if (exp === 0 && hi === 0 && lo === 0) return 0;
  const mantissa = hi * 2 ** 32 + lo;
  return sign * mantissa * 2 ** (exp - 16383 - 63);
}

export function decodeAiff(data: ArrayBuffer): AudioBuffer | null {
  try {
    if (!looksLikeAiff(data)) return null;
    const v = new DataView(data);
    const tag = (off: number) =>
      String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
    const isAifc = tag(8) === 'AIFC';

    let channels = 0;
    let frames = 0;
    let bits = 0;
    let sampleRate = 0;
    let compression = 'NONE';
    let ssndOff = -1;
    let ssndLen = 0;

    let off = 12;
    while (off + 8 <= data.byteLength) {
      const id = tag(off);
      const size = v.getUint32(off + 4);
      const body = off + 8;
      if (id === 'COMM') {
        channels = v.getUint16(body);
        frames = v.getUint32(body + 2);
        bits = v.getUint16(body + 6);
        sampleRate = readFloat80(v, body + 8);
        if (isAifc && size >= 22) compression = tag(body + 18);
      } else if (id === 'SSND') {
        const offset = v.getUint32(body);
        ssndOff = body + 8 + offset;
        ssndLen = size - 8 - offset;
      }
      off = body + size + (size % 2); // chunks are word-aligned
    }

    if (
      channels < 1 ||
      channels > 8 ||
      frames <= 0 ||
      ssndOff < 0 ||
      !Number.isFinite(sampleRate) ||
      sampleRate < 8000 ||
      sampleRate > 192000
    ) {
      return null;
    }

    const comp = compression.trim().toUpperCase();
    const littleEndian = comp === 'SOWT';
    const isFloat32 = comp === 'FL32';
    const isFloat64 = comp === 'FL64';
    if (!['NONE', 'SOWT', 'TWOS', 'FL32', 'FL64', ''].includes(comp)) {
      return null; // compressed AIFF-C (ulaw etc.) — let the browser try
    }
    if (isFloat32) bits = 32;
    if (isFloat64) bits = 64;
    const bytesPerSample = bits / 8;
    if (![1, 2, 3, 4, 8].includes(bytesPerSample)) return null;

    const available = Math.floor(ssndLen / (bytesPerSample * channels));
    const totalFrames = Math.min(frames, available);
    if (totalFrames <= 0) return null;

    const buffer = new AudioBuffer({
      numberOfChannels: channels,
      length: totalFrames,
      sampleRate,
    });

    const chans: Float32Array[] = [];
    for (let c = 0; c < channels; c++) chans.push(buffer.getChannelData(c));

    let p = ssndOff;
    for (let i = 0; i < totalFrames; i++) {
      for (let c = 0; c < channels; c++) {
        let s: number;
        if (isFloat64) s = v.getFloat64(p);
        else if (isFloat32) s = v.getFloat32(p);
        else if (bytesPerSample === 1) s = v.getInt8(p) / 0x80;
        else if (bytesPerSample === 2) s = v.getInt16(p, littleEndian) / 0x8000;
        else if (bytesPerSample === 3) {
          const b0 = v.getUint8(p);
          const b1 = v.getUint8(p + 1);
          const b2 = v.getUint8(p + 2);
          let val = littleEndian
            ? (b2 << 16) | (b1 << 8) | b0
            : (b0 << 16) | (b1 << 8) | b2;
          if (val & 0x800000) val -= 0x1000000;
          s = val / 0x800000;
        } else s = v.getInt32(p, littleEndian) / 0x80000000;
        chans[c][i] = Math.max(-1, Math.min(1, s));
        p += bytesPerSample;
      }
    }
    return buffer;
  } catch {
    return null;
  }
}

/**
 * Decode any supported audio file: AIFF via our own parser (Chrome/Firefox
 * lack native support), everything else via the browser's decoder.
 */
export async function decodeAudio(
  data: ArrayBuffer,
  ctx: BaseAudioContext
): Promise<AudioBuffer> {
  if (looksLikeAiff(data)) {
    const decoded = decodeAiff(data);
    if (decoded) return decoded;
    // Fall through — Safari can decode AIFF variants we don't handle.
  }
  return ctx.decodeAudioData(data);
}
