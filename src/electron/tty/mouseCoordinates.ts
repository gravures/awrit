import type { getWindowSize } from '../../native';

export type MouseCoordinateMode = 'unknown' | 'cell' | 'pixel';

export function getForcedTmuxMouseCoordinateMode(
  value = process.env.AWRIT_TMUX_MOUSE_COORDS,
): Exclude<MouseCoordinateMode, 'unknown'> | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'cell' || normalized === 'pixel') {
    return normalized;
  }
  return null;
}

export function nextTmuxMouseCoordinateMode(
  rawX: number,
  rawY: number,
  termSize: ReturnType<typeof getWindowSize>,
  currentMode: MouseCoordinateMode,
  forcedMode: Exclude<MouseCoordinateMode, 'unknown'> | null = getForcedTmuxMouseCoordinateMode(),
): Exclude<MouseCoordinateMode, 'unknown'> {
  if (forcedMode) return forcedMode;

  const maxCellX = termSize.cols + 1;
  const maxCellY = termSize.rows + 1;
  const canOnlyBePixel = rawX > maxCellX || rawY > maxCellY;
  if (canOnlyBePixel || currentMode === 'pixel') return 'pixel';
  return 'cell';
}

export function normalizeTmuxMouseCoordinates(
  rawX: number,
  rawY: number,
  termSize: ReturnType<typeof getWindowSize>,
  mode: MouseCoordinateMode,
) {
  if (mode !== 'cell') {
    return { x: rawX, y: rawY };
  }

  let cellToPxX = termSize.width / termSize.cols;
  let cellToPxY = termSize.height / termSize.rows;
  if (!Number.isFinite(cellToPxX) || cellToPxX <= 0) cellToPxX = 1;
  if (!Number.isFinite(cellToPxY) || cellToPxY <= 0) cellToPxY = 1;

  // tmux only tells us which cell was clicked, not where inside it. Map to the
  // cell *center*: the top-left corner collapses the whole row to y=0, and the
  // bar row is one cell tall, which would land in the bar's padding.
  return {
    x: Math.floor((rawX + 0.5) * cellToPxX),
    y: Math.floor((rawY + 0.5) * cellToPxY),
  };
}
