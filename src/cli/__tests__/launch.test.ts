import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  enterTmuxPassthrough,
  restoreTmuxPassthrough,
  type TmuxResult,
  type TmuxRunner,
} from '../launch';

const OPTION = 'allow-passthrough';
const PANE = '%42';
const BUN = process.execPath;
const LAUNCH_TS = join(import.meta.dir, '../launch.ts');

// ── unit: the contract against an injected tmux runner ──────────────────────

function recorder(handler: (args: string[]) => TmuxResult): { calls: string[][]; run: TmuxRunner } {
  const calls: string[][] = [];
  const run: TmuxRunner = (args) => {
    calls.push(args);
    return handler(args);
  };
  return { calls, run };
}

test('tmux launch scopes passthrough and records an inherited pane value', () => {
  const { calls, run } = recorder((args) => ({
    status: 0,
    stdout: args.includes('-A') ? 'on' : '',
  }));

  expect(enterTmuxPassthrough(PANE, run)).toEqual({ mode: 'inherit' });
  expect(calls).toEqual([
    ['show-options', '-p', '-v', '-t', PANE, OPTION],
    ['show-options', '-p', '-A', '-v', '-t', PANE, OPTION],
    ['set-option', '-p', '-t', PANE, OPTION, 'all'],
  ]);
});

test('restore unsets the option when the pane had no local value', () => {
  const { calls, run } = recorder(() => ({ status: 0, stdout: '' }));

  restoreTmuxPassthrough(PANE, { mode: 'inherit' }, run);
  expect(calls).toEqual([['set-option', '-p', '-u', '-t', PANE, OPTION]]);
});

test('restore puts back an existing pane-local override', () => {
  const { calls, run } = recorder(() => ({ status: 0, stdout: '' }));

  restoreTmuxPassthrough(PANE, { mode: 'local', value: 'off' }, run);
  expect(calls).toEqual([['set-option', '-p', '-t', PANE, OPTION, 'off']]);
});

test('tmux launch fails closed with an invalid pane identity', () => {
  const { calls, run } = recorder(() => ({ status: 0, stdout: 'on' }));

  expect(() => enterTmuxPassthrough('invalid', run)).toThrow(/invalid TMUX_PANE/);
  expect(calls).toEqual([]);
});

test('tmux launch fails closed when the pane-local value cannot be read', () => {
  const { run } = recorder(() => ({ status: 55, stdout: '' }));

  expect(() => enterTmuxPassthrough(PANE, run)).toThrow(/pane-local/);
});

test('tmux launch fails closed on an invalid effective value', () => {
  const { run } = recorder((args) => ({
    status: 0,
    stdout: args.includes('-A') ? 'bogus' : '',
  }));

  expect(() => enterTmuxPassthrough(PANE, run)).toThrow(/effective/);
});

test('tmux launch fails closed when passthrough cannot be enabled', () => {
  const { run } = recorder((args) =>
    args[0] === 'set-option'
      ? { status: 55, stdout: '' }
      : { status: 0, stdout: args.includes('-A') ? 'on' : '' },
  );

  expect(() => enterTmuxPassthrough(PANE, run)).toThrow(/enable/);
});

// ── integration: real process, fake tmux on PATH, fake child ────────────────
// Mirrors the retired tests/test-launcher.sh fixtures: a fake `tmux` that logs its
// argv (and can be told to fail a command), a fake child that logs its argv/cwd,
// all driven through a harness that calls beginLaunch() then exits.

const FAKE_TMUX = `#!/usr/bin/env bash
command="\${1:-}"
{
  printf '%s' "$command"
  shift || true
  printf ' <%s>' "$@"
  printf '\\n'
} >>"$AWRIT_TEST_TMUX_LOG"
if [[ "\${AWRIT_TEST_TMUX_FAIL_COMMAND:-}" == "$command" ]]; then
  exit 55
fi
if [[ "$command" == "show-options" ]]; then
  if [[ " $* " == *" -A "* ]]; then
    printf '%s\\n' "\${AWRIT_TEST_TMUX_EFFECTIVE_PASSTHROUGH:-on}"
  elif [[ -n "\${AWRIT_TEST_TMUX_LOCAL_PASSTHROUGH:-}" ]]; then
    printf '%s\\n' "$AWRIT_TEST_TMUX_LOCAL_PASSTHROUGH"
  fi
fi
`;

const FAKE_CHILD = `#!/usr/bin/env bash
{
  printf 'cwd=%s\\n' "$PWD"
  printf '<%s>\\n' "$@"
} >"$AWRIT_TEST_CHILD_LOG"
exit "\${AWRIT_TEST_CHILD_EXIT:-0}"
`;

const HARNESS = `import { beginLaunch } from ${JSON.stringify(LAUNCH_TS)};
import { spawnSync } from 'node:child_process';
try {
  beginLaunch();
} catch (error) {
  process.stderr.write(\`\${error instanceof Error ? error.message : error}\\n\`);
  process.exit(1);
}
const result = spawnSync(process.env.AWRIT_TEST_CHILD as string, process.argv.slice(2), {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
`;

