/* js/theory.js
 *
 * Pure music-theory utilities. No state, no DOM, no side effects.
 * Everything here is deterministic and unit-testable in isolation.
 *
 * Design principle for this rewrite: this module contains ONLY methods with a
 * solid, verifiable basis in music theory. The Krumhansl-Schmuckler profiles
 * below are the canonical values from Krumhansl (1990), cross-checked against
 * multiple independent implementations. No prevalence multipliers, no octave
 * reweighting, no shortcuts.
 */

// ---------------------------------------------------------------------------
// Note naming
// ---------------------------------------------------------------------------

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Which of the 12 pitch classes are "natural" (white keys). Used only for
// display/labelling — has no bearing on any calculation.
export const IS_NATURAL = [true, false, true, false, true, true, false, true, false, true, false, true];

// Diatonic scale-degree offsets from the tonic, in semitones.
export const MAJOR_SCALE_STEPS = [0, 2, 4, 5, 7, 9, 11];
export const MINOR_SCALE_STEPS = [0, 2, 3, 5, 7, 8, 10]; // natural minor

// ---------------------------------------------------------------------------
// Frequency <-> MIDI <-> note conversions
//
// Standard equal-temperament relations anchored at A4 = MIDI 69.
// The reference frequency is a parameter (default 440 Hz) so that later
// tuning-offset detection can pass a corrected reference without touching
// any call sites. This is the ONLY sanctioned way tuning will enter the
// system — we never fudge pitch-class bins to fake a tuning correction.
// ---------------------------------------------------------------------------

const A4_MIDI = 69;

/**
 * Convert a frequency in Hz to a (fractional) MIDI note number.
 * @param {number} freq  - frequency in Hz (must be > 0)
 * @param {number} [refA=440] - reference frequency of A4 in Hz
 * @returns {number} fractional MIDI note number
 */
export function freqToMidi(freq, refA = 440) {
  if (!(freq > 0)) {
    // Defensive: log2 of a non-positive number is NaN/-Infinity.
    console.warn(`[theory] freqToMidi received non-positive freq: ${freq}`);
    return NaN;
  }
  return A4_MIDI + 12 * Math.log2(freq / refA);
}

/**
 * Convert a MIDI note number to a frequency in Hz.
 * @param {number} midi - MIDI note number (may be fractional)
 * @param {number} [refA=440] - reference frequency of A4 in Hz
 * @returns {number} frequency in Hz
 */
export function midiToFreq(midi, refA = 440) {
  return refA * Math.pow(2, (midi - A4_MIDI) / 12);
}

/**
 * Full note description for a frequency: name, octave, pitch class, cents
 * deviation from the nearest equal-tempered semitone, and the rounded MIDI.
 * @param {number} freq - frequency in Hz
 * @param {number} [refA=440] - reference frequency of A4 in Hz
 * @returns {{name:string, octave:number, pitchClass:number, centsOff:number, midi:number, midiExact:number}}
 */
export function freqToNote(freq, refA = 440) {
  const midiExact = freqToMidi(freq, refA);
  const midi = Math.round(midiExact);
  const centsOff = Math.round((midiExact - midi) * 100);
  const pitchClass = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1; // MIDI 60 = C4
  return { name: NOTE_NAMES[pitchClass], octave, pitchClass, centsOff, midi, midiExact };
}

/**
 * Label info for an integer MIDI note (name, octave, natural flag, pitch class).
 * Convenience for the graph's row labels.
 * @param {number} midi - integer MIDI note number
 */
export function midiToLabel(midi) {
  const pc = ((midi % 12) + 12) % 12;
  const oct = Math.floor(midi / 12) - 1;
  return { name: NOTE_NAMES[pc], octave: oct, isNatural: IS_NATURAL[pc], pitchClass: pc };
}

// ---------------------------------------------------------------------------
// Krumhansl-Schmuckler key profiles
//
// Canonical Krumhansl (1990) probe-tone ratings. Index 0 is the tonic; the
// array is in ascending chromatic order from the tonic. Verified against
// Krumhansl's published values and multiple reference implementations.
//
// These are NOT to be altered with prevalence weights or any other prior.
// If we ever add a key prior it will be a separate, explicit probabilistic
// term — never baked into these vectors.
// ---------------------------------------------------------------------------

