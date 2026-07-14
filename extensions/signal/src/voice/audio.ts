// PCM format bridging between the signal-ts AudioBridge (48 kHz s16le stereo) and
// the realtime voice model (24 kHz s16le mono). Uses resamplePcm from the shared
// realtime-voice seam plus mono<->stereo folding, mirroring the Discord voice
// template (extensions/discord/src/voice/audio.ts).
import { resamplePcm } from "openclaw/plugin-sdk/realtime-voice";

const SIGNAL_SAMPLE_RATE = 48_000;
const REALTIME_SAMPLE_RATE = 24_000;
/** s16le stereo frame (both channels) on the signal-ts ear stream. */
export const SIGNAL_STEREO_FRAME_BYTES = 4; // 2 channels * s16
/** s16le mono sample on the realtime model's audio streams. */
export const REALTIME_MONO_SAMPLE_BYTES = 2; // s16
const MONO_SAMPLE_BYTES = 2; // s16

/**
 * Splits a byte stream into whole-frame chunks, carrying the sub-frame remainder
 * into the next call. Raw OS pipe reads (pacat/parec stdout) and provider PCM
 * deltas arrive on arbitrary byte boundaries; feeding an unaligned buffer to the
 * converters would drop a sample every chunk and, on an odd split, byte-shift the
 * rest of the stream into noise. Callers keep the returned `residual` per stream.
 */
export function takeAlignedFrames(
  residual: Buffer,
  chunk: Buffer,
  frameBytes: number,
): { frames: Buffer; residual: Buffer } {
  const combined = residual.length === 0 ? chunk : Buffer.concat([residual, chunk]);
  const usable = combined.length - (combined.length % frameBytes);
  return {
    frames: combined.subarray(0, usable),
    // Copy so the retained remainder does not pin the whole combined/chunk buffer.
    residual: usable === combined.length ? EMPTY_BUFFER : Buffer.from(combined.subarray(usable)),
  };
}

const EMPTY_BUFFER = Buffer.alloc(0);

/** 48 kHz stereo (from RingRTC playback via OUTPUT_SINK.monitor) -> 24 kHz mono (to the model). */
export function convertSignalPcm48kStereoToRealtimePcm24kMono(pcm: Buffer): Buffer {
  const frameCount = Math.floor(pcm.length / SIGNAL_STEREO_FRAME_BYTES);
  if (frameCount === 0) {
    return Buffer.alloc(0);
  }
  const mono48k = Buffer.alloc(frameCount * MONO_SAMPLE_BYTES);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const offset = frame * SIGNAL_STEREO_FRAME_BYTES;
    const left = pcm.readInt16LE(offset);
    const right = pcm.readInt16LE(offset + MONO_SAMPLE_BYTES);
    mono48k.writeInt16LE(Math.round((left + right) / 2), frame * MONO_SAMPLE_BYTES);
  }
  return resamplePcm(mono48k, SIGNAL_SAMPLE_RATE, REALTIME_SAMPLE_RATE);
}

/** 24 kHz mono (model TTS) -> 48 kHz stereo (to RingRTC capture via INPUT_SINK). */
export function convertRealtimePcm24kMonoToSignalPcm48kStereo(pcm: Buffer): Buffer {
  const mono48k = resamplePcm(pcm, REALTIME_SAMPLE_RATE, SIGNAL_SAMPLE_RATE);
  const sampleCount = Math.floor(mono48k.length / MONO_SAMPLE_BYTES);
  if (sampleCount === 0) {
    return Buffer.alloc(0);
  }
  const stereo = Buffer.alloc(sampleCount * SIGNAL_STEREO_FRAME_BYTES);
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const sample = mono48k.readInt16LE(sampleIndex * MONO_SAMPLE_BYTES);
    const offset = sampleIndex * SIGNAL_STEREO_FRAME_BYTES;
    stereo.writeInt16LE(sample, offset);
    stereo.writeInt16LE(sample, offset + MONO_SAMPLE_BYTES);
  }
  return stereo;
}
