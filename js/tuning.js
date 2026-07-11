/* js/tuning.js
 *
 * Tuning analysis. Two related capabilities, both derived purely from the
 * incoming audio (no tone generator, no speaker loop — see the reasoning
 * below):
 *
 *   1. estimateTuningOffset(): the global cents-offset of the source relative
 *      to A=440. The incoming music reveals its own reference: if every note
 *      lands ~11 cents sharp, the DISTRIBUTION of per-frame deviations clusters
 *      at +11. We report the center of that cluster.
 *
 *   2. TuningReport: per-note (per-reed) deviation statistics for the calibrate
 *      screen, so a single mistuned reed can be spotted. Critically, it uses
 *      the SPREAD of each note's samples to distinguish "this reed is mistuned"
 *      (tight cluster, wrong center) from "this note was bent/unstable" (wide
 *      spread) — so bends are never misread as tuning faults.
 *
 * WHY THERE IS NO ABSOLUTE PHYSICAL REFERENCE:
 * A=440 is a convention (ISO 16), not a physical constant. Frequency itself is
 * absolute and the detector measures it accurately (a commercial 440-mastered
 * track reads within a cent of zero), but WHICH note a frequency "is" depends
 * on the chosen reference. So tuning is always measured relative to a chosen
 * refA, never toward an absolute truth. Speaker/mic quality colours amplitude,
 * not pitch, so a self-referential calibration loop cannot detect a tuning
 * offset — the offset lives in the source, and the source reveals it directly.
 */

import { freqToMidi, NOTE_NAMES } from './theory.js';

// ---------------------------------------------------------------------------
// Circular statistics for cents-deviations
//
// Per-frame deviation from the nearest semitone lives on a circle: -50c and
// +50c are the SAME boundary (the midpoint between two semitones). A plain
// mean/median breaks near that wrap (a cluster split across +/-50 would average
// to ~0, which is wrong). We therefore treat each deviation as an angle over a
// 100-cent period and take the circular mean. For clusters well inside the
// range this agrees with the ordinary average; near the wrap it stays correct.
// ---------------------------------------------------------------------------

/**
 * Circular mean of an array of cents-deviations in [-50, 50].
 * @param {number[]} centsList
 * @returns {number} circular mean in (-50, 50]
 */
export function circularMeanCents(centsList) {
  if (!centsList.length) return 0;
  // Map cents in [-50,50] to angle over full circle: 100 cents == 2*pi.
  let sx = 0, sy = 0;
  for (const c of centsList) {
    const theta = (c / 50) * Math.PI; // -50->-pi, +50->+pi
    sx += Math.cos(theta);
    sy += Math.sin(theta);
  }
  const meanTheta = Math.atan2(sy / centsList.length, sx / centsList.length);
  return (meanTheta / Math.PI) * 50;
}

/**
 * Circular "spread" (angular standard deviation) of cents-deviations, in cents.
 * Uses the mean resultant length R: spread grows as R shrinks. Returned on a
 * cents scale so it's comparable to the deviations themselves.
 * @param {number[]} centsList
 * @returns {number} spread in cents (0 = perfectly consistent)
 */
export function circularSpreadCents(centsList) {
  if (centsList.length < 2) return 0;
  let sx = 0, sy = 0;
  for (const c of centsList) {
    const theta = (c / 50) * Math.PI;
    sx += Math.cos(theta);
    sy += Math.sin(theta);
  }
  sx /= centsList.length;
  sy /= centsList.length;
  const R = Math.sqrt(sx * sx + sy * sy); // 0..1
  // Angular std dev = sqrt(-2 ln R); convert radians -> cents (pi rad = 50c).
  const angStd = Math.sqrt(Math.max(0, -2 * Math.log(Math.max(R, 1e-9))));
  return (angStd / Math.PI) * 50;
}

/**
 * Cents deviation of a frequency from the nearest equal-tempered semitone
 * under a given reference. Result in (-50, 50].
 * @param {number} freq
 * @param {number} [refA=440]
 * @returns {number}
 */
export function centsFromNearestSemitone(freq, refA = 440) {
  const m = freqToMidi(freq, refA);
  const dev = (m - Math.round(m)) * 100;
  return dev;
}

// ---------------------------------------------------------------------------
// Global tuning-offset estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the source's global tuning offset from a set of accepted frames.
 * @param {{frequency:number|null, gate?:string}[]} frames - raw/gated frames
 * @param {object} [opts]
 * @param {number} [opts.refA=440] - reference to measure against
 * @param {number} [opts.minFrames=20] - below this we don't claim an estimate
 * @returns {{offsetCents:number, correctedRefA:number, n:number, confident:boolean, spread:number}}
 */
