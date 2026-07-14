/* js/app.js
 *
 * Application controller. Owns the audio lifecycle and the animation loop,
 * pulls frames through the pipeline stages, and pushes results to the DOM.
 *
 * The controller holds NO music-theory logic and NO accumulation logic of its
 * own — it orchestrates the pure modules. This keeps the theoretically-load-
 * bearing code (theory.js, pipeline.js) isolated and testable.
 */

import { freqToNote, freqToMidi, estimateKey } from './theory.js';
import {
  PitchyDetector,
  NoteCoalescer,
  CaptureBuffer,
  gateFrame,
  buildChroma,
  GateReason,
  CHROMA_MODES,
} from './pipeline.js';
import { PitchGraphRenderer, initHistogramBars } from './render.js';
import { estimateTuningOffset } from './tuning.js';
import { AudioFilterChain, FILTER_PRESETS } from './filter.js';
import { SpectrumRenderer } from './spectrum.js';

// How many recent accepted frames to keep for the rolling tuning estimate.
const TUNING_FRAME_WINDOW = 300;
// Re-estimate tuning at most this often (ms) to avoid per-frame churn.
const TUNING_REFRESH_MS = 500;

// Minimum committed notes before we show a key estimate. With a genuinely
// distinct pitch class set, K-S can discriminate earlier, but showing a key
// off one or two notes is meaningless, so we hold off.
const MIN_NOTES_FOR_KEY = 4;

// How long a run of silence (rejected frames) before we commit the current
// note. Measured in hops, converted from a target of ~170ms.
const SILENCE_COMMIT_MS = 170;

class KeyFinderApp {
  constructor() {
    this.isListening = false;
    this.audioContext = null;
    this.mediaStream = null;
    this.detector = null;
    this.animFrameId = null;

    // Pipeline stages
    this.coalescer = new NoteCoalescer({ minDurationMs: 50 });
    this.capture = new CaptureBuffer();

    // Audio filter chain (created on start, since it needs the AudioContext).
    this.filterChain = null;
    // Most recent detected pitch, for the spectrum marker.
    this._lastDetectedHz = null;

    // Raw pitch line points for the graph (bounded ring).
    this.rawSamples = [];
    this.maxRawSamples = 1200;

    // Timing for hop-rate decoupling and silence detection.
    this._lastHopAt = 0;
    this._silenceStartedAt = null;

    // --- Tuning estimation state ---
    // Rolling buffer of recent accepted frames ({frequency}) for the live
    // tuning-offset estimate. Kept small and separate from capture.
    this._tuningFrames = [];
    this._lastTuningAt = 0;
    // Latest estimate: { offsetCents, correctedRefA, n, confident, spread }.
    this._tuning = { offsetCents: 0, correctedRefA: 440, n: 0, confident: false, spread: 0 };
    // Whether the measured offset is APPLIED to key analysis (user toggle).
    this._applyTuning = false;

    this._cacheDom();
    this.histo = initHistogramBars(this.dom.histogramBars);
    this.graph = new PitchGraphRenderer(
      this.dom.pitchCanvas,
      this.dom.graphContainer,
      this.dom.graphLabels
    );
    this.spectrum = new SpectrumRenderer(
      this.dom.spectrumCanvas,
      this.dom.spectrumWrap
    );

    this._bindEvents();
    this.graph.render([], [], null);
    // Draw the band immediately so the selected filter is visible before START.
    this.spectrum.render(null, this._currentBand(), null);
    this._renderBandLabel();
    this._renderKeyAndHistogram();
    console.log('[KeyFinderApp] base initialized');
  }

  /** The band for the currently-selected filter preset. */
  _currentBand() {
    const key = this.dom.filterSelect.value;
    const preset = FILTER_PRESETS[key] || FILTER_PRESETS.off;
    return { lowHz: preset.lowHz, highHz: preset.highHz };
  }

  _renderBandLabel() {
    const b = this._currentBand();
    const el = this.dom.spectrumBand;
    if (!b.lowHz && !b.highHz) {
      el.textContent = 'no filter';
    } else {
      const lo = b.lowHz ? `${b.lowHz}` : '0';
      const hi = b.highHz ? `${b.highHz}` : '\u221E';
      el.textContent = `${lo}\u2013${hi} Hz`;
    }
  }

