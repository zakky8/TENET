/**
 * Voice surface contracts — closes the OSS-agent voice gap.
 *
 * 2026-06-04 fetched competitor data: Decagon Voice 2.0 (sub-second
 * latency, outbound campaigns, voicemail handling) is the closed-
 * source benchmark; no OSS agent framework ships voice. TENET ships
 * the contracts + Twilio Media Streams handler + OpenAI Realtime
 * adapter (separately, in @tenet/voice-openai-realtime).
 *
 * Design altitude:
 *   - AudioChunk + AudioFormat — bytes-on-wire types, format-tagged
 *   - Asr / Tts — bytes ↔ text, both with streaming variants
 *   - VoiceSurface — the call-lifecycle contract surfaces implement
 *   - mulaw <-> PCM16 helpers — telephony codecs without a hard dep
 *   - bargeInDetector — energy-based VAD-lite for half-duplex turns
 *
 * Pure types + pure DSP helpers; no I/O. Provider adapters
 * (Deepgram, ElevenLabs, OpenAI Realtime, AssemblyAI) live as
 * separate packages and implement these contracts.
 */

// ── Audio types ───────────────────────────────────────────────────────

export type AudioFormat = 'pcm16' | 'mulaw' | 'opus' | 'mp3' | 'wav';
export type SampleRate = 8000 | 16000 | 24000 | 48000;

export interface AudioChunk {
  /** Raw bytes for the codec named by `format`. */
  bytes: Uint8Array;
  format: AudioFormat;
  sampleRate: SampleRate;
  /** Caller-supplied epoch-ms of capture. */
  capturedAtMs: number;
  /** Optional sequence number for ordering / retransmit. */
  seq?: number;
}

// ── ASR contract ──────────────────────────────────────────────────────

export interface AsrPartial {
  kind: 'partial';
  text: string;
}
export interface AsrFinal {
  kind: 'final';
  text: string;
  /** Provider confidence [0,1] when available. */
  confidence?: number;
  /** Word-level timestamps when available. */
  words?: ReadonlyArray<{ word: string; startMs: number; endMs: number }>;
}
export type AsrEvent = AsrPartial | AsrFinal;

/** Streaming transcription. Adapter pushes audio in, yields events out. */
export interface Asr {
  transcribe(stream: AsyncIterable<AudioChunk>, signal?: AbortSignal): AsyncIterable<AsrEvent>;
}

// ── TTS contract ──────────────────────────────────────────────────────

export interface TtsRequest {
  text: string;
  /** Operator-supplied voice id. */
  voiceId: string;
  /** Output format the caller wants the bytes in. */
  format: AudioFormat;
  sampleRate: SampleRate;
}

/** Streaming synthesis. Adapter yields chunks the surface plays back. */
export interface Tts {
  synthesize(req: TtsRequest, signal?: AbortSignal): AsyncIterable<AudioChunk>;
}

// ── Voice surface lifecycle ───────────────────────────────────────────

export interface VoiceCallContext {
  callId: string;
  tenantId: string;
  /** PSTN number (E.164) or 'webrtc://session-id' for browser calls. */
  from: string;
  to: string;
  /** Optional metadata from the surface (region, codec, etc.). */
  meta?: Readonly<Record<string, string | number | boolean>>;
}

export type VoiceCallEvent =
  | { kind: 'call.started'; ctx: VoiceCallContext; tMs: number }
  | { kind: 'call.audio_in'; callId: string; chunk: AudioChunk }
  | { kind: 'call.user_speech'; callId: string; final: AsrFinal; tMs: number }
  | { kind: 'call.barge_in'; callId: string; tMs: number }
  | { kind: 'call.ended'; callId: string; reason: 'hangup' | 'error' | 'timeout'; tMs: number };

export interface VoiceSurface {
  /** Surface-emitted events the orchestrator subscribes to. */
  events(): AsyncIterable<VoiceCallEvent>;
  /** Send synthesized audio back to the caller. */
  speak(callId: string, audio: AsyncIterable<AudioChunk>, signal?: AbortSignal): Promise<void>;
  /** End the call programmatically. */
  hangup(callId: string, reason?: string): Promise<void>;
}

// ── Errors ────────────────────────────────────────────────────────────

