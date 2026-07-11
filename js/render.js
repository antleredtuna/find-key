/* js/render.js
 *
 * Presentation only: the piano-roll pitch graph (canvas) and the pitch-class
 * histogram bars (DOM). No analysis happens here — renderers are handed
 * already-computed data. Kept behaviourally identical to v2; only extracted
 * from the monolith and adapted to the new note/sample shapes.
 */

import { NOTE_NAMES, midiToLabel } from './theory.js';

// ===========================================================================
// Pitch graph (piano roll) renderer
// ===========================================================================

export class PitchGraphRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {HTMLElement} container - element the canvas fills (for sizing)
   * @param {HTMLElement} labelsEl - overlay element for note-name labels
   */
  constructor(canvas, container, labelsEl) {
    this.canvas = canvas;
    this.container = container;
    this.labelsEl = labelsEl;
    this.ctx = canvas.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;

    this.visibleSemitones = 36; // 3 octaves visible
    this.centerMidi = 64;       // start centered on E4
    this.targetCenterMidi = 64;
    this.pixelsPerSecond = 28;
    this.labelWidth = 36;
    this.playheadOffset = 60;   // px from right edge where "now" sits

    this._lastLabelKey = null;

    this._resize();
    this._resizeHandler = () => this._resize();
    window.addEventListener('resize', this._resizeHandler);
  }

  _resize() {
    const rect = this.container.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = this.width * this.dpr;
    this.canvas.height = this.height * this.dpr;
    this.canvas.style.width = this.width + 'px';
    this.canvas.style.height = this.height + 'px';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /** MIDI -> Y pixel. Higher notes toward the top (smaller Y). */
  midiToY(midi) {
    const topMidi = this.centerMidi + this.visibleSemitones / 2;
    const botMidi = this.centerMidi - this.visibleSemitones / 2;
    return this.height * (1 - (midi - botMidi) / (topMidi - botMidi));
  }

  get semitoneHeight() {
    return this.height / this.visibleSemitones;
  }

  /** Smoothly follow the detected pitch so the active note stays in view. */
  updateCenter(currentMidi) {
    if (currentMidi !== null && currentMidi !== undefined && !Number.isNaN(currentMidi)) {
      this.targetCenterMidi = currentMidi;
    }
    const diff = this.targetCenterMidi - this.centerMidi;
    if (Math.abs(diff) > 0.05) {
      this.centerMidi += diff * 0.05;
    }
  }

  _timeToX(timestamp, now) {
    const playheadX = this.width - this.playheadOffset;
    return playheadX - ((now - timestamp) / 1000) * this.pixelsPerSecond;
  }

  /**
   * @param {object[]} rawSamples - [{timestamp, midiExact}] pitch line points
   * @param {object[]} notes - committed coalesced notes
   * @param {(object|null)} current - in-progress note (already time-bounded to now)
   */
  render(rawSamples, notes, current) {
    const ctx = this.ctx;
    const now = Date.now();
    const w = this.width;
    const h = this.height;
    const lw = this.labelWidth;
    const sh = this.semitoneHeight;

    ctx.clearRect(0, 0, w, h);

    const topMidi = Math.ceil(this.centerMidi + this.visibleSemitones / 2);
    const botMidi = Math.floor(this.centerMidi - this.visibleSemitones / 2);

    // --- Piano-key style row backgrounds ---
    for (let midi = botMidi; midi <= topMidi; midi++) {
      const info = midiToLabel(midi);
      const y = this.midiToY(midi + 0.5);
      ctx.fillStyle = info.isNatural ? 'rgba(22, 22, 32, 0.5)' : 'rgba(14, 14, 26, 0.6)';
      ctx.fillRect(lw, y, w - lw, sh);
      ctx.fillStyle = 'rgba(255,255,255,0.02)';
      ctx.fillRect(lw, y + sh - 0.5, w - lw, 0.5);
    }

    // --- Coalesced note blocks ---
    const allNotes = current ? [...notes, current] : notes;
    for (const note of allNotes) {
      const x1 = this._timeToX(note.startTime, now);
      const x2 = this._timeToX(note.endTime, now);
      if (x2 < lw || x1 > w) continue;

      const y = this.midiToY(note.midi + 0.5);
      const cx1 = Math.max(x1, lw);
      const cx2 = Math.min(x2, w);
      const bw = Math.max(cx2 - cx1, 2);

      ctx.fillStyle = 'rgba(232, 149, 31, 0.5)';
      ctx.fillRect(cx1, y + 1, bw, sh - 2);
      ctx.fillStyle = 'rgba(232, 149, 31, 0.85)';
      ctx.fillRect(cx1, y + 1, bw, 1);
      ctx.fillRect(cx1, y + sh - 2, bw, 1);
    }

    // --- Raw pitch line ---
    if (rawSamples.length > 1) {
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      let drawing = false;
      let prevTimestamp = 0;

      for (let i = 0; i < rawSamples.length; i++) {
        const s = rawSamples[i];
        const x = this._timeToX(s.timestamp, now);
        if (x < lw - 10 || x > w + 10) continue;

        const y = this.midiToY(s.midiExact);

        // Break the line across silence gaps (> 200ms between points).
        if (drawing && s.timestamp - prevTimestamp > 200) {
          ctx.stroke();
          ctx.beginPath();
          drawing = false;
        }
        if (!drawing) {
          ctx.moveTo(x, y);
          drawing = true;
        } else {
          ctx.lineTo(x, y);
        }
        prevTimestamp = s.timestamp;
      }
      if (drawing) ctx.stroke();
    }

    this._renderLabels(botMidi, topMidi);
  }

  _renderLabels(botMidi, topMidi) {
    // Only rebuild label DOM when the visible integer range shifts.
    const labelKey = `${Math.round(botMidi)}-${Math.round(topMidi)}`;
    if (this._lastLabelKey === labelKey) return;
    this._lastLabelKey = labelKey;

    this.labelsEl.innerHTML = '';
    for (let midi = Math.floor(botMidi); midi <= Math.ceil(topMidi); midi++) {
      const info = midiToLabel(midi);
      if (!info.isNatural) continue; // naturals only, to reduce clutter
      const y = this.midiToY(midi);
      const el = document.createElement('div');
      el.className = 'pitch-label natural';
      el.style.top = y + 'px';
      el.textContent = info.name + info.octave;
      this.labelsEl.appendChild(el);
    }
  }

  destroy() {
    window.removeEventListener('resize', this._resizeHandler);
  }
}

// ===========================================================================
// Histogram bars
// ===========================================================================

/**
 * Build the 12 histogram columns and return their fill/label elements.
 * @param {HTMLElement} container
 * @returns {{fills: HTMLElement[], labels: HTMLElement[]}}
 */
export function initHistogramBars(container) {
  const fills = [];
  const labels = [];
  container.innerHTML = '';
  for (let i = 0; i < 12; i++) {
    const col = document.createElement('div');
    col.className = 'histo-col';

    const bar = document.createElement('div');
    bar.className = 'histo-bar';
    const fill = document.createElement('div');
    fill.className = 'histo-fill';
    fill.style.height = '0%';
    bar.appendChild(fill);

    const lbl = document.createElement('div');
    lbl.className = 'histo-label';
    lbl.textContent = NOTE_NAMES[i].replace('#', '\u266F'); // musical sharp glyph

    col.appendChild(bar);
    col.appendChild(lbl);
    container.appendChild(col);

    fills.push(fill);
    labels.push(lbl);
  }
  return { fills, labels };
}