  _cacheDom() {
    const $ = (id) => document.getElementById(id);
    this.dom = {
      statusDot: $('statusDot'),
      windowSelect: $('windowSelect'),
      noiseFloorSelect: $('noiseFloorSelect'),
      chromaModeSelect: $('chromaModeSelect'),
      centsNoteName: $('centsNoteName'),
      centsNoteOctave: $('centsNoteOctave'),
      centsNoteFreq: $('centsNoteFreq'),
      centsCurrent: $('centsCurrent'),
      centsDot: $('centsDot'),
      estimatedKey: $('estimatedKey'),
      keyCorrelation: $('keyCorrelation'),
      histogramBars: $('histogramBars'),
      controlBtn: $('controlBtn'),
      clearBtn: $('clearBtn'),
      captureBtn: $('captureBtn'),
      graphContainer: $('graphContainer'),
      pitchCanvas: $('pitchCanvas'),
      graphLabels: $('graphLabels'),
      tuningReadout: $('tuningReadout'),
      tuneBtn: $('tuneBtn'),
      filterSelect: $('filterSelect'),
      claritySelect: $('claritySelect'),
      spectrumCanvas: $('spectrumCanvas'),
      spectrumWrap: $('spectrumWrap'),
      spectrumBand: $('spectrumBand'),
    };
  }

  _bindEvents() {
    this.dom.controlBtn.addEventListener('click', () => this._toggleListen());
    this.dom.clearBtn.addEventListener('click', () => this._clearAll());
    this.dom.captureBtn.addEventListener('click', () => this._toggleCapture());
    // Re-derive key/histogram immediately when a lens changes, even while paused.
    this.dom.windowSelect.addEventListener('change', () => this._renderKeyAndHistogram());
    this.dom.chromaModeSelect.addEventListener('change', () => this._renderKeyAndHistogram());
    // Tap the tuning readout to apply/ignore the measured offset in key analysis.
    this.dom.tuningReadout.addEventListener('click', () => this._toggleApplyTuning());
    // TUNE button: calibrate view (wired in the next build step).
    this.dom.tuneBtn.addEventListener('click', () => this._onTuneButton());
    // Filter preset: retune the band live (no restart needed).
    this.dom.filterSelect.addEventListener('change', () => this._onFilterChange());
    // Clarity threshold: applies to the detector immediately.
    this.dom.claritySelect.addEventListener('change', () => this._onClarityChange());
  }

  _onFilterChange() {
    const band = this._currentBand();
    if (this.filterChain) {
      this.filterChain.setBand(band);
    }
    this._renderBandLabel();
    // Redraw immediately so the change is visible even while stopped.
    if (!this.isListening) {
      this.spectrum.render(null, band, null);
    }
    const preset = FILTER_PRESETS[this.dom.filterSelect.value];
    console.log(`[KeyFinderApp] filter -> ${preset.label}: ${preset.note}`);
  }

  _onClarityChange() {
    const c = parseFloat(this.dom.claritySelect.value);
    if (this.detector) {
      this.detector.clarityThreshold = c;
    }
    console.log(`[KeyFinderApp] clarity threshold -> ${c}`);
  }

  // -------------------------------------------------------------------------
  // Tuning: rolling estimate, readout, and apply-toggle
  // -------------------------------------------------------------------------

  /** The reference A the ANALYSIS should use right now (440 unless applied). */
  get _activeRefA() {
    return this._applyTuning ? this._tuning.correctedRefA : 440;
  }

  /** Push an accepted frame into the rolling tuning buffer. */
  _pushTuningFrame(frequency) {
    this._tuningFrames.push({ frequency, gate: 'accepted' });
    if (this._tuningFrames.length > TUNING_FRAME_WINDOW) {
      this._tuningFrames.splice(0, this._tuningFrames.length - TUNING_FRAME_WINDOW);
    }
  }