export class VoiceError extends Error {
  constructor(
    public readonly code: 'unsupported_format' | 'sample_rate_mismatch' | 'asr_failed' | 'tts_failed' | 'call_not_found',
    message: string,
  ) {
    super(message);
    this.name = 'VoiceError';
  }
}

// ── Codec helpers — μ-law (G.711) ↔ PCM16 ─────────────────────────────

// μ-law is the telephony default (Twilio Media Streams emits it). PCM16
// is what every ASR provider wants. We ship pure-JS conversion so the
// framework has no native-dep on libsndfile / ffmpeg.

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

/** Single-sample μ-law → 16-bit linear PCM. */
export function mulawToPcm16Sample(u: number): number {
  // Spec: ITU-T G.711, inverse of the encoder bit-flipping.
  const inverted = ~u & 0xff;
  const sign = (inverted & 0x80) !== 0 ? -1 : 1;
  const exponent = (inverted >> 4) & 0x07;
  const mantissa = inverted & 0x0f;
  const magnitude = ((mantissa << 3) + MULAW_BIAS) << exponent;
  return sign * (magnitude - MULAW_BIAS);
}

/** Single-sample 16-bit linear PCM → μ-law. */
export function pcm16ToMulawSample(sample: number): number {
  let s = sample;
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  if (s > MULAW_CLIP) s = MULAW_CLIP;
  s += MULAW_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

/** Convert a μ-law byte buffer to little-endian PCM16. */
export function mulawBytesToPcm16(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < bytes.length; i++) {
    view.setInt16(i * 2, mulawToPcm16Sample(bytes[i]!), true);
  }
  return out;
}

/** Convert little-endian PCM16 to μ-law. */
export function pcm16ToMulawBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.length % 2 !== 0) throw new VoiceError('unsupported_format', 'PCM16 must be even byte length');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Uint8Array(bytes.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = pcm16ToMulawSample(view.getInt16(i * 2, true));
  }
  return out;
}

// ── Barge-in detector — energy-based VAD-lite ─────────────────────────

/**
 * Detects when the user starts speaking over the agent's TTS playback.
 * Energy-based (RMS over a sliding window) is intentionally simple —
 * production deployments swap in a Silero-VAD model behind the same
 * `BargeInDetector` contract.
 *
 * Honest scope: this catches "user clearly speaking" in well-behaved
 * telephony audio. For noisy WebRTC channels or accent-heavy callers,
 * operators should swap in a model-based VAD.
 */
export interface BargeInConfig {
  /** Window size in samples. Default 160 (20 ms at 8 kHz). */
  windowSamples?: number;
  /** RMS threshold above which user speech is declared. Default 1500. */
  rmsThreshold?: number;
  /** Required consecutive windows above threshold. Default 3 (~60 ms). */
  consecutiveWindows?: number;
}

export interface BargeInDetector {
  /** Returns true when a barge-in is detected on the latest chunk. */
  feed(pcm16: Uint8Array): boolean;
  /** Reset between turns. */
  reset(): void;
}

export function makeEnergyBargeInDetector(config: BargeInConfig = {}): BargeInDetector {
  const windowSamples = config.windowSamples ?? 160;
  const threshold = config.rmsThreshold ?? 1500;
  const required = config.consecutiveWindows ?? 3;
  let buf: number[] = [];
  let consecutive = 0;
  return {
    feed(pcm16: Uint8Array): boolean {
      if (pcm16.byteLength % 2 !== 0) throw new VoiceError('unsupported_format', 'PCM16 must be even length');
      const view = new DataView(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
      for (let i = 0; i < pcm16.length / 2; i++) buf.push(view.getInt16(i * 2, true));
      while (buf.length >= windowSamples) {
        const window = buf.slice(0, windowSamples);
        buf = buf.slice(windowSamples);
        let sum = 0;
        for (const s of window) sum += s * s;
        const rms = Math.sqrt(sum / windowSamples);
        if (rms >= threshold) consecutive++;
        else consecutive = 0;
        if (consecutive >= required) {
          consecutive = 0;
          buf = [];
          return true;
        }
      }
      return false;
    },
    reset() {
      buf = [];
      consecutive = 0;
    },
  };
}

export const VERSION = '0.0.0';
