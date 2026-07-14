/* js/filter.js
 *
 * Pre-detection band-pass filtering.
 *
 * THE PRINCIPLE — and why this is not the old `minNote` hack:
 * The previous version discarded DETECTED NOTES below a MIDI threshold. That
 * threw away real musical information after the fact, and was rightly called a
 * workaround. This module does something categorically different: it removes
 * ENERGY from frequency bands where the instrument PHYSICALLY CANNOT PRODUCE
 * SOUND, BEFORE the pitch detector ever sees the signal.
 *
 * Why that distinction matters, empirically:
 * A car engine has a real fundamental (~30-60 Hz) and scores ~0.89 NSDF
 * clarity — high enough that the McLeod detector LOCKS ONTO IT and reports the
 * engine instead of the harmonica, even when the harmonica is twice as loud.
 * It is a pitched RIVAL, not noise. Playing louder cannot win a winner-take-all
 * pitch contest. But no harmonica reed — on any harp, including the lowest (G,
 * floor 196 Hz) — produces anything below ~196 Hz. So engine energy is, by the
 * physics of the instrument, never signal. Removing it pre-detection means the
 * detector cannot be distracted by it.
 *
 * Contrast with broadband noise (e.g. shower hiss): white noise has NO period,
 * so its NSDF clarity is ~0.06 and the detector already rejects it. Hiss does
 * not need to be filtered to avoid FALSE PITCHES — it needs to be filtered to
 * improve SIGNAL-TO-NOISE, because it MASKS the voice. Different problem, same
 * remedy: cut the band the source cannot occupy.
 */

import { Harmonica } from './harmonica.js';
import { midiToFreq } from './theory.js';

// ---------------------------------------------------------------------------
// Source presets
//
// Each preset's band is derived from what the source can PHYSICALLY produce,
// not tuned by ear.
// ---------------------------------------------------------------------------

/**
 * The harmonica band spans every harp the user might own. Computed from the
 * model rather than hard-coded: lowest note of the lowest harp (G, 1-blow G3
 * = 196 Hz) to the highest note of the highest common harp (F, 10-blow F7
 * = 2794 Hz), with a small margin.
 *
 * DELIBERATELY WIDE — see the "narrowing" note below.
 */
function harmonicaBand() {
  // Lowest common harp: G (1-blow G3 = 196 Hz). Highest: F (10-blow F7).
  const lowHarp = new Harmonica('G', 3);
  const highHarp = new Harmonica('F', 4);
  const loMidi = Math.min(...lowHarp.notes.map((n) => n.midi));
  const hiMidi = Math.max(...highHarp.notes.map((n) => n.midi));

  // MARGIN CHOICE (deliberate, not arbitrary):
  // A biquad's corner frequency is the -3 dB point, not a brick wall — notes
  // sitting AT the corner are audibly attenuated. Placing the corner exactly at
  // the lowest reed would cost ~5 dB on that note (measured). We therefore drop
  // the corner a MINOR THIRD (3 semitones) below the lowest reed, which puts
  // that reed in the flat passband (~-1 dB) while still leaving the corner far
  // above any engine: a 48 Hz engine fundamental sits ~1.6 octaves below a
  // 150 Hz corner, giving ~40 dB of rejection with a 24 dB/oct cascade.
  // Likewise we lift the top corner a few semitones above the highest reed.
  return {
    lowHz: Math.round(midiToFreq(loMidi - 3)),
    highHz: Math.round(midiToFreq(hiMidi + 3)),
  };
}

const HARP_BAND = harmonicaBand();

export const FILTER_PRESETS = {
  off: {
    label: 'Off',
    lowHz: null,
    highHz: null,
    note: 'No filtering. Raw microphone signal to the detector.',
  },
  harmonica: {
    label: 'Harmonica',
    lowHz: HARP_BAND.lowHz,   // ~185 Hz — below any harp, far above engine
    highHz: HARP_BAND.highHz, // ~2960 Hz — above the highest reed
    note: 'Spans every common harp (G through F). Rejects engine rumble, road '
        + 'noise, and HVAC, which sit 3-4x below the lowest reed.',
  },
  voice: {
    label: 'Voice',
    // Sung fundamentals: bass ~80 Hz to soprano ~1100 Hz. MPM tracks the
    // fundamental, so we keep that band and cut the hiss-heavy region above it.
    lowHz: 70,
    highHz: 1200,
    note: 'Vocal fundamental range. Cuts shower hiss / broadband high-frequency '
        + 'noise that masks the voice.',
  },
  general: {
    label: 'General',
    // Wide enough for bass guitar (E1 ~41 Hz) up through most melodic content.
    // Use for commercial music, handpan, mixed sources.
    lowHz: 40,
    highHz: 3000,
    note: 'Wide musical band. Preserves bass lines; trims sub-sonic rumble and '
        + 'high-frequency hiss.',
  },
};

/**
 * Band for a SPECIFIC harp key, if the user explicitly selects one.
 *
 * IMPORTANT — the auto-narrowing edge case:
 * Narrowing the band to a specific harp's exact range is only safe when the
 * harp key is KNOWN. If we auto-detected the key and were wrong, we would
 * filter away the very notes needed to correct the error — a self-reinforcing
 * failure. So auto-narrowing is NOT done. The wide 'harmonica' preset already
 * rejects the engine (which is 3-4x below even the lowest harp), so exact
 * narrowing buys almost nothing. This function exists only for EXPLICIT
 * selection, where the user has committed to a harp.
 *
 * @param {string} key - harp key name
 * @param {number} [octave] - octave of hole-1 blow
 * @returns {{lowHz:number, highHz:number, label:string, note:string}}
 */
