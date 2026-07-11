/* js/harmonica.js
 *
 * A model of the standard 10-hole Richter-tuned diatonic harmonica.
 *
 * Key insight (verified against C and A harp layouts): every diatonic harp of
 * a given key is the SAME instrument transposed. A harp in key K is the C
 * template shifted by (pitchClass(K) - 0) semitones. So we encode the C
 * template once as semitone offsets from the tonic, and generate any key by
 * adding an offset. Nothing here is hard-coded to C beyond the template's
 * reference point.
 *
 * The template is expressed in SEMITONES ABOVE THE HARP'S TONIC, with correct
 * octave placement, so that (hole, action) -> absolute MIDI is exact once a
 * tonic octave is chosen. This module is pure data + lookups: no DOM, no audio.
 */

import { NOTE_NAMES } from './theory.js';

// ---------------------------------------------------------------------------
// The C-harp template, as semitone offsets from the tonic (C = 0).
//
// Holes 1..10. Each entry gives the interval above the tonic for blow and draw,
// and the ordered list of draw-bend and blow-bend intervals available in that
// hole. Values are semitones above the harp tonic in the harp's LOWEST octave
// register; octave span is applied via HOLE_OCTAVE below.
//
// Derived from the standard Richter layout and cross-checked: transposing this
// by +9 reproduces a real A-harp chart cell-for-cell.
// ---------------------------------------------------------------------------

// Semitone interval above tonic for each hole's blow and draw reed.
// (C harp: blow C E G C E G C E G C ; draw D G B D F A B D F A)
const BLOW_INTERVAL = [0, 4, 7, 12, 16, 19, 24, 28, 31, 36];
const DRAW_INTERVAL = [2, 7, 11, 14, 17, 21, 23, 26, 29, 33];

// Draw-bend intervals available per hole (semitones above tonic), highest
// bend first as you press further. Empty array = no draw bend on that hole.
// C harp: h1 Db; h2 Gb,F; h3 Bb,A,Ab; h4 Db; h6 Ab.
const DRAW_BEND_INTERVALS = {
  1: [1],            // Db
  2: [6, 5],         // Gb, F
  3: [10, 9, 8],     // Bb, A, Ab
  4: [13],           // Db (octave up: 1+12)
  6: [20],           // Ab (8+12)
};

// Blow-bend intervals per hole (upper register). C harp: h8 Eb; h9 Gb; h10 Bb,B.
const BLOW_BEND_INTERVALS = {
  8: [27],           // Eb (3+24)
  9: [30],           // Gb (6+24)
  10: [34, 35],      // Bb, B (10+24, 11+24)
};

// ---------------------------------------------------------------------------
// Harmonica class
// ---------------------------------------------------------------------------

export class Harmonica {
  /**
   * @param {string|number} key - harp key as a note name ('C','A','Bb'...) or
   *        a pitch class 0..11. Determines the transposition offset.
   * @param {number} [tonicOctave=4] - octave of hole-1 blow (C harp => C4).
   *        Standard C harp's 1-blow is C4 (MIDI 60).
   */
  constructor(key = 'C', tonicOctave = 4) {
    this.keyPc = typeof key === 'number' ? ((key % 12) + 12) % 12 : pcFromName(key);
    this.keyName = NOTE_NAMES[this.keyPc];
    this.tonicOctave = tonicOctave;

    // Absolute MIDI of the harp tonic in its lowest register (hole-1 blow).
    // C harp: C4 = 60. Transposition can push this below; we anchor so that
    // hole-1 blow lands on the tonic at/near tonicOctave.
    this._tonicMidi = 12 * (tonicOctave + 1) + this.keyPc;

    this._buildNotes();
  }

  /**
   * Build the full note map: every (hole, action) -> { midi, pc, name, octave }.
   * Actions: 'blow', 'draw', 'draw-bend-N', 'blow-bend-N' (N = 1-based depth).
   */
  _buildNotes() {
    /** @type {NoteEntry[]} */
    this.notes = [];
    // Map from MIDI -> array of NoteEntry (to expose the 2-draw/3-blow overlap).
    this.byMidi = new Map();

    const push = (hole, action, interval, bendDepth = 0) => {
      const midi = this._tonicMidi + interval;
      const pc = ((midi % 12) + 12) % 12;
      const octave = Math.floor(midi / 12) - 1;
      const entry = {
        hole,
        action,
        bendDepth, // 0 = natural, 1..n = bend steps
        interval,
        midi,
        pc,
        name: NOTE_NAMES[pc],
        octave,
        isBend: bendDepth > 0,
      };
      this.notes.push(entry);
      if (!this.byMidi.has(midi)) this.byMidi.set(midi, []);
      this.byMidi.get(midi).push(entry);
    };

    for (let h = 1; h <= 10; h++) {
      push(h, 'blow', BLOW_INTERVAL[h - 1]);
      push(h, 'draw', DRAW_INTERVAL[h - 1]);
    }
    for (const [h, list] of Object.entries(DRAW_BEND_INTERVALS)) {
      list.forEach((iv, i) => push(Number(h), `draw-bend-${i + 1}`, iv, i + 1));
    }
    for (const [h, list] of Object.entries(BLOW_BEND_INTERVALS)) {
      list.forEach((iv, i) => push(Number(h), `blow-bend-${i + 1}`, iv, i + 1));
    }

    // Sort canonical note list by MIDI for stable display.
    this.notes.sort((a, b) => a.midi - b.midi);
  }

