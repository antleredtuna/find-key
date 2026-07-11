/* js/pipeline.js
 *
 * The analytical core, structured as explicit, serializable stages:
 *
 *   raw frame  ->  gate  ->  coalesced note  ->  chroma  ->  key table
 *
 * Every stage boundary produces plain, serializable data. Nothing important
 * lives only inside a closure or only as pixels on a canvas. This is what
 * makes "export a labeled capture and hand it to Claude" a trivial serialize
 * rather than a retrofit.
 *
 * NONE of the theoretically-unsound machinery from v2 survives here:
 *   - no octave reweighting of the chroma
 *   - no clarity-as-continuous-multiplier
 *   - no minNote discarding of valid pitches
 *   - no key-prevalence multipliers
 * Clarity is used ONLY as a detection gate. The chroma is built from real
 * note durations (Krumhansl's original formulation) or plain note counts.
 */

import { freqToNote } from './theory.js';

// ===========================================================================
// Stage 1: Detector wrapper (pitchy / McLeod Pitch Method)
//
// Decouples analysis hops from render frames. v2 re-read the same 4096-sample
// buffer every animation frame (~16ms) even though the buffer represents
// ~85ms of audio at 48kHz, producing ~5-6 near-duplicate "samples" per
// genuinely independent observation and silently inflating durations. Here we
// only emit a new raw frame when at least `hopMs` has elapsed, so each frame
// is (close to) an independent observation and elapsed-time duration
// accounting is honest.
// ===========================================================================

export class PitchyDetector {
  /**
   * @param {object} [opts]
   * @param {number} [opts.fftSize=4096] - analyser window length in samples
   * @param {number} [opts.clarityThreshold=0.80] - min NSDF clarity to accept
   * @param {number} [opts.minHz=30]  - reject detections below this
   * @param {number} [opts.maxHz=5000] - reject detections above this
   */
  constructor(opts = {}) {
    this.name = 'pitchy';
    this.fftSize = opts.fftSize ?? 4096;
    this.clarityThreshold = opts.clarityThreshold ?? 0.80;
    this.minHz = opts.minHz ?? 30;
    this.maxHz = opts.maxHz ?? 5000;

    this.analyserNode = null;
    this.detector = null;
    this.inputBuffer = null;
    this.sampleRate = 0;
    this._source = null;
  }

  async init(audioContext, stream) {
    console.log('[PitchyDetector] Initializing...');
    const { PitchDetector } = await import('https://esm.sh/pitchy@4');

    this.sampleRate = audioContext.sampleRate;
    this.analyserNode = audioContext.createAnalyser();
    this.analyserNode.fftSize = this.fftSize;

    this._source = audioContext.createMediaStreamSource(stream);
    this._source.connect(this.analyserNode);

    const bufLen = this.analyserNode.fftSize;
    this.detector = PitchDetector.forFloat32Array(bufLen);
    this.inputBuffer = new Float32Array(bufLen);

    // The analysis window duration is a real, physical quantity worth knowing:
    // it bounds our time resolution and explains why very short notes coalesce.
    this.windowMs = (bufLen / this.sampleRate) * 1000;
    console.log(
      `[PitchyDetector] Ready. SR=${this.sampleRate}, buf=${bufLen}, window=${this.windowMs.toFixed(1)}ms`
    );
  }

  /**
   * Read one analysis window and return a raw frame: RMS volume, detected
   * frequency (or null), and clarity. Fills inputBuffer once and derives both
   * RMS and pitch from the same samples, so they describe the same instant.
   *
   * @returns {{ rms:number, frequency:(number|null), clarity:number }}
   */
  read() {
    if (!this.analyserNode || !this.detector) {
      return { rms: 0, frequency: null, clarity: 0 };
    }

    this.analyserNode.getFloatTimeDomainData(this.inputBuffer);

    // RMS volume of this window.
    let sumSq = 0;
    for (let i = 0; i < this.inputBuffer.length; i++) {
      sumSq += this.inputBuffer[i] * this.inputBuffer[i];
    }
    const rms = Math.sqrt(sumSq / this.inputBuffer.length);

    // Pitch via McLeod Pitch Method. clarity is the NSDF peak height in [0,1].
    const [pitch, clarity] = this.detector.findPitch(this.inputBuffer, this.sampleRate);

    let frequency = pitch;
    if (clarity < this.clarityThreshold || pitch < this.minHz || pitch > this.maxHz) {
      frequency = null; // detection rejected at the source
    }

    return { rms, frequency, clarity };
  }

