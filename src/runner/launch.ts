import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// Single entry point (09-03): the runner owns everything the bash `awrit` wrapper
// used to do — resolving its install root, scoping tmux passthrough, and reporting
// errors. This module is the one place those live.

// ── install root ────────────────────────────────────────────────────────────

export interface RootInfo {
  root: string;
  isRelease: boolean;
}

// A `bun build --compile` binary cannot know its source tree, so it derives the
// install directory from process.execPath (already symlink-resolved by Bun;
// realpath is belt-and-braces for a symlinked ~/.local/bin/awrit). Everything else
// is the dev checkout. AWRIT_ROOT is gone.
export function resolveRoot(): RootInfo {
  if (Bun.isStandaloneExecutable) {
    return { root: dirname(fs.realpathSync(process.execPath)), isRelease: true };
  }
  return { root: resolve(__dirname, '../../'), isRelease: false };
}

// ── tmux passthrough ────────────────────────────────────────────────────────

export interface TmuxResult {
  status: number;
  stdout: string;
}

export type TmuxRunner = (args: string[]) => TmuxResult;

export const realTmux: TmuxRunner = (args) => {
  const result = spawnSync('tmux', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? '' };
};

export type PassthroughState = { mode: 'inherit' } | { mode: 'local'; value: string };

const PANE_ID = /^%[0-9]+$/;
const PASSTHROUGH_VALUES = /^(on|off|all)$/;
const OPTION = 'allow-passthrough';

// Sets the pane-local option to `all` and returns what to restore on exit. Fails
// closed: any tmux error throws before Electron is spawned. This mirrors the
// contract locked by the retired tests/test-launcher.sh — do not loosen it.
export function enterTmuxPassthrough(pane: string, tmux: TmuxRunner = realTmux): PassthroughState {
  if (!PANE_ID.test(pane)) {
    throw new Error('awrit: refusing tmux launch with an invalid TMUX_PANE');
  }

  const local = tmux(['show-options', '-p', '-v', '-t', pane, OPTION]);
  if (local.status !== 0) {
    throw new Error('awrit: unable to read pane-local tmux passthrough');
  }

  const effective = tmux(['show-options', '-p', '-A', '-v', '-t', pane, OPTION]);
  if (effective.status !== 0) {
    throw new Error('awrit: unable to read effective tmux passthrough');
  }
  if (!PASSTHROUGH_VALUES.test(effective.stdout.trim())) {
    throw new Error('awrit: tmux returned an invalid effective passthrough value');
  }

  const localValue = local.stdout.trim();
  let state: PassthroughState;
  if (localValue === '') {
    state = { mode: 'inherit' };
  } else if (PASSTHROUGH_VALUES.test(localValue)) {
    state = { mode: 'local', value: localValue };
  } else {
    throw new Error('awrit: tmux returned an invalid pane-local passthrough value');
  }

  const set = tmux(['set-option', '-p', '-t', pane, OPTION, 'all']);
  if (set.status !== 0) {
    throw new Error('awrit: unable to enable pane-local tmux passthrough');
  }

  return state;
}

// Restores the pane-local option exactly as the shell EXIT trap did. Best effort:
// a failing restore must never change the process exit status.
export function restoreTmuxPassthrough(
  pane: string,
  state: PassthroughState,
  tmux: TmuxRunner = realTmux,
): void {
  if (state.mode === 'inherit') {
    tmux(['set-option', '-p', '-u', '-t', pane, OPTION]);
  } else {
    tmux(['set-option', '-p', '-t', pane, OPTION, state.value]);
  }
}

// Registers the restore on process exit. process.exit(0) from the SIGINT/SIGTERM
// handlers still fires this (measured 2026-10-09), and the synchronous 0.05 s
// delay matches the shell's `sleep 0.05`. Re-entry guarded, like `trap - EXIT`.
export function installPassthroughRestore(
  pane: string,
  state: PassthroughState,
  tmux: TmuxRunner = realTmux,
): void {
  let restored = false;
  process.on('exit', () => {
    if (restored) return;
    restored = true;
    Bun.sleepSync(50);
    restoreTmuxPassthrough(pane, state, tmux);
  });
}

// On the tmux path, scope passthrough before Electron starts and arrange the
// restore. A no-op outside tmux. Throws (fail closed) if scoping fails.
export function beginLaunch(env: Record<string, string | undefined> = process.env): void {
  if (!env.TMUX) return;
  const pane = env.TMUX_PANE ?? '';
  const state = enterTmuxPassthrough(pane);
  installPassthroughRestore(pane, state);
}

// ── error sink ──────────────────────────────────────────────────────────────

// Routine diagnostics the launcher used to hide in awrit_error.txt. They go to a
// log file, never the TTY, so they cannot corrupt the rendered pane.
export function logDiagnostic(message: string): void {
  appendLog(message);
}

// Fatal pre-paint error: loud on stderr where the human sees it, mirrored to the
// log for post-mortem. Replaces the awrit_error.txt sink and its silent failures.
export function fatal(message: string): never {
  const line = message.startsWith('awrit:') ? message : `awrit: ${message}`;
  process.stderr.write(`${line}\n`);
  appendLog(`FATAL ${line}`);
  process.exit(1);
}

export function logPath(): string {
  const stateHome = process.env.XDG_STATE_HOME
    ? process.env.XDG_STATE_HOME
    : join(homedir(), '.local', 'state');
  return join(stateHome, 'awrit', 'awrit.log');
}

function appendLog(message: string): void {
  try {
    const file = logPath();
    fs.mkdirSync(dirname(file), { recursive: true });
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // logging is best effort — never let it mask the real failure
  }
}
