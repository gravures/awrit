import type { getWindowSize } from 'awrit-native-rs';

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

  return {
    x: Math.floor(rawX * cellToPxX),
    y: Math.floor(rawY * cellToPxY),
  };
}