  destroy() {
    if (this._source) {
      this._source.disconnect();
      this._source = null;
    }
    this.analyserNode = null;
    this.detector = null;
    this.inputBuffer = null;
  }
}

// ===========================================================================
// Stage 2: Gate
//
// A frame is ACCEPTED for musical accumulation only if it is loud enough
// (above the noise floor) AND carries a valid pitch (which already implies
// it cleared the clarity threshold in the detector). Every rejection is
// recorded with a reason, because "why did it ignore my singing?" must be
// answerable from the exported data.
// ===========================================================================

export const GateReason = Object.freeze({
  ACCEPTED: 'accepted',
  BELOW_NOISE_FLOOR: 'below_noise_floor',
  NO_PITCH: 'no_pitch', // failed clarity / range inside the detector
});

/**
 * Classify a raw frame against the noise floor.
 * @param {{rms:number, frequency:(number|null)}} rawFrame
 * @param {number} noiseFloor - RMS threshold below which we treat as silence
 * @returns {string} a GateReason
 */
export function gateFrame(rawFrame, noiseFloor) {
  if (rawFrame.rms < noiseFloor) return GateReason.BELOW_NOISE_FLOOR;
  if (rawFrame.frequency === null) return GateReason.NO_PITCH;
  return GateReason.ACCEPTED;
}

// ===========================================================================
// Stage 3: Note coalescing
//
// Frame-level detections are collapsed into note EVENTS. A note continues
// while consecutive accepted frames stay within +/-1 semitone of the same
// pitch class; otherwise the current note is committed and a new one begins.
// Each committed note carries its real start/end timestamps, so duration is
// measured in seconds of wall-clock audio, not in frame counts.
//
// Silence (a run of rejected frames) also commits the current note.
// ===========================================================================

export class NoteCoalescer {
  /**
   * @param {object} [opts]
   * @param {number} [opts.minDurationMs=50] - notes shorter than this are
   *        discarded as flutter rather than committed. This is an anti-noise
   *        measure on note EVENTS, not a discard of pitch classes.
   * @param {number} [opts.refA=440] - tuning reference passed to freqToNote
   */
  constructor(opts = {}) {
    this.minDurationMs = opts.minDurationMs ?? 50;
    this.refA = opts.refA ?? 440;

    /** @type {CoalescedNote[]} committed notes, most-recent-first */
    this.notes = [];
    /** @type {(object|null)} in-progress note accumulator */
    this._current = null;
  }

  /**
   * Feed one ACCEPTED frame (must have a valid frequency).
   * @param {number} timestamp - ms epoch (Date.now())
   * @param {number} frequency - Hz
   * @param {number} clarity - NSDF clarity in [0,1] (retained for inspection)
   * @returns {{committed: (CoalescedNote|null)}} a note if one was just committed
   */
  addFrame(timestamp, frequency, clarity) {
    const info = freqToNote(frequency, this.refA);
    let committed = null;

    const isContinuation =
      this._current &&
      this._current.pitchClass === info.pitchClass &&
      Math.abs(this._current.midi - info.midi) <= 1;

    if (isContinuation) {
      const c = this._current;
      c.endTime = timestamp;
      c.frameCount += 1;
      // Running means for average frequency and clarity.
      c.avgFrequency += (frequency - c.avgFrequency) / c.frameCount;
      c.avgClarity += (clarity - c.avgClarity) / c.frameCount;
    } else {
      committed = this._commit();
      this._current = {
        startTime: timestamp,
        endTime: timestamp,
        pitchClass: info.pitchClass,
        name: info.name,
        octave: info.octave,
        midi: info.midi,
        avgFrequency: frequency,
        avgClarity: clarity,
        frameCount: 1,
      };
    }

    return { committed };
  }