export const KK_MAJOR = Object.freeze([
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
]);
export const KK_MINOR = Object.freeze([
  6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
]);

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/**
 * Pearson product-moment correlation coefficient between two equal-length
 * arrays. Returns a value in [-1, 1], or 0 if either input has zero variance
 * (in which case correlation is undefined and 0 is the safe neutral choice).
 *
 * This is the correlation the K-S algorithm uses to score each candidate key.
 * @param {number[]} x
 * @param {number[]} y
 * @returns {number}
 */
export function pearsonCorrelation(x, y) {
  const n = x.length;
  if (n === 0 || n !== y.length) {
    console.warn(`[theory] pearsonCorrelation length mismatch: ${x.length} vs ${y.length}`);
    return 0;
  }
  let sx = 0, sy = 0, sxy = 0, sx2 = 0, sy2 = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i];
    sy += y[i];
    sxy += x[i] * y[i];
    sx2 += x[i] * x[i];
    sy2 += y[i] * y[i];
  }
  const num = n * sxy - sx * sy;
  const den = Math.sqrt((n * sx2 - sx * sx) * (n * sy2 - sy * sy));
  // den === 0 means one array is constant (no variance) -> correlation undefined.
  return den === 0 ? 0 : num / den;
}

/**
 * Rotate an array by `shift` positions. Element at output index i comes from
 * input index (i - shift). Used to transpose a key profile from C to any tonic.
 * @param {number[]} arr
 * @param {number} shift
 * @returns {number[]}
 */
export function rotateArray(arr, shift) {
  const n = arr.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = arr[((i - shift) % n + n) % n];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Key estimation (Krumhansl-Schmuckler)
// ---------------------------------------------------------------------------

/**
 * Estimate the musical key from a 12-bin pitch-class distribution (chroma).
 *
 * For each of the 12 tonics, the C-anchored major and minor profiles are
 * transposed to that tonic and correlated (Pearson) against the chroma. The
 * 24 candidate keys are ranked purely by correlation — nothing else.
 *
 * The FULL ranked table is returned (not just the winner) so callers can
 * inspect margins, relative-key ambiguity, etc. This is essential for the
 * data-export / debugging workflow.
 *
 * @param {number[]} chroma - length-12 non-negative pitch-class weights (C..B)
 * @returns {{
 *   best: (KeyCandidate|null),
 *   ranked: KeyCandidate[],
 *   total: number
 * }}
 * where KeyCandidate = { key, tonic, mode, correlation, scaleNotes }
 */
export function estimateKey(chroma) {
  if (!Array.isArray(chroma) || chroma.length !== 12) {
    console.error(`[theory] estimateKey expected length-12 chroma, got`, chroma);
    return { best: null, ranked: [], total: 0 };
  }

  const total = chroma.reduce((a, b) => a + b, 0);
  if (total === 0) {
    // No pitch information yet — honestly report "no estimate" rather than
    // returning a spurious key.
    return { best: null, ranked: [], total: 0 };
  }

  const ranked = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    const majProfile = rotateArray(KK_MAJOR, tonic);
    const minProfile = rotateArray(KK_MINOR, tonic);

    const majCorr = pearsonCorrelation(chroma, majProfile);
    const minCorr = pearsonCorrelation(chroma, minProfile);

    ranked.push({
      key: `${NOTE_NAMES[tonic]} Major`,
      tonic,
      mode: 'major',
      correlation: majCorr,
      scaleNotes: MAJOR_SCALE_STEPS.map((s) => (s + tonic) % 12),
    });
    ranked.push({
      key: `${NOTE_NAMES[tonic]} Minor`,
      tonic,
      mode: 'minor',
      correlation: minCorr,
      scaleNotes: MINOR_SCALE_STEPS.map((s) => (s + tonic) % 12),
    });
  }

  ranked.sort((a, b) => b.correlation - a.correlation);

  return { best: ranked[0], ranked, total };
}
