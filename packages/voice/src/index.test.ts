import {
  mulawToPcm16Sample,
  pcm16ToMulawSample,
  mulawBytesToPcm16,
  pcm16ToMulawBytes,
  makeEnergyBargeInDetector,
  VoiceError,
} from './index.js';

describe('μ-law codec', () => {
  it('round-trips PCM16 sample → mulaw → PCM16 within G.711 quantisation error', () => {
    // G.711 μ-law has ~8-bit precision in the small-magnitude band.
    // We check round-trip stays within a typical envelope, not bit-exact.
    const samples = [0, 100, 1000, 5000, 16000, 30000, -100, -1000, -16000, -30000];
    for (const s of samples) {
      const mu = pcm16ToMulawSample(s);
      const back = mulawToPcm16Sample(mu);
      // μ-law max error grows with magnitude — 8% is a generous envelope.
      const tol = Math.max(200, Math.abs(s) * 0.08);
      expect(Math.abs(back - s)).toBeLessThanOrEqual(tol);
    }
  });

  it('mulawBytesToPcm16 doubles byte length', () => {
    const mu = new Uint8Array([0xff, 0x7f, 0x00, 0x80]);
    const pcm = mulawBytesToPcm16(mu);
    expect(pcm.byteLength).toBe(mu.byteLength * 2);
  });

  it('pcm16ToMulawBytes halves byte length + rejects odd-length input', () => {
    const pcm = new Uint8Array(8); // 4 samples
    expect(pcm16ToMulawBytes(pcm).byteLength).toBe(4);
    expect(() => pcm16ToMulawBytes(new Uint8Array(7))).toThrow(VoiceError);
  });

  it('silence (PCM16 0) round-trips correctly', () => {
    const pcm = new Uint8Array(20); // 10 samples of zero
    const mu = pcm16ToMulawBytes(pcm);
    const back = mulawBytesToPcm16(mu);
    // Silence may round-trip to a small DC offset due to μ-law quantisation
    // but should stay within the small-magnitude envelope.
    const view = new DataView(back.buffer);
    for (let i = 0; i < back.length / 2; i++) {
      expect(Math.abs(view.getInt16(i * 2, true))).toBeLessThan(200);
    }
  });
});

describe('bargeInDetector — energy VAD', () => {
  // Build a PCM16 chunk of constant magnitude.
  function tone(samples: number, magnitude: number): Uint8Array {
    const buf = new Uint8Array(samples * 2);
    const view = new DataView(buf.buffer);
    for (let i = 0; i < samples; i++) view.setInt16(i * 2, magnitude, true);
    return buf;
  }

  it('returns false on quiet audio', () => {
    const det = makeEnergyBargeInDetector({ windowSamples: 160, rmsThreshold: 1500, consecutiveWindows: 3 });
    for (let i = 0; i < 10; i++) expect(det.feed(tone(160, 100))).toBe(false);
  });

  it('returns true after consecutiveWindows of loud audio', () => {
    const det = makeEnergyBargeInDetector({ windowSamples: 160, rmsThreshold: 1500, consecutiveWindows: 3 });
    // First two loud windows → still false
    expect(det.feed(tone(160, 3000))).toBe(false);
    expect(det.feed(tone(160, 3000))).toBe(false);
    // Third window crosses the consecutive threshold
    expect(det.feed(tone(160, 3000))).toBe(true);
  });

  it('resets consecutive counter on a quiet window', () => {
    const det = makeEnergyBargeInDetector({ windowSamples: 160, rmsThreshold: 1500, consecutiveWindows: 3 });
    det.feed(tone(160, 3000));
    det.feed(tone(160, 3000));
    expect(det.feed(tone(160, 100))).toBe(false); // resets
    expect(det.feed(tone(160, 3000))).toBe(false); // back to 1 consecutive
  });

  it('rejects odd-length PCM input', () => {
    const det = makeEnergyBargeInDetector();
    expect(() => det.feed(new Uint8Array(3))).toThrow(VoiceError);
  });

  it('reset() clears partial state', () => {
    const det = makeEnergyBargeInDetector({ windowSamples: 160, rmsThreshold: 1500, consecutiveWindows: 3 });
    det.feed(tone(160, 3000));
    det.feed(tone(160, 3000));
    det.reset();
    expect(det.feed(tone(160, 3000))).toBe(false); // counter cleared
  });
});
