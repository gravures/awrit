import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, normalizeConfig } from '../config';
import { loadConfig, resolveConfigPath } from './config';

// Real temp directories only: no mock, no real ~/.config or XDG touched.
function mktemp(): string {
  return fs.mkdtempSync(join(tmpdir(), 'awrit-config-test-'));
}

describe('config resolution', () => {
  let cwd: string;
  let xdg: string;
  let state: string;

  beforeEach(() => {
    cwd = mktemp();
    xdg = mktemp();
    state = mktemp();
  });

  afterEach(() => {
    for (const dir of [cwd, xdg, state]) fs.rmSync(dir, { recursive: true, force: true });
  });

  function opts(extra: Partial<Parameters<typeof resolveConfigPath>[0]> = {}) {
    return { cwd, envXdgConfigHome: xdg, ...extra };
  }

  test('cwd config.toml wins over the XDG one', () => {
    fs.writeFileSync(join(cwd, 'config.toml'), 'homepage = "from-cwd"');
    fs.mkdirSync(join(xdg, 'awrit'), { recursive: true });
    fs.writeFileSync(join(xdg, 'awrit', 'config.toml'), 'homepage = "from-xdg"');

    expect(resolveConfigPath(opts())).toBe(join(cwd, 'config.toml'));
  });

  test('XDG config is used when there is no cwd config', () => {
    fs.mkdirSync(join(xdg, 'awrit'), { recursive: true });
    fs.writeFileSync(join(xdg, 'awrit', 'config.toml'), 'homepage = "from-xdg"');

    expect(resolveConfigPath(opts())).toBe(join(xdg, 'awrit', 'config.toml'));
  });

  test('--config wins over both and is resolved against cwd', () => {
    fs.writeFileSync(join(cwd, 'config.toml'), 'homepage = "from-cwd"');
    const explicit = join(cwd, 'other.toml');
    fs.writeFileSync(explicit, 'homepage = "explicit"');

    expect(resolveConfigPath(opts({ argvConfig: 'other.toml' }))).toBe(explicit);
  });

  test('a missing --config file is an error, never a silent skip', () => {
    fs.writeFileSync(join(cwd, 'config.toml'), 'homepage = "from-cwd"');

    expect(() => resolveConfigPath(opts({ argvConfig: 'nope.toml' }))).toThrow(/--config/);
  });

  test('with nothing present, the default file is generated into XDG', () => {
    const configPath = resolveConfigPath(opts());
    expect(configPath).toBe(join(xdg, 'awrit', 'config.toml'));
    expect(fs.existsSync(configPath)).toBe(true);

    const parsed = Bun.TOML.parse(fs.readFileSync(configPath, 'utf8'));
    expect(parsed).toEqual(defaultConfig());
  });

  test('loadConfig normalizes and writes the resolved JSON Electron reads', () => {
    fs.writeFileSync(join(cwd, 'config.toml'), 'homepage = "https://example.com"');

    const res = loadConfig({ cwd, envXdgConfigHome: xdg, stateDir: state });

    expect(res.configPath).toBe(join(cwd, 'config.toml'));
    expect(res.config.homepage).toBe('https://example.com');
    // Missing options are filled from the defaults for the reader.
    expect(res.config.keybindings).toEqual(normalizeConfig({}).config.keybindings);

    expect(res.jsonPath).toBe(join(state, 'config.json'));
    const written = JSON.parse(fs.readFileSync(res.jsonPath, 'utf8'));
    expect(written).toEqual(res.config);
  });

  test('an invalid TOML file fails with the file and the reason', () => {
    fs.writeFileSync(join(cwd, 'config.toml'), 'homepage = "unterminated');

    expect(() => loadConfig({ cwd, envXdgConfigHome: xdg, stateDir: state })).toThrow(
      /failed to parse config TOML/,
    );
  });

  test('a wrong value fails with the option name', () => {
    fs.writeFileSync(join(cwd, 'config.toml'), 'rasterScale = "big"');

    expect(() => loadConfig({ cwd, envXdgConfigHome: xdg, stateDir: state })).toThrow(
      /rasterScale must be a number/,
    );
  });

  test('unknown options are reported and ignored', () => {
    fs.writeFileSync(join(cwd, 'config.toml'), 'homepage = "x"\nfutureOption = 3');

    const res = loadConfig({ cwd, envXdgConfigHome: xdg, stateDir: state });
    expect(res.unknownKeys).toEqual(['futureOption']);
    expect(res.config.homepage).toBe('x');
  });
});