  /** Recompute the tuning estimate (throttled) and refresh the readout. */
  _updateTuning(now) {
    if (now - this._lastTuningAt < TUNING_REFRESH_MS) return;
    this._lastTuningAt = now;

    // Always measure against 440 — the offset is defined relative to concert
    // pitch. Applying it is a separate choice.
    this._tuning = estimateTuningOffset(this._tuningFrames, { refA: 440, minFrames: 30 });

    // When correction is applied, keep the coalescer's reference in sync so new
    // notes are binned under the corrected reference.
    if (this._applyTuning) {
      this.coalescer.refA = this._tuning.correctedRefA;
    }

    this._renderTuningReadout();
  }

  _renderTuningReadout() {
    const el = this.dom.tuningReadout;
    const t = this._tuning;
    if (!t || t.n === 0 || !this.isListening) {
      el.textContent = '';
      el.className = 'tuning-readout';
      return;
    }
    const sign = t.offsetCents >= 0 ? '+' : '';
    const cents = `${sign}${t.offsetCents.toFixed(0)}\u00A2`;
    const aRef = t.correctedRefA.toFixed(0);
    // Show a "~" while not yet confident (few samples).
    const prefix = t.confident ? '' : '~';
    el.textContent = `${prefix}${cents} \u00B7 A\u2248${aRef}`;
    el.className = 'tuning-readout ' + (this._applyTuning ? 'applied' : 'measured');
  }

  _toggleApplyTuning() {
    // Only meaningful once we have an estimate.
    if (!this._tuning || this._tuning.n === 0) return;
    this._applyTuning = !this._applyTuning;
    // Set the analysis reference for subsequent notes.
    this.coalescer.refA = this._activeRefA;
    this._renderTuningReadout();
    this._renderKeyAndHistogram();
    console.log(`[KeyFinderApp] tuning correction ${this._applyTuning ? 'APPLIED' : 'off'} (refA=${this.coalescer.refA.toFixed(2)})`);
  }

  _onTuneButton() {
    // Calibrate view is built in the next step; placeholder keeps the button
    // inert-but-present so the layout and wiring are testable now.
    console.log('[KeyFinderApp] TUNE pressed (calibrate view pending next build step)');
  }

  // -------------------------------------------------------------------------
  // Current settings snapshot (also embedded in exported captures)
  // -------------------------------------------------------------------------
  _settings() {
    const band = this._currentBand();
    return {
      noiseFloor: parseFloat(this.dom.noiseFloorSelect.value),
      windowSec: parseInt(this.dom.windowSelect.value, 10),
      chromaMode: this.dom.chromaModeSelect.value,
      // Filter state — essential for diagnosing captures.
      filterPreset: this.dom.filterSelect.value,
      filterLowHz: band.lowHz,
      filterHighHz: band.highHz,
      clarityThreshold: parseFloat(this.dom.claritySelect.value),
      applyTuning: this._applyTuning,
      tuningOffsetCents: this._tuning ? this._tuning.offsetCents : 0,
      fftSize: this.detector ? this.detector.fftSize : 4096,
      // Prefer the live context, but fall back to the detector's stored rate
      // (set at init) so the value survives even if audio has been torn down
      // or capture was started before listening began.
      sampleRate: (this.audioContext && this.audioContext.sampleRate)
        || (this.detector && this.detector.sampleRate)
        || null,
      refA: this.coalescer.refA,
    };
  }

  // -------------------------------------------------------------------------
  // Listen lifecycle
  // -------------------------------------------------------------------------
  async _toggleListen() {
    if (this.isListening) await this._stop();
    else await this._start();
  }

  async _start() {
    try {
      console.log('[KeyFinderApp] Requesting mic...');
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      });
      console.log(`[KeyFinderApp] Mic OK. SR=${this.audioContext.sampleRate}`);

      // Build the filter chain FIRST: source -> [band-pass] -> analyser.
      // The detector reads from the POST-FILTER analyser, so out-of-band energy
      // (e.g. a car engine at ~48 Hz) never reaches the pitch algorithm and
      // therefore cannot win the winner-take-all pitch contest.
      const source = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.filterChain = new AudioFilterChain(this.audioContext, source, {
        fftSize: 4096,
        rolloffStages: 2, // 24 dB/octave
      });
      this.filterChain.setBand(this._currentBand());

