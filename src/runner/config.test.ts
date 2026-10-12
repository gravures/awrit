import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeConfig } from '../config';
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
    // The generated file is action-first on the left; loading it resolves to
    // the same keybinding -> action map as starting from an empty config.
    expect(normalizeConfig(parsed as never).config).toEqual(normalizeConfig({}).config);
  });

  test('loadConfig normalizes and writes the resolved JSON Electron reads', () => {
    fs.writeFileSync(join(cwd, 'config.toml'), '[browser]\nhomepage = "https://example.com"');

    const res = loadConfig({ cwd, envXdgConfigHome: xdg, stateDir: state });

    expect(res.configPath).toBe(join(cwd, 'config.toml'));
    expect(res.config.browser.homepage).toBe('https://example.com');
    // Missing options are filled from the defaults for the reader.
    expect(res.config.keybindings).toEqual(normalizeConfig({}).config.keybindings);

    expect(res.jsonPath).toBe(join(state, 'config.json'));
    const written = JSON.parse(fs.readFileSync(res.jsonPath, 'utf8'));
    expect(written).toEqual(res.config);
  });

  test('a cwd scalar overrides the XDG one (layered merge, not pick-one)', () => {
    fs.mkdirSync(join(xdg, 'awrit'), { recursive: true });
    fs.writeFileSync(join(xdg, 'awrit', 'config.toml'), '[render]\nrasterScale = 2\n[browser]\nhomepage = "from-xdg"');
    fs.writeFileSync(join(cwd, 'config.toml'), '[render]\nrasterScale = 4');

    const res = loadConfig({ cwd, envXdgConfigHome: xdg, stateDir: state });

    expect(res.config.render.rasterScale).toBe(4);
    expect(res.config.browser.homepage).toBe('from-xdg');
    expect(res.sources).toEqual([join(xdg, 'awrit', 'config.toml'), join(cwd, 'config.toml')]);
  });

  test('keybindings merge across layers: one override keeps the rest', () => {
    fs.mkdirSync(join(xdg, 'awrit'), { recursive: true });
    fs.writeFileSync(
      join(xdg, 'awrit', 'config.toml'),
      '[keybindings]\nback = ["<C-[>", "<Mouse4>"]\nforward = ["<C-]>", "<Mouse5>"]',
    );
    fs.writeFileSync(join(cwd, 'config.toml'), '[keybindings]\nforward = "<C-x>"');

    const res = loadConfig({ cwd, envXdgConfigHome: xdg, stateDir: state });

    expect(res.config.keybindings['<C-x>']).toBe('forward'); // the override
    expect(res.config.keybindings['<C-]>']).toBe('forward'); // untouched from XDG
    expect(res.config.keybindings['<Mouse5>']).toBe('forward');
    expect(res.config.keybindings['<C-[>']).toBe('back'); // untouched from XDG
    expect(res.config.keybindings['<Mouse4>']).toBe('back');
  });

  test('a setting present only in XDG wins over the default, not the other way', () => {
    fs.mkdirSync(join(xdg, 'awrit'), { recursive: true });
    fs.writeFileSync(join(xdg, 'awrit', 'config.toml'), '[ui]\nbarTheme = "dark"');

    const res = loadConfig({ cwd, envXdgConfigHome: xdg, stateDir: state });

    expect(res.sources).toEqual([join(xdg, 'awrit', 'config.toml')]);
    expect(res.config.ui.barTheme).toBe('dark');
  });

  test('a removed XDG config is regenerated even when a cwd config exists', () => {
    fs.writeFileSync(join(cwd, 'config.toml'), '[browser]\nhomepage = "from-cwd"');

    expect(resolveConfigPath(opts())).toBe(join(cwd, 'config.toml'));

    const regenerated = join(xdg, 'awrit', 'config.toml');
    expect(fs.existsSync(regenerated)).toBe(true);
    const parsed = Bun.TOML.parse(fs.readFileSync(regenerated, 'utf8'));
    expect(normalizeConfig(parsed as never).config).toEqual(normalizeConfig({}).config);
  });

  test('loading merges the regenerated XDG default under the cwd overrides', () => {
    fs.writeFileSync(join(cwd, 'config.toml'), '[render]\nrasterScale = 4');

    const res = loadConfig({ cwd, envXdgConfigHome: xdg, stateDir: state });

    expect(res.sources).toEqual([join(xdg, 'awrit', 'config.toml'), join(cwd, 'config.toml')]);
    expect(res.config.render.rasterScale).toBe(4);
    expect(res.config.keybindings).toEqual(normalizeConfig({}).config.keybindings);
  });

  test('an invalid TOML file fails with the file and the reason', () => {
    fs.writeFileSync(join(cwd, 'config.toml'), '[browser]\nhomepage = "unterminated');

    expect(() => loadConfig({ cwd, envXdgConfigHome: xdg, stateDir: state })).toThrow(
      /failed to parse config TOML/,
    );
  });

  test('a wrong value fails with the option name', () => {
    fs.writeFileSync(join(cwd, 'config.toml'), '[render]\nrasterScale = "big"');

    expect(() => loadConfig({ cwd, envXdgConfigHome: xdg, stateDir: state })).toThrow(
      /rasterScale must be a number/,
    );
  });

  test('unknown options are reported and ignored', () => {
    fs.writeFileSync(join(cwd, 'config.toml'), '[browser]\nhomepage = "x"\nfutureOption = 3');

    const res = loadConfig({ cwd, envXdgConfigHome: xdg, stateDir: state });
    expect(res.unknownKeys).toEqual(['browser.futureOption']);
    expect(res.config.browser.homepage).toBe('x');
  });
});
