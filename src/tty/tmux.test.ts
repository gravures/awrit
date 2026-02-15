import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fakeTimers } from '../fake-timers.test';
import { getPaneSize } from './tmux';

const clock = fakeTimers();

function countLinesContaining(text: string, needle: string) {
  return text
    .split('\n')
    .filter((line) => line.includes(needle)).length;
}

describe('tmux helpers', () => {
  const originalPath = process.env.PATH;
  const originalPane = process.env.TMUX_PANE;
  const originalTmux = process.env.TMUX;
  const originalArgsLog = process.env.AWRIT_TMUX_ARGS_LOG;
  const originalSize = process.env.AWRIT_TMUX_SIZE;

  let fixtureDir = '';
  let logPath = '';

  beforeEach(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'awrit-tmux-test-'));
    logPath = join(fixtureDir, 'tmux-args.log');
    const tmuxPath = join(fixtureDir, 'tmux');

    writeFileSync(
      tmuxPath,
      `#!/usr/bin/env bash
set -euo pipefail
echo "$@" >> "$AWRIT_TMUX_ARGS_LOG"
if [[ "\${1:-}" == "-V" ]]; then
  echo "tmux 3.4"
  exit 0
fi
if [[ "\${1:-}" == "display-message" && "\${5:-}" == "#{pane_width} #{pane_height}" ]]; then
  echo "\${AWRIT_TMUX_SIZE:-80 24}"
  exit 0
fi
if [[ "\${1:-}" == "display-message" && "\${5:-}" == "#{pane_tty}" ]]; then
  echo "/dev/ttys001"
  exit 0
fi
if [[ "\${1:-}" == "display-message" && "\${5:-}" == "#{window_active}#{pane_active}" ]]; then
  echo "11"
  exit 0
fi
if [[ "\${1:-}" == "show" && "\${4:-}" == "allow-passthrough" ]]; then
  echo "all"
  exit 0
fi
echo ""
`,
    );
    chmodSync(tmuxPath, 0o755);
    writeFileSync(logPath, '');

    process.env.PATH = `${fixtureDir}:${originalPath ?? ''}`;
    process.env.AWRIT_TMUX_ARGS_LOG = logPath;
    process.env.AWRIT_TMUX_SIZE = '120 40';
    process.env.TMUX = '/tmp/tmux-123/default,123,0';
  });

  afterEach(() => {
    if (originalPath == null) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }

    if (originalPane == null) {
      delete process.env.TMUX_PANE;
    } else {
      process.env.TMUX_PANE = originalPane;
    }

    if (originalTmux == null) {
      delete process.env.TMUX;
    } else {
      process.env.TMUX = originalTmux;
    }

    if (originalArgsLog == null) {
      delete process.env.AWRIT_TMUX_ARGS_LOG;
    } else {
      process.env.AWRIT_TMUX_ARGS_LOG = originalArgsLog;
    }

    if (originalSize == null) {
      delete process.env.AWRIT_TMUX_SIZE;
    } else {
      process.env.AWRIT_TMUX_SIZE = originalSize;
    }

    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('rejects invalid TMUX_PANE values before invoking tmux', () => {
    process.env.TMUX_PANE = ';rm -rf /';

    expect(() => getPaneSize()).toThrow('Invalid TMUX_PANE value');
    expect(readFileSync(logPath, 'utf8')).toBe('');
  });

  test('caches pane size for the same pane id within TTL', () => {
    process.env.TMUX_PANE = `%${Date.now()}1`;

    expect(getPaneSize()).toEqual({ cols: 120, rows: 40 });
    expect(getPaneSize()).toEqual({ cols: 120, rows: 40 });

    const log = readFileSync(logPath, 'utf8');
    expect(countLinesContaining(log, '#{pane_width} #{pane_height}')).toBe(1);
  });

  test('refreshes pane size after cache TTL expires', async () => {
    process.env.TMUX_PANE = `%${Date.now()}2`;

    expect(getPaneSize()).toEqual({ cols: 120, rows: 40 });
    await clock.tickAsync(251);
    expect(getPaneSize()).toEqual({ cols: 120, rows: 40 });

    const log = readFileSync(logPath, 'utf8');
    expect(countLinesContaining(log, '#{pane_width} #{pane_height}')).toBe(2);
  });
});
