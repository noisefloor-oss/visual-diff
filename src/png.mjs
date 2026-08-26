// Cheap PNG header reads and shared render-contract helpers (FR-38) used by
// both render paths. Reading width/height from the IHDR costs nothing and
// needs no decoder, which is what lets both verbs gate every delivered
// screenshot against the frame they asked for; the structural cross-pass
// agreement check lives here for the same reason — one contract, two verbs.

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Width/height (device px) from a PNG's IHDR without decoding pixel data.
 * Returns null for anything that is not a plausible PNG — callers treat
 * that as a render defect in their own error vocabulary.
 */
export function pngDimensions(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    return null;
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * The delivered-frame contract: a screenshot taken with a clip rect must be
 * exactly the requested frame at the given device scale factor. Chromium
 * clamps a clip to the DOCUMENT scroll box and returns a short PNG without
 * error, so on layouts that scroll in an inner container (html,body at
 * height:100% with an overflow:auto main — the common app-shell shape) the
 * bottom of the frame silently never reaches the image. Returns null when
 * the delivered buffer matches, else a diagnostic { delivered, expected }
 * for the caller's fail-loud error.
 */
/**
 * Cross-pass structural agreement (FR-38 x FR-11/FR-17): the two independent
 * passes of a double render must make the SAME canvas-accommodation decision.
 * Equal pixels can hide a canvas race (one pass grew the viewport, the other
 * did not), and a declared pixel budget (selfCheck.maxDiffPixels) or noise
 * floor must never absorb it — the check is structural, outside any pixel
 * arithmetic. `a`/`b` are { canvasGrown, effectiveViewport, frame } where
 * frame is the integer-rounded rect the pass framed (undefined for unclipped
 * captures). Returns null on agreement, else a diagnostic naming both
 * passes' decisions.
 */
export function accommodationDivergence(a, b) {
  const sameSize = (x, y) => (x === undefined && y === undefined)
    || (x !== undefined && y !== undefined && x.width === y.width && x.height === y.height);
  const sameRect = (x, y) => (x === undefined && y === undefined)
    || (x !== undefined && y !== undefined
      && x.x === y.x && x.y === y.y && x.width === y.width && x.height === y.height);
  if (sameSize(a.canvasGrown, b.canvasGrown)
    && sameSize(a.effectiveViewport, b.effectiveViewport)
    && sameRect(a.frame, b.frame)) {
    return null;
  }
  const desc = (s) => {
    const grew = s.canvasGrown !== undefined
      ? `grew the canvas to ${s.canvasGrown.width}x${s.canvasGrown.height}`
      : 'did not grow the canvas';
    const eff = s.effectiveViewport !== undefined
      ? `, effective viewport ${s.effectiveViewport.width}x${s.effectiveViewport.height}`
      : '';
    const rect = s.frame !== undefined
      ? `, frame {x:${s.frame.x},y:${s.frame.y},w:${s.frame.width},h:${s.frame.height}}`
      : '';
    return `${grew}${eff}${rect}`;
  };
  return `pass 1 ${desc(a)}; pass 2 ${desc(b)}`;
}

export function frameShortfall(buf, frame, deviceScaleFactor) {
  const delivered = pngDimensions(buf);
  const expected = {
    width: Math.round(frame.width * deviceScaleFactor),
    height: Math.round(frame.height * deviceScaleFactor),
  };
  if (delivered !== null && delivered.width === expected.width && delivered.height === expected.height) {
    return null;
  }
  return { delivered, expected };
}
