// Resolution-independent layout: the play area is a fixed-aspect box centred in the viewport,
// with letterbox bars filling the rest. Pure maths so the fast tier can test it without a DOM.

/** The play area's aspect ratio. A layout constant, not game tuning. */
export const PLAY_ASPECT = 16 / 9;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The largest `aspect`-ratio box that fits in `width` x `height`, centred. Bars appear on the
 * left and right when the viewport is wider than the aspect, top and bottom when it is taller.
 */
export function letterbox(width: number, height: number, aspect: number = PLAY_ASPECT): Box {
  const w = Number.isFinite(width) && width > 0 ? width : 0;
  const h = Number.isFinite(height) && height > 0 ? height : 0;
  if (!(aspect > 0) || w === 0 || h === 0) return { x: 0, y: 0, width: w, height: h };
  if (w / h > aspect) {
    const boxWidth = h * aspect;
    return { x: (w - boxWidth) / 2, y: 0, width: boxWidth, height: h };
  }
  const boxHeight = w / aspect;
  return { x: 0, y: (h - boxHeight) / 2, width: w, height: boxHeight };
}
