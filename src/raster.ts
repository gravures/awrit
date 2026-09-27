/**
 * Raster scale: pane physical px ÷ rasterScale = the bitmap Electron hands us.
 *
 * The terminal stretches the bitmap back over the same number of cells, so
 * rasterScale 2 renders a quarter of the pixels at half the size and lets the
 * terminal upscale — cheaper encode, larger text, softer edges. The trade is
 * the user's (config.js `rasterScale`); 1 is the untouched 1:1 behaviour.
 */
let scale = 1;

export function getRasterScale(): number {
  return scale;
}

/** Anything that is not a positive finite number means "no scaling". */
export function setRasterScale(value: unknown) {
  const n = typeof value === 'number' ? value : Number.NaN;
  scale = Number.isFinite(n) && n > 0 ? n : 1;
}

type TermSize = { cols: number; rows: number; width: number; height: number };

/**
 * Bitmap pixels per pane pixel = displayScale / rasterScale. The bitmap (content
 * DIP × display scale) and the pane (TIOCGWINSZ px) are different spaces
 * whenever either factor isn't 1, and mixing them silently halves the column
 * count. Set once per layout, wherever both values are in scope.
 */
let pxPerPanePx = 1;

export function setPaneToBitmap(value: number) {
  pxPerPanePx = Number.isFinite(value) && value > 0 ? value : 1;
}

function safeCellToPx(size: TermSize) {
  let x = size.width / size.cols;
  let y = size.height / size.rows;
  if (!Number.isFinite(x) || x <= 0) x = 1;
  if (!Number.isFinite(y) || y <= 0) y = 1;
  return { x, y };
}

/**
 * Cell size in bitmap px — the space the paint handlers measure in, since
 * `image.getSize()` and `LayoutNode.deviceLayout` are both bitmap px. A smaller
 * bitmap means proportionally smaller cells, so pane-space cells would report
 * `rasterScale`× the columns the bitmap actually holds.
 */
export function rasterCellToPx(size: TermSize) {
  const cell = safeCellToPx(size);
  return { x: cell.x * pxPerPanePx, y: cell.y * pxPerPanePx };
}

/**
 * Cells a bitmap spans, for the protocol's `c`/`r` keys. A smaller raster is
 * placed by declaring the cell span it fills, and the terminal scales it to fit
 * — the same trick tmux gets from `a=p,c,r` without `w=/h=`.
 *
 * The image's aspect has to track the cell rect or the terminal letterboxes
 * (black bars). Snapping the toolbar to a whole cell is what keeps the two in
 * step: a whole-cell toolbar leaves the content a whole number of cells, so the
 * span lands within a pixel of the bitmap's own aspect.
 */
export function cellSpan(
  bitmapSize: { width: number; height: number },
  termSize: TermSize,
): { cols: number; rows: number } {
  const cell = rasterCellToPx(termSize);
  return {
    cols: Math.max(1, Math.ceil(bitmapSize.width / cell.x)),
    rows: Math.max(1, Math.ceil(bitmapSize.height / cell.y)),
  };
}