  /**
   * All natural (unbent) notes for the layout grid, indexed by hole.
   * @returns {{hole:number, blow:NoteEntry, draw:NoteEntry,
   *            drawBends:NoteEntry[], blowBends:NoteEntry[]}[]}
   */
  getHoles() {
    const holes = [];
    for (let h = 1; h <= 10; h++) {
      const forHole = this.notes.filter((n) => n.hole === h);
      holes.push({
        hole: h,
        blow: forHole.find((n) => n.action === 'blow'),
        draw: forHole.find((n) => n.action === 'draw'),
        drawBends: forHole.filter((n) => n.action.startsWith('draw-bend')).sort((a, b) => a.bendDepth - b.bendDepth),
        blowBends: forHole.filter((n) => n.action.startsWith('blow-bend')).sort((a, b) => a.bendDepth - b.bendDepth),
      });
    }
    return holes;
  }

  /**
   * Identify which hole/action(s) produce a given MIDI note. Returns an array
   * because of the single documented overlap (2-draw / 3-blow share one pitch).
   * @param {number} midi - integer MIDI note
   * @returns {NoteEntry[]} zero, one, or (rarely) two entries
   */
  lookupMidi(midi) {
    return this.byMidi.get(midi) || [];
  }

  /**
   * Given an EXACT (fractional) MIDI value from live detection, find the most
   * relevant hole context for the bend watcher: the natural note at or above
   * the pitch whose hole can bend down to it, plus that hole's bend targets.
   *
   * Strategy: a draw bend lives between the draw reed (top) and the blow reed
   * (bottom) of the same hole. So for a fractional pitch, we find any hole
   * whose [min bend target .. draw] range contains it. Returns candidate holes
   * with their full target ladder so the UI can draw guide lines.
   *
   * @param {number} midiExact - fractional MIDI from the detector
   * @returns {BendContext[]} candidate hole contexts (usually 0 or 1)
   */
  bendContextForPitch(midiExact) {
    const contexts = [];
    for (const hole of this.getHoles()) {
      // Draw-bend region: from draw reed down to its lowest bend target.
      if (hole.drawBends.length) {
        const top = hole.draw.midi;
        const bottom = hole.drawBends[hole.drawBends.length - 1].midi;
        if (midiExact <= top + 0.5 && midiExact >= bottom - 0.5) {
          contexts.push(this._makeBendContext(hole, 'draw', top, bottom));
        }
      }
      // Blow-bend region: from blow reed down to lowest blow-bend target.
      if (hole.blowBends.length) {
        const top = hole.blow.midi;
        const bottom = hole.blowBends[hole.blowBends.length - 1].midi;
        if (midiExact <= top + 0.5 && midiExact >= bottom - 0.5) {
          contexts.push(this._makeBendContext(hole, 'blow', top, bottom));
        }
      }
    }
    return contexts;
  }

  _makeBendContext(hole, type, topMidi, bottomMidi) {
    const bends = type === 'draw' ? hole.drawBends : hole.blowBends;
    const root = type === 'draw' ? hole.draw : hole.blow;
    // Targets: the root plus each bend stop, as guide lines (label + midi).
    const targets = [
      { label: `${hole.hole}${type === 'draw' ? 'D' : 'B'}`, midi: root.midi, name: root.name, octave: root.octave, isRoot: true },
      ...bends.map((b) => ({
        label: `${b.name}${b.octave}`,
        midi: b.midi,
        name: b.name,
        octave: b.octave,
        isRoot: false,
        bendDepth: b.bendDepth,
      })),
    ];
    return { hole: hole.hole, type, topMidi, bottomMidi, root, targets };
  }

  /**
   * Which holes can bend at all (draw or blow). Used to decide when the bend
   * watcher should be active.
   * @returns {Set<number>}
   */
  bendableHoles() {
    const s = new Set();
    for (const h of Object.keys(DRAW_BEND_INTERVALS)) s.add(Number(h));
    for (const h of Object.keys(BLOW_BEND_INTERVALS)) s.add(Number(h));
    return s;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pcFromName(name) {
  const map = {
    C: 0, 'C#': 1, DB: 1, D: 2, 'D#': 3, EB: 3, E: 4, F: 5,
    'F#': 6, GB: 6, G: 7, 'G#': 8, AB: 8, A: 9, 'A#': 10, BB: 10, B: 11,
  };
  const key = name.trim().toUpperCase();
  if (!(key in map)) {
    console.warn(`[harmonica] unknown key name "${name}", defaulting to C`);
    return 0;
  }
  return map[key];
}

/**
 * @typedef {object} NoteEntry
 * @property {number} hole - 1..10
 * @property {string} action - 'blow' | 'draw' | 'draw-bend-N' | 'blow-bend-N'
 * @property {number} bendDepth - 0 natural, else bend step
 * @property {number} interval - semitones above harp tonic
 * @property {number} midi
 * @property {number} pc - pitch class 0..11
 * @property {string} name
 * @property {number} octave
 * @property {boolean} isBend
 */

/**
 * @typedef {object} BendContext
 * @property {number} hole
 * @property {string} type - 'draw' | 'blow'
 * @property {number} topMidi - unbent reed pitch (top of bend range)
 * @property {number} bottomMidi - lowest bend target
 * @property {NoteEntry} root
 * @property {{label:string,midi:number,name:string,octave:number,isRoot:boolean,bendDepth?:number}[]} targets
 */
