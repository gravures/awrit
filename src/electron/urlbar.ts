import { features } from './features';
import { getWindowSize } from '../native';
import { CSI } from './tty/escapeCodes';
import type { WindowView } from './windows';

export type BarMode = 'normal' | 'normal-editing' | 'find' | 'find-editing';

/** Bar security indicator, derived from the content URL scheme (07-04). */
export type BarLock = 'secure' | 'insecure' | 'none';

/** Bar colour preset name, selected by the `barTheme` config option (07-04). */
export type BarTheme = 'reverse' | 'none' | 'dark' | 'light' | 'accent';

export interface BarState {
  mode: BarMode;
  buffer: string;
  cursor: number;
  url: string;
  cols: number;
  lock: BarLock;
  findCount: { index: number; total: number };
  theme: BarTheme;
}

export const isBarEditing = (mode: BarMode) => mode === 'normal-editing' || mode === 'find-editing';

/** Width of the "> " / "/ " prompt, shared by the renderer and the edit keys. */
export const BAR_PROMPT_WIDTH = 2;

const CURSOR_ON = CSI`?25h`;
const CURSOR_OFF = CSI`?25l`;
const SGR_RESET = CSI`0m`;
const cup = (row: number, col: number) => CSI`${row};${col}H`;

/**
 * Bar colour presets. 8/16-colour SGR only (universal terminal support); each is
 * applied for the row and reset afterwards. `reverse` is the 07-03 default look.
 */
export const BAR_THEMES: Record<BarTheme, string> = {
  reverse: CSI`7m`,
  none: '',
  dark: CSI`37;40m`,
  light: CSI`30;47m`,
  accent: CSI`30;43m`,
};

export const isBarTheme = (v: string): v is BarTheme => v in BAR_THEMES;

/**
 * Scheme-only security indicator. Electron 37's `did-navigate` carries no
 * security flag, so the URL scheme is the only dependency-free source.
 */
export function lockForUrl(url: string): BarLock {
  try {
    const { protocol } = new URL(url);
    if (protocol === 'https:') return 'secure';
    if (protocol === 'http:') return 'insecure';
  } catch {
    // Not a URL (empty, first paint) — no indicator.
  }
  return 'none';
}

/** Lock glyph + a trailing space. `width` counts display cells, not JS length. */
const LOCK_PREFIX: Record<BarLock, string> = { secure: '🔒 ', insecure: '⚠ ', none: '' };
const LOCK_PREFIX_WIDTH: Record<BarLock, number> = { secure: 3, insecure: 2, none: 0 };

function barText({ mode, buffer, findCount }: BarState): string {
  switch (mode) {
    case 'normal':
      return '';
    case 'normal-editing':
      return `> ${buffer}`;
    case 'find':
    case 'find-editing': {
      if (findCount.total > 0) {
        return `/ ${buffer} [${findCount.index}/${findCount.total}]`;
      }
      return `/ ${buffer}`;
    }
  }
}

/**
 * Bottom-row write: one CUP + SGR + exactly `cols` cells + reset, plus a positioned,
 * shown cursor in the editing modes. Pure, so it can be asserted byte-for-byte.
 *
 * In normal mode a lock glyph prefixes the URL and is always kept visible (the
 * URL is truncated from the front); padding is by display width, not JS length,
 * so the 🔒 (2 cells) keeps the row exactly `cols`.
 *
 * ponytail: only the two lock glyphs are measured — every other char counts as one
 * cell (no wcwidth) and on overflow the tail is shown so the cursor stays visible.
 * Upgrade if wide/emoji input matters.
 */
export function renderBar(state: BarState, rows: number): string {
  const cols = Math.max(1, Math.floor(state.cols));
  const targetRow = Math.max(1, Math.floor(rows));
  const isNormal = state.mode === 'normal';
  const prefix = isNormal ? LOCK_PREFIX[state.lock] : '';
  const prefixWidth = isNormal ? LOCK_PREFIX_WIDTH[state.lock] : 0;
  const avail = Math.max(1, cols - prefixWidth);
  const full = isNormal ? state.url : barText(state);
  const dropped = Math.max(0, full.length - avail);
  const tail = dropped > 0 ? full.slice(dropped) : full;
  const line = prefix + tail + ' '.repeat(Math.max(0, avail - tail.length));
  const out = cup(targetRow, 1) + BAR_THEMES[state.theme] + line + SGR_RESET;
  if (!isBarEditing(state.mode)) return out + CURSOR_OFF;
  const cell = Math.max(0, Math.min(cols - 1, BAR_PROMPT_WIDTH + state.cursor - dropped));
  return out + cup(targetRow, cell + 1) + CURSOR_ON;
}

/** Render the current bar state into the bottom pane row — plain CSI, never an image. */
export function redrawBar(view?: WindowView): void {
  const url = view?.content.webContents.getURL() || features.bar.url;
  features.bar.url = url;
  // No readable pane size (piped stdout, tests) — nothing to pad to.
  let cols = 0;
  let rows = 0;
  try {
    const size = getWindowSize();
    cols = size.cols;
    rows = size.rows;
  } catch {
    return;
  }
  if (!cols || !rows) return;
  process.stdout.write(renderBar({ ...features.bar, url, cols }, rows));
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
