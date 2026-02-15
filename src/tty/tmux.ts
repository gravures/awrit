import { execFileSync } from 'node:child_process';

type TmuxPaneSize = {
  cols: number;
  rows: number;
};

export type TmuxPaneStatus = 'active' | 'inactive' | 'invisible';

export function isTmuxSession() {
  return Boolean(process.env.TMUX && process.env.TMUX_PANE);
}

function runTmux(args: readonly string[]) {
  return execFileSync('tmux', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: process.env,
  }).trim();
}

function getPaneId() {
  const pane = process.env.TMUX_PANE;
  if (!pane) {
    throw new Error('TMUX_PANE not set');
  }
  if (!/^%\d+$/.test(pane)) {
    throw new Error(`Invalid TMUX_PANE value: "${pane}"`);
  }
  return pane;
}

export function getTmuxVersion() {
  const output = runTmux(['-V']);
  const match = output.match(/tmux\s+(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return { major: Number(match[1]), minor: Number(match[2]) };
}

export function requireTmuxVersion(minMajor: number, minMinor: number) {
  const version = getTmuxVersion();
  if (!version) {
    throw new Error('Unable to determine tmux version');
  }
  if (version.major > minMajor) return;
  if (version.major === minMajor && version.minor >= minMinor) return;
  throw new Error(`tmux ${minMajor}.${minMinor}+ is required (found ${version.major}.${version.minor})`);
}

export function getAllowPassthrough() {
  return runTmux(['show', '-gv', 'allow-passthrough']);
}

export function allowPassthroughEnabled() {
  const value = getAllowPassthrough();
  return value === 'on' || value === 'all';
}

export function mouseEnabled() {
  return runTmux(['show', '-gv', 'mouse']) === 'on';
}

export function allowPassthroughAll() {
  return getAllowPassthrough() === 'all';
}

export function requireAllowPassthroughAll() {
  const value = getAllowPassthrough();
  if (value !== 'all') {
    throw new Error(`tmux allow-passthrough must be set to "all" (found "${value}")`);
  }
}

export function getPaneTty() {
  const pane = getPaneId();
  return runTmux(['display-message', '-t', pane, '-p', '#{pane_tty}']);
}

const PANE_SIZE_CACHE_TTL_MS = 250;
let paneSizeCache:
  | {
      pane: string;
      size: TmuxPaneSize;
      at: number;
    }
  | undefined;

export function getPaneSize(): TmuxPaneSize {
  const pane = getPaneId();
  const now = Date.now();
  if (paneSizeCache && paneSizeCache.pane === pane && now - paneSizeCache.at < PANE_SIZE_CACHE_TTL_MS) {
    return paneSizeCache.size;
  }

  const output = runTmux(['display-message', '-t', pane, '-p', '#{pane_width} #{pane_height}']);
  const [colsRaw, rowsRaw] = output.split(/\s+/);
  const cols = Number(colsRaw);
  const rows = Number(rowsRaw);
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) {
    throw new Error(`Unable to parse tmux pane size: "${output}"`);
  }

  const size = { cols, rows };
  paneSizeCache = { pane, size, at: now };
  return size;
}

export function getPaneStatus(): TmuxPaneStatus {
  const pane = getPaneId();
  const status = runTmux(['display-message', '-t', pane, '-p', '#{window_active}#{pane_active}']);
  if (status === '11') return 'active';
  if (status === '10') return 'inactive';
  return 'invisible';
}

export function tmuxWrap(sequence: string, layers = 1) {
  let wrapped = sequence;
  for (let layer = 0; layer < layers; layer++) {
    wrapped = `\x1bPtmux;${wrapped.split('\x1b').join('\x1b\x1b')}\x1b\\`;
  }
  return wrapped;
}
