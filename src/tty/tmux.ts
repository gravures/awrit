import { execFileSync } from 'node:child_process';

type TmuxPaneSize = {
  cols: number;
  rows: number;
};

export type TmuxPaneStatus = 'active' | 'inactive' | 'invisible';

export type TmuxPaneState = {
  status: TmuxPaneStatus;
  viewers: string;
};

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
  const pane = getPaneId();
  return runTmux(['show-options', '-p', '-A', '-v', '-t', pane, 'allow-passthrough']);
}

export function mouseEnabled() {
  return runTmux(['show', '-gv', 'mouse']) === 'on';
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

function normalizeViewerIds(viewers: string) {
  return viewers
    .split(',')
    .map((viewer) => viewer.trim())
    .filter(Boolean)
    .sort()
    .join(',');
}

export function getPaneState(): TmuxPaneState {
  const pane = getPaneId();
  const status = runTmux([
    'display-message',
    '-t',
    pane,
    '-p',
    '#{window_active_clients}|#{window_active_clients_list}|#{pane_active}|#{window_zoomed_flag}',
  ]);
  const [viewerCountRaw, viewerIdsRaw = '', paneActive, windowZoomed] = status.split('|');
  const viewerCount = Number(viewerCountRaw);
  const viewers = normalizeViewerIds(viewerIdsRaw) || `count:${viewerCountRaw}`;
  if (!Number.isInteger(viewerCount) || viewerCount <= 0) {
    return { status: 'invisible', viewers: '' };
  }
  if (windowZoomed === '1' && paneActive === '0') {
    return { status: 'invisible', viewers };
  }
  if (paneActive === '1') return { status: 'active', viewers };
  if (paneActive === '0') return { status: 'inactive', viewers };
  return { status: 'invisible', viewers };
}

export function getPaneStatus(): TmuxPaneStatus {
  return getPaneState().status;
}

export function tmuxWrap(sequence: string, layers = 1) {
  let wrapped = sequence;
  for (let layer = 0; layer < layers; layer++) {
    wrapped = `\x1bPtmux;${wrapped.split('\x1b').join('\x1b\x1b')}\x1b\\`;
  }
  return wrapped;
}