  /**
   * Commit the in-progress note if it meets the minimum-duration bar.
   * Returns the committed note, or null if there was nothing to commit or it
   * was too short.
   * @returns {(CoalescedNote|null)}
   */
  _commit() {
    const c = this._current;
    this._current = null;
    if (!c) return null;

    const durationMs = c.endTime - c.startTime;
    // A single-frame note has zero elapsed span but is real if the detector
    // saw it; give it the analyser window as a minimum plausible duration is
    // tempting, but that guesses. Instead we simply require >= minDurationMs
    // of ACTUAL elapsed time across >= 2 frames. Very short blips are dropped.
    if (durationMs < this.minDurationMs) {
      return null;
    }

    const note = {
      startTime: c.startTime,
      endTime: c.endTime,
      durationMs,
      durationSec: durationMs / 1000,
      pitchClass: c.pitchClass,
      name: c.name,
      octave: c.octave,
      midi: c.midi,
      avgFrequency: c.avgFrequency,
      avgClarity: c.avgClarity,
      frameCount: c.frameCount,
    };

    this.notes.unshift(note);
    // Cap retained history to avoid unbounded growth in long sessions.
    if (this.notes.length > 1000) this.notes.length = 1000;

    return note;
  }

  /** Force-commit the in-progress note (call on silence or on stop). */
  flush() {
    return this._commit();
  }

  /**
   * Snapshot of the in-progress note as a note-shaped object (for live graph
   * rendering and for the histogram to include the currently-sounding note).
   * @param {number} now - current ms epoch
   * @returns {(CoalescedNote|null)}
   */
  peekCurrent(now) {
    const c = this._current;
    if (!c) return null;
    const durationMs = now - c.startTime;
    return {
      startTime: c.startTime,
      endTime: now,
      durationMs,
      durationSec: durationMs / 1000,
      pitchClass: c.pitchClass,
      name: c.name,
      octave: c.octave,
      midi: c.midi,
      avgFrequency: c.avgFrequency,
      avgClarity: c.avgClarity,
      frameCount: c.frameCount,
      inProgress: true,
    };
  }

  clear() {
    this.notes = [];
    this._current = null;
  }
}

// ===========================================================================
// Stage 4: Chroma builders (swappable lenses)
//
// Each builder maps a list of coalesced notes to a length-12 pitch-class
// distribution. Both modes here are defensible in the literature:
//
//   'duration' : sum of note durations (seconds) per pitch class.
//                This is Krumhansl's original formulation.
//   'count'    : each note contributes 1, regardless of length.
//                Closer to some symbolic-music implementations.
//
// Builders are pure functions of (notes, options). They never look at octave
// height or clarity to weight the chroma — that would break K-S invariance.
// A time window may be applied to consider only recent notes.
// ===========================================================================

export const CHROMA_MODES = Object.freeze(['duration', 'count']);

/**
 * Build a 12-bin chroma from coalesced notes.
 * @param {CoalescedNote[]} notes - committed notes (any order)
 * @param {object} [opts]
 * @param {string} [opts.mode='duration'] - 'duration' | 'count'
 * @param {number} [opts.windowSec=0] - if > 0, only include notes whose
 *        endTime is within the last windowSec seconds
 * @param {(CoalescedNote|null)} [opts.current=null] - in-progress note to include
 * @param {number} [opts.now=Date.now()] - reference time for windowing
 * @returns {number[]} length-12 chroma
 */
