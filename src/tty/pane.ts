import { execSync } from 'node:child_process';
import { options } from '../args';
import { debugLog } from './debugLog';

type PaneInfo = {
  left: number;
  top: number;
  width: number;
  height: number;
};

let cached: { info: PaneInfo; at: number } | undefined;

export function getPaneInfo(): PaneInfo {
  const now = Date.now();
  if (cached && now - cached.at < 200) return cached.info;

  const fallback = { left: 0, top: 0, width: 0, height: 0 };
  const paneId = process.env.TMUX_PANE;
  if (!paneId) return fallback;

  try {
    const out = execSync(
      'tmux list-panes -a -F "#{pane_id} #{pane_left} #{pane_top} #{pane_width} #{pane_height}"',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    const line = out
      .split('\n')
      .find((l) => l.startsWith(`${paneId} `));
    if (!line) return fallback;

    const [, leftStr, topStr, widthStr, heightStr] = line.split(/\s+/);
    const left = Number.parseInt(leftStr, 10);
    const top = Number.parseInt(topStr, 10);
    const width = Number.parseInt(widthStr, 10);
    const height = Number.parseInt(heightStr, 10);

    const info = {
      left: Number.isFinite(left) ? left : 0,
      top: Number.isFinite(top) ? top : 0,
      width: Number.isFinite(width) ? width : 0,
      height: Number.isFinite(height) ? height : 0,
    };
    cached = { info, at: now };
    if (options['debug-paint']) {
      debugLog(`[TMUX][PANE] info left=${info.left} top=${info.top} size=${info.width}x${info.height}`);
    }
    return info;
  } catch {
    return fallback;
  }
}