export function bandForHarp(key, octave = 4) {
  const h = new Harmonica(key, octave);
  const loMidi = Math.min(...h.notes.map((n) => n.midi));
  const hiMidi = Math.max(...h.notes.map((n) => n.midi));
  // Same 3-semitone margin as the wide preset: keeps the extreme reeds in the
  // flat passband rather than on the filter's -3 dB shoulder.
  return {
    label: `${key} harp`,
    lowHz: Math.round(midiToFreq(loMidi - 3)),
    highHz: Math.round(midiToFreq(hiMidi + 3)),
    note: `Exact range of a ${key} harp (explicitly selected).`,
  };
}

// ---------------------------------------------------------------------------
// The audio filter chain
//
// source -> [highpass] -> [lowpass] -> analyser(filtered)
//        \-> analyser(raw)                     (parallel tap for comparison)
//
// The RAW tap lets the UI show the unfiltered spectrum alongside the filtered
// one, so the effect of the band is visible rather than a black box.
// ---------------------------------------------------------------------------

export class AudioFilterChain {
  /**
   * @param {AudioContext} audioContext
   * @param {MediaStreamAudioSourceNode} source
   * @param {object} [opts]
   * @param {number} [opts.fftSize=4096] - analyser size (must match detector)
   * @param {number} [opts.rolloffStages=2] - cascaded biquads per side. Each
   *        biquad is 12 dB/octave; 2 stages = 24 dB/octave, which is enough to
   *        put a 48 Hz engine ~30+ dB down when the corner is at 185 Hz.
   */
  constructor(audioContext, source, opts = {}) {
    this.ctx = audioContext;
    this.source = source;
    this.fftSize = opts.fftSize ?? 4096;
    this.rolloffStages = opts.rolloffStages ?? 2;

    // Parallel RAW analyser — taps the source directly, before any filtering.
    this.rawAnalyser = audioContext.createAnalyser();
    this.rawAnalyser.fftSize = this.fftSize;
    this.rawAnalyser.smoothingTimeConstant = 0.6;
    this.source.connect(this.rawAnalyser);

    // Filtered analyser — the detector reads from this one.
    this.filteredAnalyser = audioContext.createAnalyser();
    this.filteredAnalyser.fftSize = this.fftSize;
    this.filteredAnalyser.smoothingTimeConstant = 0.6;

    /** @type {BiquadFilterNode[]} */
    this.highpassStages = [];
    /** @type {BiquadFilterNode[]} */
    this.lowpassStages = [];

    for (let i = 0; i < this.rolloffStages; i++) {
      const hp = audioContext.createBiquadFilter();
      hp.type = 'highpass';
      hp.Q.value = 0.707; // Butterworth: maximally flat passband, no ringing
      this.highpassStages.push(hp);

      const lp = audioContext.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 0.707;
      this.lowpassStages.push(lp);
    }

    this._currentBand = { lowHz: null, highHz: null };
    this._wire();
    console.log(
      `[AudioFilterChain] built: ${this.rolloffStages} stage(s) per side ` +
      `(${this.rolloffStages * 12} dB/oct)`
    );
  }

  /** Connect source -> HP stages -> LP stages -> filteredAnalyser. */
  _wire() {
    let node = this.source;
    for (const hp of this.highpassStages) {
      node.connect(hp);
      node = hp;
    }
    for (const lp of this.lowpassStages) {
      node.connect(lp);
      node = lp;
    }
    node.connect(this.filteredAnalyser);
  }

  /**
   * Apply a band. Passing null for either edge effectively disables that side
   * by parking the corner at an extreme (we keep the nodes wired so the graph
   * topology never changes — simpler and avoids clicks).
   *
   * @param {{lowHz:(number|null), highHz:(number|null)}} band
   */
  setBand(band) {
    const nyquist = this.ctx.sampleRate / 2;
    // A highpass at ~10 Hz and a lowpass near Nyquist are effectively "off".
    const lo = band.lowHz ?? 10;
    const hi = band.highHz ?? Math.min(20000, nyquist * 0.98);

    if (lo >= hi) {
      console.warn(`[AudioFilterChain] invalid band ${lo}-${hi} Hz; ignoring.`);
      return;
    }

    const t = this.ctx.currentTime;
    for (const hp of this.highpassStages) hp.frequency.setValueAtTime(lo, t);
    for (const lp of this.lowpassStages) lp.frequency.setValueAtTime(hi, t);

    this._currentBand = { lowHz: band.lowHz, highHz: band.highHz };
    console.log(`[AudioFilterChain] band set: ${band.lowHz ?? 'none'} - ${band.highHz ?? 'none'} Hz`);
  }

  get band() {
    return { ...this._currentBand };
  }

  /**
   * Read both spectra for display, in dB.
   * @returns {{raw: Float32Array, filtered: Float32Array, binHz: number}}
   */
  getSpectra() {
    const n = this.rawAnalyser.frequencyBinCount;
    const raw = new Float32Array(n);
    const filtered = new Float32Array(n);
    this.rawAnalyser.getFloatFrequencyData(raw);
    this.filteredAnalyser.getFloatFrequencyData(filtered);
    const binHz = this.ctx.sampleRate / this.fftSize;
    return { raw, filtered, binHz };
  }

  destroy() {
    try {
      this.source.disconnect();
      for (const f of [...this.highpassStages, ...this.lowpassStages]) f.disconnect();
      this.rawAnalyser.disconnect();
      this.filteredAnalyser.disconnect();
    } catch (e) {
      console.warn('[AudioFilterChain] disconnect issue:', e);
    }
  }
}