export function estimateTuningOffset(frames, opts = {}) {
  const refA = opts.refA ?? 440;
  const minFrames = opts.minFrames ?? 20;

  const devs = [];
  for (const f of frames) {
    if (f.frequency == null) continue;
    if (f.gate && f.gate !== 'accepted') continue;
    devs.push(centsFromNearestSemitone(f.frequency, refA));
  }

  if (devs.length === 0) {
    return { offsetCents: 0, correctedRefA: refA, n: 0, confident: false, spread: 0 };
  }

  const offsetCents = circularMeanCents(devs);
  const spread = circularSpreadCents(devs);
  const correctedRefA = refA * Math.pow(2, offsetCents / 1200);

  return {
    offsetCents,
    correctedRefA,
    n: devs.length,
    confident: devs.length >= minFrames,
    spread,
  };
}

// ---------------------------------------------------------------------------
// Per-note tuning report (calibrate screen)
// ---------------------------------------------------------------------------

/**
 * Accumulates per-note deviation samples and produces a report that separates
 * genuine reed mistuning from bend/instability via spread.
 */
export class TuningReport {
  /**
   * @param {object} [opts]
   * @param {number} [opts.refA=440] - reference for absolute deviation
   * @param {number} [opts.minSamples=8] - samples before a note's verdict is trusted
   * @param {number} [opts.tightSpreadCents=8] - at/below this spread a note is
   *        "stable" and its offset is a real tuning verdict; above it, the note
   *        was likely bent/unstable and we withhold a mistuning judgement
   * @param {number} [opts.offThresholdCents=10] - |offset vs self| beyond which
   *        a stable reed is flagged as off
   */
  constructor(opts = {}) {
    this.refA = opts.refA ?? 440;
    this.minSamples = opts.minSamples ?? 8;
    this.tightSpreadCents = opts.tightSpreadCents ?? 8;
    this.offThresholdCents = opts.offThresholdCents ?? 10;
    /** @type {Map<number, number[]>} midi -> list of absolute cents-devs */
    this._byMidi = new Map();
  }

  /**
   * Add one accepted frame's frequency.
   * @param {number} frequency
   */
  addFrame(frequency) {
    if (!(frequency > 0)) return;
    const m = freqToMidi(frequency, this.refA);
    const midi = Math.round(m);
    const dev = (m - midi) * 100; // cents vs 440-referenced nearest semitone
    if (!this._byMidi.has(midi)) this._byMidi.set(midi, []);
    this._byMidi.get(midi).push(dev);
  }

  /** Total accepted samples gathered. */
  get sampleCount() {
    let n = 0;
    for (const arr of this._byMidi.values()) n += arr.length;
    return n;
  }

  /**
   * Build the report. Returns per-note rows plus the instrument's own center
   * (the global offset), so each reed can be judged both vs 440 and vs the
   * harp's own average — the two questions answer "tune to concert pitch?" and
   * "which reed disagrees with the rest of my harp?" respectively.
   *
   * @returns {{
   *   globalOffsetCents:number,
   *   rows: NoteReportRow[]
   * }}
   */
  build() {
    // Global center = circular mean of ALL deviations (robust to the wrap).
    const all = [];
    for (const arr of this._byMidi.values()) for (const d of arr) all.push(d);
    const globalOffsetCents = all.length ? circularMeanCents(all) : 0;

    const rows = [];
    for (const [midi, devs] of this._byMidi) {
      const pc = ((midi % 12) + 12) % 12;
      const octave = Math.floor(midi / 12) - 1;
      const centerVs440 = circularMeanCents(devs);
      const spread = circularSpreadCents(devs);
      const vsSelf = centerVs440 - globalOffsetCents;
      const enough = devs.length >= this.minSamples;
      const stable = spread <= this.tightSpreadCents;

      // A reed is flagged "off" only when we have enough STABLE samples AND it
      // deviates from the harp's own center beyond threshold. Wide spread =>
      // withhold judgement (was bent / unstable), prompt to replay cleaner.
      let verdict;
      if (!enough) verdict = 'need-more';
      else if (!stable) verdict = 'unstable';
      else if (Math.abs(vsSelf) > this.offThresholdCents) verdict = 'off';
      else verdict = 'ok';

      rows.push({
        midi,
        pc,
        octave,
        name: NOTE_NAMES[pc],
        samples: devs.length,
        centerVs440,
        vsSelf,
        spread,
        stable,
        enough,
        verdict,
      });
    }

    rows.sort((a, b) => a.midi - b.midi);
    return { globalOffsetCents, rows };
  }

  clear() {
    this._byMidi.clear();
  }
}

/**
 * @typedef {object} NoteReportRow
 * @property {number} midi
 * @property {number} pc
 * @property {number} octave
 * @property {string} name
 * @property {number} samples
 * @property {number} centerVs440 - cents vs 440 nearest semitone
 * @property {number} vsSelf - cents vs the instrument's own center
 * @property {number} spread - circular spread in cents
 * @property {boolean} stable
 * @property {boolean} enough
 * @property {string} verdict - 'need-more' | 'unstable' | 'off' | 'ok'
 */
