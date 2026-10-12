import { describe, expect, test } from 'bun:test';
import {
  CONFIG_OPTIONS,
  DEFAULT_KEYBINDINGS,
  defaultConfig,
  generateToml,
  mergeConfigs,
  normalizeConfig,
} from './config';
import { actions } from './actions';

describe('config schema', () => {
  test('generated TOML round-trips through the parser and normalizer', () => {
    const parsed = Bun.TOML.parse(generateToml());
    const { config, unknownKeys } = normalizeConfig(parsed as never);

    expect(unknownKeys).toEqual([]);
    expect(config).toEqual(normalizeConfig({}).config);
  });

  test('every declared option has a default that passes validation', () => {
    const { config, unknownKeys } = normalizeConfig({});
    expect(unknownKeys).toEqual([]);
    for (const opt of CONFIG_OPTIONS) {
      expect(config[opt.key], opt.key).toBeDefined();
    }
    expect(config.keybindings).toEqual(DEFAULT_KEYBINDINGS);
  });

  test('options missing from a user file are filled from the defaults', () => {
    // A config written before a new option existed keeps working: only the
    // keys the user set are theirs, the rest come from CONFIG_OPTIONS.
    const { config } = normalizeConfig({ homepage: 'https://example.com' });
    expect(config.homepage).toBe('https://example.com');
    expect(config.rasterScale).toBe(2);
    expect(config.sharedTexture).toBe(true);
    expect(config.barTheme).toBe('reverse');
    expect(config.keybindings).toEqual(DEFAULT_KEYBINDINGS);
  });

  test('unknown keys are reported, not rejected', () => {
    const { unknownKeys } = normalizeConfig({ homepage: 'x', futureOption: 1 } as never);
    expect(unknownKeys).toEqual(['futureOption']);
  });

  test('wrong types are rejected with the option name in the message', () => {
    expect(() => normalizeConfig({ rasterScale: 'big' } as never)).toThrow(/rasterScale/);
    expect(() => normalizeConfig({ sharedTexture: 'yes' } as never)).toThrow(/sharedTexture/);
    expect(() => normalizeConfig({ keybindings: { '<C-r>': 5 } } as never)).toThrow(/keybindings/);
  });

  test('an empty keybindings table stays empty (explicit "no bindings")', () => {
    const { config } = normalizeConfig({ keybindings: {} });
    expect(config.keybindings).toEqual({});
  });

  test('adding an option to CONFIG_OPTIONS is picked up without touching the generator', () => {
    // Locks the "clever generator" requirement: the generator and the loader
    // read the declaration, so a new option is one entry.
    CONFIG_OPTIONS.push({
      key: 'extraThing',
      type: 'number',
      default: 7,
      doc: 'A hypothetical future option.',
    });
    try {
      const parsed = Bun.TOML.parse(generateToml());
      expect(parsed.extraThing).toBe(7);

      const { config } = normalizeConfig({} as never);
      expect(config.extraThing).toBe(7);
    } finally {
      CONFIG_OPTIONS.pop();
    }
  });

  test('the generated file lists the real action names', () => {
    const toml = generateToml();
    expect(toml).toContain('# Actions:');
    for (const name of Object.keys(actions)) {
      expect(toml, name).toContain(name);
    }
  });

  test('the generated file records the focus-url keybinding (action on the left)', () => {
    const parsed = Bun.TOML.parse(generateToml());
    const bindings = parsed.keybindings as Record<string, string>;
    expect(bindings['focus-url']).toBe('<C-o>');
    expect(Object.keys(bindings)).not.toContain('<C-o>');
  });

  test('an action-first keybindings table loads as keybinding -> action', () => {
    const { config, unknownKeys } = normalizeConfig({
      keybindings: { forward: '<C-]>', back: '<C-[>' },
    } as never);
    expect(unknownKeys).toEqual([]);
    expect(config.keybindings).toEqual({ '<C-]>': 'forward', '<C-[>': 'back' });
  });

  test('an action-first table with multiple keys per action (arrays) loads too', () => {
    const { config } = normalizeConfig({
      keybindings: { back: ['<C-[>', '<Mouse4>'], forward: ['<C-]>', '<Mouse5>'] },
    } as never);
    expect(config.keybindings).toEqual({
      '<C-[>': 'back',
      '<Mouse4>': 'back',
      '<C-]>': 'forward',
      '<Mouse5>': 'forward',
    });
  });

  test('a legacy keybinding-first table still loads unchanged', () => {
    const { config } = normalizeConfig({
      keybindings: { '<C-]>': 'forward', '<C-[>': 'back' },
    } as never);
    expect(config.keybindings).toEqual({ '<C-]>': 'forward', '<C-[>': 'back' });
  });

  test('mergeConfigs: a more specific layer wins per scalar key', () => {
    const merged = mergeConfigs([
      defaultConfig(),
      { rasterScale: 3 } as never,
      { rasterScale: 4 } as never,
    ]);
    expect(merged.rasterScale).toBe(4);
    expect(merged.homepage).toBe(defaultConfig().homepage);
    expect(merged.barTheme).toBe(defaultConfig().barTheme);
  });

  test('mergeConfigs: keybindings merge per binding, an override unmaps nothing else', () => {
    const merged = mergeConfigs([
      { keybindings: { back: ['<C-[>', '<Mouse4>'], forward: ['<C-]>', '<Mouse5>'] } } as never,
      { keybindings: { back: '<C-b>', find: '<C-f>' } } as never,
    ]);
    expect(merged.keybindings).toEqual({
      '<C-[>': 'back',
      '<Mouse4>': 'back',
      '<C-b>': 'back',
      '<C-]>': 'forward',
      '<Mouse5>': 'forward',
      '<C-f>': 'find',
    });
  });

  test('the generated file records the barTheme default', () => {
    expect(Bun.TOML.parse(generateToml()).barTheme).toBe('reverse');
  });

  test('defaults build from the declaration, not a second copy', () => {
    expect(defaultConfig()).toEqual(normalizeConfig({}).config);
  });
});