      this.detector = new PitchyDetector({
        clarityThreshold: parseFloat(this.dom.claritySelect.value),
      });
      await this.detector.init(this.audioContext, this.filterChain.filteredAnalyser);

      this.isListening = true;
      this._lastHopAt = 0;
      this._silenceStartedAt = null;
      this.dom.controlBtn.textContent = 'STOP';
      this.dom.controlBtn.classList.replace('start', 'stop');
      this.dom.statusDot.classList.add('listening');

      this._loop();
    } catch (err) {
      console.error('[KeyFinderApp] Start failed:', err);
      const msg =
        err.name === 'NotAllowedError' ? 'Mic access denied'
        : err.name === 'NotFoundError' ? 'No mic found'
        : `Error: ${err.message}`;
      this.dom.estimatedKey.textContent = msg;
      this.dom.estimatedKey.classList.add('empty');
      await this._stop();
    }
  }

  async _stop() {
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    // Commit any note still sounding so it isn't lost.
    this.coalescer.flush();

    if (this.detector) { this.detector.destroy(); this.detector = null; }
    if (this.filterChain) { this.filterChain.destroy(); this.filterChain = null; }
    if (this.mediaStream) { this.mediaStream.getTracks().forEach((t) => t.stop()); this.mediaStream = null; }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      try { await this.audioContext.close(); } catch (e) { /* already closing */ }
    }
    this.audioContext = null;

    this.isListening = false;
    this.dom.controlBtn.textContent = 'START';
    this.dom.controlBtn.classList.replace('stop', 'start');
    this.dom.statusDot.classList.remove('listening');

    // If a capture was running, finalize it so nothing is left dangling.
    if (this.capture.active) this._toggleCapture();

    // Freeze the tuning readout (it only shows a live estimate while listening).
    this._renderTuningReadout();
    this._renderKeyAndHistogram();
  }

  // -------------------------------------------------------------------------
  // Main loop: hop-rate decoupled from render-rate
  // -------------------------------------------------------------------------
  _loop() {
    if (!this.isListening || !this.detector) return;

    const now = Date.now();
    const hopMs = this.detector.windowMs; // one independent obs per analysis window
    const doHop = now - this._lastHopAt >= hopMs;

    if (doHop) {
      this._lastHopAt = now;
      this._processHop(now);
    }

    // Render every animation frame for smoothness, even between hops.
    this.graph.render(this.rawSamples, this.coalescer.notes, this.coalescer.peekCurrent(now));

    // Spectrum: raw vs filtered, with band markers and the detected-pitch line.
    if (this.filterChain) {
      this.spectrum.render(
        this.filterChain.getSpectra(),
        this.filterChain.band,
        this._lastDetectedHz
      );
    }

    this.animFrameId = requestAnimationFrame(() => this._loop());
  }

  /** One analysis hop: detect -> gate -> coalesce -> (capture) -> update UI. */
  _processHop(now) {
    const noiseFloor = parseFloat(this.dom.noiseFloorSelect.value);

    // Stage 1: raw frame
    const raw = this.detector.read();

    // Stage 2: gate
    const reason = gateFrame(raw, noiseFloor);

    // Build a serializable frame record (used by capture + graph line).
    const frame = {
      timestamp: now,
      rms: raw.rms,
      frequency: raw.frequency,
      clarity: raw.clarity,
      gate: reason,
    };

    if (reason === GateReason.ACCEPTED) {
      this._silenceStartedAt = null;
      this._lastDetectedHz = raw.frequency;

      const midiExact = freqToMidi(raw.frequency, this.coalescer.refA);
      frame.midiExact = midiExact;

      // Raw pitch line point for the graph.
      this.rawSamples.push({ timestamp: now, midiExact });
      if (this.rawSamples.length > this.maxRawSamples) {
        this.rawSamples.splice(0, this.rawSamples.length - this.maxRawSamples);
      }

      // Stage 3: coalesce
      this.coalescer.addFrame(now, raw.frequency, raw.clarity);

      // Feed the rolling tuning estimate (always measured vs 440).
      this._pushTuningFrame(raw.frequency);

      // Cents / current-note readout
      const info = freqToNote(raw.frequency, this.coalescer.refA);
      info.frequency = raw.frequency;
      this._renderCents(info);

      // Graph follows pitch
      this.graph.updateCenter(midiExact);
    } else {
      // Silence / no-pitch: after enough continuous silence, commit note.
      this._lastDetectedHz = null;
      if (this._silenceStartedAt === null) this._silenceStartedAt = now;
      if (now - this._silenceStartedAt >= SILENCE_COMMIT_MS) {
        this.coalescer.flush();
      }
    }

    // Capture (bounded) records every hop's frame while active.
    this.capture.recordFrame(frame);

    // Rolling tuning estimate + readout (throttled internally).
    this._updateTuning(now);

    // Stage 4 + 5: chroma + key, refreshed each hop.
    this._renderKeyAndHistogram();
  }

  // -------------------------------------------------------------------------
  // Rendering helpers
  // -------------------------------------------------------------------------
  _renderCents(info) {
    this.dom.centsNoteName.textContent = info.name;
    this.dom.centsNoteOctave.textContent = info.octave;
    this.dom.centsNoteFreq.textContent = `${info.frequency.toFixed(1)} Hz`;

    const cents = info.centsOff;
    this.dom.centsCurrent.textContent = `${cents >= 0 ? '+' : ''}${cents}\u00A2`;

    const pct = Math.max(0, Math.min(100, 50 + cents));
    this.dom.centsDot.style.left = pct + '%';

    const dot = this.dom.centsDot;
    dot.classList.remove('flat', 'sharp');
    if (cents < -10) dot.classList.add('flat');
    else if (cents > 10) dot.classList.add('sharp');
  }

  /** Compute the current chroma + key table and paint the histogram/key text. */
  _renderKeyAndHistogram() {
    const windowSec = parseInt(this.dom.windowSelect.value, 10) || 0;
    const mode = this.dom.chromaModeSelect.value;
    const now = Date.now();

    const chroma = buildChroma(this.coalescer.notes, {
      mode,
      windowSec,
      current: this.coalescer.peekCurrent(now),
      now,
    });

    const noteCount = this.coalescer.notes.length + (this.coalescer.peekCurrent(now) ? 1 : 0);
    const maxVal = Math.max(...chroma, 1e-6);

    let result = { best: null, ranked: [], total: 0 };
    if (noteCount >= MIN_NOTES_FOR_KEY) {
      result = estimateKey(chroma);
    }

    // Key text
    if (result.best) {
      this.dom.estimatedKey.textContent = result.best.key;
      this.dom.estimatedKey.classList.remove('empty');
      const pct = (result.best.correlation * 100).toFixed(0);
      this.dom.keyCorrelation.textContent = `r=${pct}%`;
    } else {
      const txt = noteCount > 0 ? `Collecting... ${noteCount}/${MIN_NOTES_FOR_KEY}` : 'Collecting...';
      this.dom.estimatedKey.textContent = this.isListening ? txt : (noteCount > 0 ? '' : 'Ready');
      this.dom.estimatedKey.classList.add('empty');
      this.dom.keyCorrelation.textContent = '';
    }

    // Histogram bars, highlighting in-key pitch classes of the winning key.
    const scaleSet = new Set(result.best ? result.best.scaleNotes : []);
    for (let i = 0; i < 12; i++) {
      const h = (chroma[i] / maxVal) * 100;
      this.histo.fills[i].style.height = h + '%';
      if (result.best) {
        const inKey = scaleSet.has(i);
        this.histo.fills[i].className = 'histo-fill ' + (inKey ? 'in-key' : 'out-key');
        this.histo.labels[i].className = 'histo-label ' + (inKey ? 'in-key' : '');
      } else {
        this.histo.fills[i].className = 'histo-fill';
        this.histo.labels[i].className = 'histo-label';
      }
    }

    // Keep the latest key table around for export.
    this._lastKeyTable = result.ranked;
    this._lastChroma = chroma;
  }

  // -------------------------------------------------------------------------
  // Bounded labeled capture + export
  // -------------------------------------------------------------------------
  _toggleCapture() {
    if (!this.capture.active) {
      const label = (typeof prompt === 'function')
        ? (prompt('Label for this capture (e.g. "Am - known"):', '') || '')
        : '';
      // Clear accumulated history so this capture cannot inherit notes from a
      // prior session or from warm-up doodling before REC was pressed. Each
      // capture starts from a clean slate and is fully self-contained.
      this.coalescer.clear();
      this.rawSamples = [];
      this.capture.start(label, this._settings());
      this.dom.captureBtn.textContent = 'REC';
      this.dom.captureBtn.classList.add('recording');
      this._renderKeyAndHistogram();
    } else {
      // The capture window IS the analysis window. Export only notes that fall
      // within [startedAt, stoppedAt] — NOT the entire coalescer history, and
      // NOT filtered by the live "Window" dropdown (that dropdown controls the
      // on-screen display only). This is the fix for the stale-note bug where
      // captures inherited every note from prior sessions.
      const now = Date.now();
      const winStart = this.capture.startedAt;
      const winEnd = now; // stoppedAt is set inside capture.stop(); use now as the bound

      // A small tolerance absorbs the sub-frame slop between a note's committed
      // timestamps and the capture start/stop instants.
      const TOL = 250; // ms
      const inWindow = (nt) =>
        nt.endTime >= winStart - TOL && nt.startTime <= winEnd + TOL;

      // Commit whatever is still sounding so the final note isn't lost, then
      // gather the window's notes in chronological order.
      this.coalescer.flush();
      const windowNotes = this.coalescer.notes
        .filter(inWindow)
        .slice()
        .reverse(); // coalescer stores newest-first; export chronological

      // Build both chroma lenses over the capture window only (no extra time
      // windowing — the capture already bounds the time span).
      const chromas = {};
      for (const m of CHROMA_MODES) {
        chromas[m] = buildChroma(windowNotes, { mode: m, windowSec: 0, now });
      }
      const activeChroma = chromas[this.dom.chromaModeSelect.value];
      const keyTable = estimateKey(activeChroma).ranked;

      const bundle = this.capture.stop({
        notes: windowNotes,
        chromas,
        keyTable,
      });

      this.dom.captureBtn.textContent = 'CAP';
      this.dom.captureBtn.classList.remove('recording');
      this._downloadBundle(bundle);
    }
  }

  _downloadBundle(bundle) {
    try {
      const json = JSON.stringify(bundle, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const safeLabel = (bundle.label || 'capture').replace(/[^a-z0-9._-]+/gi, '_');
      a.href = url;
      a.download = `keyfinder_${safeLabel}_${bundle.startedAt}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      console.log('[KeyFinderApp] Capture exported.');
    } catch (err) {
      console.error('[KeyFinderApp] Export failed:', err);
    }
  }

  // -------------------------------------------------------------------------
  _clearAll() {
    this.coalescer.clear();
    this.rawSamples = [];
    // Reset tuning estimate and any applied correction back to concert pitch.
    this._tuningFrames = [];
    this._tuning = { offsetCents: 0, correctedRefA: 440, n: 0, confident: false, spread: 0 };
    this._applyTuning = false;
    this.coalescer.refA = 440;
    this.dom.centsNoteName.textContent = '\u2014';
    this.dom.centsNoteOctave.textContent = '';
    this.dom.centsNoteFreq.textContent = '';
    this.dom.centsCurrent.textContent = '0\u00A2';
    this.dom.centsDot.style.left = '50%';
    this.dom.centsDot.classList.remove('flat', 'sharp');
    this._renderTuningReadout();
    this._renderKeyAndHistogram();
    this.graph.render([], [], null);
    console.log('[KeyFinderApp] Cleared');
  }
}

// Boot once the DOM is ready.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new KeyFinderApp());
} else {
  new KeyFinderApp();
}