interface Fixture {
  dir: string;
  bin: string;
  child: string;
  harness: string;
  workdir: string;
  tmuxLog: string;
  childLog: string;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'awrit-launch-'));
  const bin = join(dir, 'bin');
  const workdir = join(dir, 'project with spaces');
  mkdirSync(bin);
  mkdirSync(workdir);

  const tmux = join(bin, 'tmux');
  const child = join(dir, 'child');
  const harness = join(dir, 'harness.ts');
  writeFileSync(tmux, FAKE_TMUX);
  writeFileSync(child, FAKE_CHILD);
  writeFileSync(harness, HARNESS);
  chmodSync(tmux, 0o755);
  chmodSync(child, 0o755);

  return {
    dir,
    bin,
    child,
    harness,
    workdir,
    tmuxLog: join(dir, 'tmux.log'),
    childLog: join(dir, 'child.log'),
  };
}

function runHarness(
  fx: Fixture,
  args: string[],
  extra: Record<string, string> = {},
  tmux = true,
): { exitCode: number; stderr: string } {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${fx.bin}:${process.env.PATH}`,
    AWRIT_TEST_TMUX_LOG: fx.tmuxLog,
    AWRIT_TEST_CHILD_LOG: fx.childLog,
    AWRIT_TEST_CHILD: fx.child,
    ...extra,
  };
  if (tmux) {
    env.TMUX = '/tmp/tmux';
    env.TMUX_PANE = extra.TMUX_PANE ?? PANE;
  } else {
    delete env.TMUX;
    delete env.TMUX_PANE;
  }

  const result = Bun.spawnSync([BUN, 'run', fx.harness, ...args], {
    cwd: fx.workdir,
    env,
    stdout: 'ignore',
    stderr: 'pipe',
  });
  return { exitCode: result.exitCode, stderr: result.stderr.toString() };
}

function withFixture(fn: (fx: Fixture) => void): void {
  const fx = makeFixture();
  try {
    fn(fx);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
}

test('tmux launch scopes passthrough for its lifetime and preserves argv/cwd', () => {
  withFixture((fx) => {
    const url = 'https://example.com/a?b=c';
    const { exitCode } = runHarness(fx, [url]);
    expect(exitCode).toBe(0);

    const tmux = readFileSync(fx.tmuxLog, 'utf8');
    expect(tmux).toContain(`set-option <-p> <-t> <${PANE}> <${OPTION}> <all>`);
    expect(tmux).toContain(`set-option <-p> <-u> <-t> <${PANE}> <${OPTION}>`);

    const child = readFileSync(fx.childLog, 'utf8');
    expect(child).toContain(`cwd=${fx.workdir}`);
    expect(child).toContain(`<${url}>`);
  });
});

test('tmux passthrough is restored after a non-zero exit', () => {
  withFixture((fx) => {
    const { exitCode } = runHarness(fx, ['--help'], { AWRIT_TEST_CHILD_EXIT: '7' });
    expect(exitCode).toBe(7);

    const tmux = readFileSync(fx.tmuxLog, 'utf8');
    expect(tmux).toContain(`set-option <-p> <-t> <${PANE}> <${OPTION}> <all>`);
    expect(tmux).toContain(`set-option <-p> <-u> <-t> <${PANE}> <${OPTION}>`);
  });
});

test('tmux passthrough restores an existing pane-local override', () => {
  withFixture((fx) => {
    const { exitCode } = runHarness(fx, ['--help'], {
      AWRIT_TEST_TMUX_LOCAL_PASSTHROUGH: 'off',
      AWRIT_TEST_TMUX_EFFECTIVE_PASSTHROUGH: 'off',
    });
    expect(exitCode).toBe(0);

    const tmux = readFileSync(fx.tmuxLog, 'utf8');
    expect(tmux).toContain(`set-option <-p> <-t> <${PANE}> <${OPTION}> <all>`);
    expect(tmux).toContain(`set-option <-p> <-t> <${PANE}> <${OPTION}> <off>`);
  });
});

test('tmux launch fails closed when passthrough cannot be queried', () => {
  withFixture((fx) => {
    const { exitCode } = runHarness(fx, ['--help'], {
      AWRIT_TEST_TMUX_FAIL_COMMAND: 'show-options',
    });
    expect(exitCode).not.toBe(0);
    expect(existsSync(fx.childLog)).toBe(false);
  });
});

test('tmux launch fails closed when passthrough cannot be enabled', () => {
  withFixture((fx) => {
    const { exitCode } = runHarness(fx, ['--help'], {
      AWRIT_TEST_TMUX_FAIL_COMMAND: 'set-option',
    });
    expect(exitCode).not.toBe(0);
    expect(existsSync(fx.childLog)).toBe(false);
  });
});

test('tmux launch fails closed with an invalid pane identity', () => {
  withFixture((fx) => {
    const { exitCode } = runHarness(fx, ['--help'], { TMUX_PANE: 'invalid' });
    expect(exitCode).not.toBe(0);
    expect(existsSync(fx.childLog)).toBe(false);
  });
});

test('non-tmux launch runs without touching tmux', () => {
  withFixture((fx) => {
    const { exitCode } = runHarness(fx, ['--help'], {}, false);
    expect(exitCode).toBe(0);
    expect(existsSync(fx.tmuxLog)).toBe(false);
    expect(readFileSync(fx.childLog, 'utf8')).toContain('<--help>');
  });
});
