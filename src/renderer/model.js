"use strict";

/**
 * Pure reel-edit model — NO DOM. Loadable both as a browser classic script
 * (attaches to window.ReelModel) and via require() in Node tests. Keeping the
 * cut/extend math and subtitle logic here makes the non-destructive editing
 * model unit-testable without a GUI.
 */
(function (root) {
  // Conservative filler set for the editor's display aid. The real, audio-level
  // filler cut happens server-side at export via the engine's cutFillersFromVideo.
  const FILLERS = new Set(["um", "uh", "umm", "uhh", "er", "erm", "ah", "hmm", "mhm", "mm"]);

  const MIN_SPAN = 0.3; // never collapse a span below this many seconds

  function normTok(w) {
    return String(w || "").toLowerCase().replace(/[^a-z']/g, "");
  }
  function isFiller(w) {
    return FILLERS.has(normTok(w));
  }
  function editedText(reel, i, fallback) {
    const e = reel.settings.subtitleEdits[i];
    return e != null ? e : fallback;
  }

  function recomputeReel(reel) {
    reel.inSec = reel.segments[0].startSec;
    reel.outSec = reel.segments[reel.segments.length - 1].endSec;
    reel.durationSec =
      Math.round(reel.segments.reduce((a, s) => a + (s.endSec - s.startSec), 0) * 10) / 10;
    return reel;
  }

  // Cut (move inward) / extend (move outward) the in-point: first span start.
  function setReelIn(reel, t) {
    const first = reel.segments[0];
    first.startSec = Math.max(0, Math.min(t, first.endSec - MIN_SPAN));
    return recomputeReel(reel);
  }
  // Cut/extend the out-point: last span end, bounded by the master duration.
  function setReelOut(reel, t, masterDur) {
    const last = reel.segments[reel.segments.length - 1];
    const hi = masterDur > 0 ? masterDur : t;
    last.endSec = Math.min(hi, Math.max(t, last.startSec + MIN_SPAN));
    return recomputeReel(reel);
  }

  // Move ANY span's start, bounded by the previous span's end (or 0) and its own
  // end minus MIN_SPAN. Generalises setReelIn to interior spans created by a split.
  function setSegmentStart(reel, idx, t) {
    const segs = reel.segments;
    const seg = segs[idx];
    if (!seg) return recomputeReel(reel);
    const lo = idx > 0 ? segs[idx - 1].endSec : 0;
    seg.startSec = Math.max(lo, Math.min(t, seg.endSec - MIN_SPAN));
    return recomputeReel(reel);
  }
  // Move ANY span's end, bounded by its own start plus MIN_SPAN and the next
  // span's start (or the master duration for the last span).
  function setSegmentEnd(reel, idx, t, masterDur) {
    const segs = reel.segments;
    const seg = segs[idx];
    if (!seg) return recomputeReel(reel);
    const hi =
      idx < segs.length - 1 ? segs[idx + 1].startSec : masterDur > 0 ? masterDur : t;
    seg.endSec = Math.min(hi, Math.max(t, seg.startSec + MIN_SPAN));
    return recomputeReel(reel);
  }

  // Razor: split the span under time t into two contiguous spans. No-op (returns
  // -1) if t sits at or outside every span's editable interior. Returns the index
  // of the left span on success so callers can focus/redraw around it.
  function splitReel(reel, t) {
    const segs = reel.segments;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (t > s.startSec + MIN_SPAN && t < s.endSec - MIN_SPAN) {
        const right = { startSec: t, endSec: s.endSec };
        if (s.role != null) right.role = s.role;
        s.endSec = t;
        segs.splice(i + 1, 0, right);
        recomputeReel(reel);
        return i;
      }
    }
    return -1;
  }

  // Drop one span (used after a split to actually cut a piece out). Refuses to
  // delete the last remaining span so a reel is never left empty.
  function deleteSegment(reel, idx) {
    const segs = reel.segments;
    if (segs.length <= 1 || idx < 0 || idx >= segs.length) return false;
    segs.splice(idx, 1);
    recomputeReel(reel);
    return true;
  }

  // Words shown as subtitles: edits applied, fillers dropped when the toggle is
  // on, and words the editor blanked out (edited to empty/whitespace) removed.
  function visibleWords(reel) {
    return reel.words
      .map((w, pos) => {
        const key = w.index != null ? w.index : pos; // stable global index
        return {
          i: key,
          start: w.start,
          end: w.end,
          text: editedText(reel, key, w.word),
          filler: isFiller(w.word),
        };
      })
      .filter((w) => !(reel.settings.removeFillers && w.filler))
      .filter((w) => String(w.text).trim() !== "");
  }

  const api = {
    FILLERS,
    MIN_SPAN,
    normTok,
    isFiller,
    editedText,
    recomputeReel,
    setReelIn,
    setReelOut,
    setSegmentStart,
    setSegmentEnd,
    splitReel,
    deleteSegment,
    visibleWords,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ReelModel = api;
})(typeof window !== "undefined" ? window : globalThis);
