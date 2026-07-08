/**
 * Minimal iterative radix-2 FFT, sized once and reused across frames.
 * Only what beat analysis needs: forward transform of real input →
 * magnitude spectrum of the first N/2 bins.
 */
export class FFT {
  readonly size: number;
  private readonly cosTable: Float32Array;
  private readonly sinTable: Float32Array;
  private readonly reverseTable: Uint32Array;
  private readonly re: Float32Array;
  private readonly im: Float32Array;

  constructor(size: number) {
    if ((size & (size - 1)) !== 0) throw new Error('FFT size must be a power of 2');
    this.size = size;
    this.cosTable = new Float32Array(size / 2);
    this.sinTable = new Float32Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cosTable[i] = Math.cos((-2 * Math.PI * i) / size);
      this.sinTable[i] = Math.sin((-2 * Math.PI * i) / size);
    }
    this.reverseTable = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let rev = 0;
      for (let b = 0; b < bits; b++) rev = (rev << 1) | ((i >> b) & 1);
      this.reverseTable[i] = rev;
    }
    this.re = new Float32Array(size);
    this.im = new Float32Array(size);
  }

  /** Writes magnitudes of bins 0..size/2-1 into `out`. */
  magnitudes(input: Float32Array, out: Float32Array): void {
    const n = this.size;
    const { re, im, reverseTable, cosTable, sinTable } = this;
    for (let i = 0; i < n; i++) {
      re[i] = input[reverseTable[i]];
      im[i] = 0;
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const cos = cosTable[k];
          const sin = sinTable[k];
          const a = i + j;
          const b = a + half;
          const tre = re[b] * cos - im[b] * sin;
          const tim = re[b] * sin + im[b] * cos;
          re[b] = re[a] - tre;
          im[b] = im[a] - tim;
          re[a] += tre;
          im[a] += tim;
        }
      }
    }
    const bins = n >> 1;
    for (let i = 0; i < bins; i++) {
      out[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
    }
  }
}