export function buildChroma(notes, opts = {}) {
  const mode = opts.mode ?? 'duration';
  const windowSec = opts.windowSec ?? 0;
  const current = opts.current ?? null;
  const now = opts.now ?? Date.now();

  const chroma = new Array(12).fill(0);
  const cutoff = windowSec > 0 ? now - windowSec * 1000 : 0;

  const contribute = (note) => {
    if (cutoff > 0 && note.endTime < cutoff) return;
    if (mode === 'count') {
      chroma[note.pitchClass] += 1;
    } else {
      // 'duration' (default)
      chroma[note.pitchClass] += note.durationSec;
    }
  };

  for (const note of notes) contribute(note);
  if (current) contribute(current);

  return chroma;
}

// ===========================================================================
// Bounded labeled capture
//
// A deliberately-triggered, bounded recording of a session for offline
// analysis. The user labels it (e.g. "Am - known"), records for a bounded
// window, and exports a self-contained JSON bundle containing every stage's
// data. No continuous unbounded logging — capture only happens between
// start() and stop().
// ===========================================================================

export class CaptureBuffer {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxFrames=6000] - hard cap on retained raw frames
   *        (~100s at a 60fps-ish hop; protects memory if a capture is left on)
   */
  constructor(opts = {}) {
    this.maxFrames = opts.maxFrames ?? 6000;
    this.active = false;
    this.label = '';
    this.startedAt = null;
    /** @type {object[]} every raw+gate frame during the capture */
    this.frames = [];
    /** @type {object} snapshot of settings in effect during capture */
    this.settings = null;
  }

  start(label, settings) {
    this.active = true;
    this.label = label || '';
    this.startedAt = Date.now();
    this.frames = [];
    this.settings = { ...settings };
    console.log(`[CaptureBuffer] Started capture "${this.label}"`);
  }

  /**
   * Record one frame (called every hop while active). We store the raw
   * detector output plus the gate decision; notes and chroma are derived at
   * export time from the same coalescer the live app uses, OR we can store a
   * final snapshot. Here we store frames; the caller supplies note/chroma
   * snapshots at stop().
   */
  recordFrame(frame) {
    if (!this.active) return;
    if (this.frames.length >= this.maxFrames) {
      // Stop growing but keep the capture valid; warn once.
      if (!this._cappedWarned) {
        console.warn(`[CaptureBuffer] Frame cap ${this.maxFrames} reached; capture truncated.`);
        this._cappedWarned = true;
      }
      return;
    }
    this.frames.push(frame);
  }

  /**
   * Finalize the capture into an exportable bundle.
   * @param {object} snapshots - { notes, chromas, keyTable } computed by caller
   * @returns {object} self-contained, JSON-serializable bundle
   */
  stop(snapshots = {}) {
    this.active = false;
    const stoppedAt = Date.now();
    const bundle = {
      schema: 'keyfinder.capture.v1',
      label: this.label,
      startedAt: this.startedAt,
      stoppedAt,
      durationSec: (stoppedAt - this.startedAt) / 1000,
      settings: this.settings,
      frameCount: this.frames.length,
      frames: this.frames,
      notes: snapshots.notes ?? [],
      chromas: snapshots.chromas ?? {},
      keyTable: snapshots.keyTable ?? [],
    };
    console.log(
      `[CaptureBuffer] Stopped "${this.label}": ${bundle.frameCount} frames, ` +
      `${bundle.notes.length} notes, ${bundle.durationSec.toFixed(1)}s`
    );
    this._cappedWarned = false;
    return bundle;
  }
}

/**
 * @typedef {object} CoalescedNote
 * @property {number} startTime  - ms epoch
 * @property {number} endTime    - ms epoch
 * @property {number} durationMs
 * @property {number} durationSec
 * @property {number} pitchClass - 0..11 (C..B)
 * @property {string} name
 * @property {number} octave
 * @property {number} midi
 * @property {number} avgFrequency - Hz
 * @property {number} avgClarity   - 0..1
 * @property {number} frameCount
 */
