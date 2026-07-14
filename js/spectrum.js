/* js/spectrum.js
 *
 * Live spectrum display: the RAW microphone signal overlaid with the
 * POST-FILTER signal, so the effect of the band-pass is visible rather than a
 * black box. The band edges are drawn as vertical markers.
 *
 * Uses a LOGARITHMIC frequency axis, because that is how pitch works: each
 * octave is a doubling, so a log axis gives equal width to each octave. On a
 * linear axis the entire useful musical range would be crammed into the left
 * few percent while empty high frequencies dominate the display.
 */

const MIN_DB = -100;
const MAX_DB = -10;

export class SpectrumRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {HTMLElement} container
   * @param {object} [opts]
   * @param {number} [opts.minHz=20] - left edge of the display
   * @param {number} [opts.maxHz=8000] - right edge of the display
   */
  constructor(canvas, container, opts = {}) {
    this.canvas = canvas;
    this.container = container;
    this.ctx = canvas.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;

    this.minHz = opts.minHz ?? 20;
    this.maxHz = opts.maxHz ?? 8000;

    this._resize();
    this._resizeHandler = () => this._resize();
    window.addEventListener('resize', this._resizeHandler);
  }

  _resize() {
    const rect = this.container.getBoundingClientRect();
    this.width = Math.max(rect.width, 1);
    this.height = Math.max(rect.height, 1);
    this.canvas.width = this.width * this.dpr;
    this.canvas.height = this.height * this.dpr;
    this.canvas.style.width = this.width + 'px';
    this.canvas.style.height = this.height + 'px';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /** Frequency -> X pixel (logarithmic). */
  _hzToX(hz) {
    const clamped = Math.max(hz, this.minHz);
    const t = Math.log2(clamped / this.minHz) / Math.log2(this.maxHz / this.minHz);
    return t * this.width;
  }

  /** dB -> Y pixel. */
  _dbToY(db) {
    const clamped = Math.max(MIN_DB, Math.min(MAX_DB, db));
    const t = (clamped - MIN_DB) / (MAX_DB - MIN_DB);
    return this.height * (1 - t);
  }

  /**
   * Draw one spectrum as a filled path.
   * @param {Float32Array} data - dB values per bin
   * @param {number} binHz - Hz per bin
   * @param {string} stroke
   * @param {string|null} fill
   */
  _drawCurve(data, binHz, stroke, fill) {
    const ctx = this.ctx;
    ctx.beginPath();
    let started = false;
    // Skip bin 0 (DC). Walk bins, but the log axis means low bins are sparse on
    // screen and high bins crowd — that's expected and correct for pitch.
    for (let i = 1; i < data.length; i++) {
      const hz = i * binHz;
      if (hz < this.minHz) continue;
      if (hz > this.maxHz) break;
      const x = this._hzToX(hz);
      const y = this._dbToY(data[i]);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    if (!started) return;

    if (fill) {
      // Close the path down to the baseline for a filled area.
      ctx.lineTo(this.width, this.height);
      ctx.lineTo(this._hzToX(this.minHz), this.height);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    }

    // Re-stroke the outline (fill closed the path, so redraw the line).
    ctx.beginPath();
    started = false;
    for (let i = 1; i < data.length; i++) {
      const hz = i * binHz;
      if (hz < this.minHz) continue;
      if (hz > this.maxHz) break;
      const x = this._hzToX(hz);
      const y = this._dbToY(data[i]);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  /** Frequency grid lines at musically meaningful decade/octave points. */
  _drawGrid() {
    const ctx = this.ctx;
    const marks = [50, 100, 200, 500, 1000, 2000, 5000];
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    for (const hz of marks) {
      if (hz < this.minHz || hz > this.maxHz) continue;
      const x = this._hzToX(hz);
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.height - 12);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.30)';
      const label = hz >= 1000 ? `${hz / 1000}k` : `${hz}`;
      ctx.fillText(label, x, this.height - 2);
    }
  }

  /** Vertical markers + shaded rejection zones for the active band. */
  _drawBand(band) {
    if (!band) return;
    const ctx = this.ctx;
    const { lowHz, highHz } = band;

    // Shade the REJECTED regions (outside the band) so it's obvious what's cut.
    ctx.fillStyle = 'rgba(255, 92, 138, 0.10)';
    if (lowHz) {
      const x = this._hzToX(lowHz);
      ctx.fillRect(0, 0, x, this.height - 12);
    }
    if (highHz && highHz < this.maxHz) {
      const x = this._hzToX(highHz);
      ctx.fillRect(x, 0, this.width - x, this.height - 12);
    }

    // Corner lines.
    ctx.strokeStyle = 'rgba(255, 92, 138, 0.55)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    for (const hz of [lowHz, highHz]) {
      if (!hz || hz < this.minHz || hz > this.maxHz) continue;
      const x = this._hzToX(hz);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.height - 12);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  /** Mark the currently detected pitch, so you can see it in the spectrum. */
  _drawPitchMarker(hz) {
    if (!hz || hz < this.minHz || hz > this.maxHz) return;
    const ctx = this.ctx;
    const x = this._hzToX(hz);
    ctx.strokeStyle = 'rgba(0, 212, 184, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, this.height - 12);
    ctx.stroke();
  }

  /**
   * @param {{raw:Float32Array, filtered:Float32Array, binHz:number}|null} spectra
   * @param {{lowHz:(number|null), highHz:(number|null)}|null} band
   * @param {number|null} detectedHz - current detected pitch, if any
   */
  render(spectra, band, detectedHz = null) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);

    this._drawGrid();
    this._drawBand(band);

    if (spectra) {
      // RAW first (dim, behind) — what the mic actually hears.
      this._drawCurve(
        spectra.raw, spectra.binHz,
        'rgba(138, 135, 156, 0.55)',
        'rgba(138, 135, 156, 0.10)'
      );
      // FILTERED on top (bright) — what the detector actually sees.
      this._drawCurve(
        spectra.filtered, spectra.binHz,
        'rgba(0, 212, 184, 0.95)',
        'rgba(0, 212, 184, 0.15)'
      );
    }

    this._drawPitchMarker(detectedHz);
  }

  destroy() {
    window.removeEventListener('resize', this._resizeHandler);
  }
}
