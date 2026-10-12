import { features } from './features';
import { getWindowSize } from './native';
import { CSI } from './tty/escapeCodes';
import type { WindowView } from './windows';

export type BarMode = 'normal' | 'normal-editing' | 'find' | 'find-editing';

export interface BarState {
  mode: BarMode;
  buffer: string;
  cursor: number;
  url: string;
  cols: number;
}

export const isBarEditing = (mode: BarMode) => mode === 'normal-editing' || mode === 'find-editing';

/** Width of the "> " / "/ " prompt, shared by the renderer and the edit keys. */
export const BAR_PROMPT_WIDTH = 2;

const CURSOR_ON = CSI`?25h`;
const CURSOR_OFF = CSI`?25l`;
const SGR_BAR = CSI`7m`;
const SGR_RESET = CSI`0m`;
const cup = (row: number, col: number) => CSI`${row};${col}H`;

function barText({ mode, buffer, url }: BarState): string {
  switch (mode) {
    case 'normal':
      return url;
    case 'normal-editing':
      return `> ${buffer}`;
    case 'find':
    case 'find-editing':
      return `/ ${buffer}`;
  }
}

/**
 * Row-0 write: one CUP + SGR + exactly `cols` cells + reset, plus a positioned,
 * shown cursor in the editing modes. Pure, so it can be asserted byte-for-byte.
 *
 * ponytail: every char counts as one cell (no wcwidth) and on overflow the tail
 * is shown so the cursor stays visible. Upgrade if wide/emoji input matters.
 */
export function renderBar(state: BarState): string {
  const cols = Math.max(1, Math.floor(state.cols));
  const full = barText(state);
  const dropped = Math.max(0, full.length - cols);
  const line = (dropped > 0 ? full.slice(dropped) : full).padEnd(cols, ' ');
  const out = cup(1, 1) + SGR_BAR + line + SGR_RESET;
  if (!isBarEditing(state.mode)) return out + CURSOR_OFF;
  const cell = Math.max(0, Math.min(cols - 1, BAR_PROMPT_WIDTH + state.cursor - dropped));
  return out + cup(1, cell + 1) + CURSOR_ON;
}

/** Render the current bar state into pane row 0 — plain CSI, never an image. */
export function redrawBar(view?: WindowView): void {
  const url = view?.content.webContents.getURL() || features.bar.url;
  features.bar.url = url;
  // No readable pane size (piped stdout, tests) — nothing to pad to.
  let cols = 0;
  try {
    cols = getWindowSize().cols;
  } catch {
    return;
  }
  if (!cols) return;
  process.stdout.write(renderBar({ ...features.bar, url, cols }));
}

/** Enter URL editing (the `focus-url` action and a click in row 0). */
export function startUrlEditing(view?: WindowView): void {
  const bar = features.bar;
  bar.mode = 'normal-editing';
  bar.buffer = view?.content.webContents.getURL() || bar.url;
  bar.cursor = bar.buffer.length;
  redrawBar(view);
}

/** Enter find editing (the `find` action). Keeps the last query in the buffer. */
export function startFindEditing(view?: WindowView): void {
  const bar = features.bar;
  bar.mode = 'find-editing';
  bar.cursor = bar.buffer.length;
  redrawBar(view);
}
