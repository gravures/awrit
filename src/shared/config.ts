import { homedir } from 'node:os';
import { join } from 'node:path';
import { actions } from '../electron/actions';

/**
 * The single home for configuration machinery.
 *
 * Options are declared once in CONFIG_OPTIONS (key, type, default, doc).
 * Everything else is derived from that declaration:
 *   - generateToml() writes the default config file,
 *   - normalizeConfig() validates a parsed file and fills missing keys from
 *     the defaults, so a config written by an older awrit keeps working when
 *     new options appear.
 * Adding an option is one entry in CONFIG_OPTIONS; the generator and the
 * loader pick it up without further changes.
 */

export const RESOLVED_CONFIG_ENV = 'AWRIT_CONFIG_JSON';
export const CONFIG_DIR = 'awrit';
export const CONFIG_FILE_NAME = 'config.json';
export const CONFIG_TOML_NAME = 'config.toml';

export interface RawKeybindings {
  [key: string]: string | string[] | undefined;
}

export interface RawRenderConfig {
  rasterScale?: number;
  sharedTexture?: boolean;
}

export interface RawUiConfig {
  barTheme?: string;
}

export interface RawBrowserConfig {
  homepage?: string;
  searchEngine?: string;
}

export interface RawConfig {
  render?: RawRenderConfig;
  ui?: RawUiConfig;
  browser?: RawBrowserConfig;
  keybindings?: RawKeybindings;
  [key: string]: unknown;
}

/** A fully resolved config: every declared option is present. */
export interface AwritConfig {
  render: RawRenderConfig;
  ui: RawUiConfig;
  browser: { homepage: string; searchEngine: string };
  keybindings: Record<string, string>;
}

export type ConfigOptionType = 'string' | 'number' | 'boolean' | 'table';

export interface SubConfigOption {
  key: string;
  type: ConfigOptionType;
  default: unknown;
  doc: string;
}

export interface ConfigOption {
  key: string;
  type: ConfigOptionType;
  default: unknown;
  doc: string;
  subOptions?: SubConfigOption[];
}

/**
 * One opinionated keybinding table for every platform. Modifier spellings:
 * <C-x> ctrl, <A-x> alt, <S-x> shift, <M-x> meta, <Cmd-x> Cmd on macOS and
 * Ctrl elsewhere, <Super-x> the super/Windows key. <Cmd-*> exists so the same
 * file expresses the same intent on macOS and Linux.
 */
export const DEFAULT_KEYBINDINGS: RawKeybindings = {
  '<C-]>': 'forward',
  '<C-[>': 'back',
  '<C-r>': 'refresh',
  '<C-f>': 'find',
  // Ctrl-O ("open") focuses the URL bar. A bare `o`/`g` would swallow that
  // letter while typing in a page — awrit has no command mode yet.
  '<C-o>': 'focus-url',
  '<C-a>': 'select-all',
  '<A-=>': 'zoom-in',
  '<A-minus>': 'zoom-out',
  '<A-0>': 'zoom-reset',
  '<C-c>': 'quit',
  '<Mouse4>': 'back',
  '<Mouse5>': 'forward',
};

export const CONFIG_OPTIONS: ConfigOption[] = [
  {
    key: 'render',
    type: 'table',
    default: { rasterScale: 1, sharedTexture: true },
    doc: 'Rendering options.',
    subOptions: [
      {
        key: 'rasterScale',
        type: 'number',
        default: 1,
        doc:
          'Pane pixels divided by this is the bitmap Electron renders; the terminal stretches it ' +
          'back over the same cells. 1 = 1:1 with the pane. 2 = a quarter of the pixels, upscaled 2x ' +
          '(larger text, softer edges). Any positive number works.',
      },
      {
        key: 'sharedTexture',
        type: 'boolean',
        default: true,
        doc:
          'GPU shared-texture paint path for the fallback renderer (Ghostty outside tmux). Removes ' +
          'the CPU pixel read; gateable for comparison.',
      },
    ],
  },
  {
    key: 'ui',
    type: 'table',
    default: { barTheme: 'reverse' },
    doc: 'UI appearance options.',
    subOptions: [
      {
        key: 'barTheme',
        type: 'string',
        default: 'reverse',
        doc:
          'Bar colour preset: reverse, none, dark, light, accent. An unknown value falls ' +
          'back to reverse (the default look).',
      },
    ],
  },
  {
    key: 'browser',
    type: 'table',
    default: { homepage: 'auto', searchEngine: 'https://duckduckgo.com/?q=' },
    doc: 'Browser behaviour options.',
    subOptions: [
      {
        key: 'homepage',
        type: 'string',
        default: 'auto',
        doc:
          'Page shown when no URL is given. "auto" (default) uses the searchEngine base URL; ' +
          'any other value is used as-is.',
      },
      {
        key: 'searchEngine',
        type: 'string',
        default: 'https://duckduckgo.com/?q=',
        doc: 'Search engine URL template. Use {q} for the query (URL-encoded).',
      },
    ],
  },
  {
    key: 'keybindings',
    type: 'table',
    default: DEFAULT_KEYBINDINGS,
    doc: 'Action name -> key sequence (or a list of keys). Pressing a key runs the named action.',
  },
];

function baseUrlFromSearchEngine(se: string): string {
  try {
    const u = new URL(se);
    return u.origin;
  } catch {
    return 'https://duckduckgo.com';
  }
}

/** The default config, built from CONFIG_OPTIONS — the source of the generated file. */
export function defaultConfig(): RawConfig {
  const out: Record<string, unknown> = {};
  for (const opt of CONFIG_OPTIONS) {
    if (opt.type === 'table' && opt.subOptions) {
      const table: Record<string, unknown> = {};
      for (const sub of opt.subOptions) {
        table[sub.key] = sub.default;
      }
      out[opt.key] = table;
    } else if (opt.type === 'table') {
      out[opt.key] = { ...(opt.default as object) };
    } else {
      out[opt.key] = opt.default;
    }
  }
  // Derive homepage from searchEngine when "auto" (the default).
  const browser = out.browser as RawBrowserConfig;
  if (browser.homepage === 'auto') {
    browser.homepage = baseUrlFromSearchEngine(browser.searchEngine as string);
  }
  return out as RawConfig;
}

function tomlValue(value: unknown): string {
  if (typeof value === 'string') {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return String(value);
}

/** A TOML key: bare when it is a plain identifier, quoted otherwise. */
function tomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlValue(value);
}

/**
 * Serialize a config to TOML. Scalars first (a [table] header ends the top
 * level in TOML), then every table-type option as its own section.
 */
export function generateToml(config: RawConfig = defaultConfig()): string {
  const lines: string[] = [
    '# awrit configuration.',
    '# Reloads on change; a broken edit keeps the last good config and logs the reason.',
    '',
  ];

  for (const opt of CONFIG_OPTIONS) {
    if (opt.type !== 'table') continue;
    const table = (config[opt.key] as Record<string, unknown>) ?? (opt.default as Record<string, unknown>);
    lines.push(`# ${opt.doc}`);
    if (opt.subOptions) {
      lines.push(`[${opt.key}]`);
      for (const sub of opt.subOptions) {
        const value = table[sub.key] ?? sub.default;
        lines.push(`# ${sub.doc}`);
        lines.push(`${sub.key} = ${tomlValue(value)}`);
      }
      lines.push('');
    } else if (opt.key === 'keybindings') {
      lines.push(`# Actions: ${Object.keys(actions).join(', ')}`);
      lines.push('[keybindings]');
      // Group by action: a plain TOML table cannot hold the same key twice, and
      // one action can bind several keys (the mouse buttons share back/forward).
      const byAction = new Map<string, string[]>();
      for (const [key, value] of Object.entries(table)) {
        if (typeof value === 'string') {
          const bindings = byAction.get(value) ?? [];
          bindings.push(key);
          byAction.set(value, bindings);
        }
      }
      for (const [action, bindings] of byAction) {
        const keys = bindings.map((k) => tomlValue(k));
        const value = bindings.length === 1 ? keys[0] : `[${keys.join(', ')}]`;
        lines.push(`${tomlKey(action)} = ${value}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

export interface NormalizedConfig {
  config: AwritConfig;
  unknownKeys: string[];
}

/**
 * Generated files write `forward = "<C-]>"` or `back = ["<C-[>", "<Mouse4>"]`
 * (action on the left, one or more keys); files from before that wrote
 * `<C-]> = "forward"`. A table whose every key is a registered action is
 * action-first — flip it to the internal keybinding -> action shape.
 */
function normalizeKeybindings(table: RawKeybindings): Record<string, string> {
  const entries: Array<[string, string | string[]]> = [];
  for (const [k, v] of Object.entries(table)) {
    if (typeof v === 'string' || Array.isArray(v)) entries.push([k, v]);
  }
  const actionFirst = entries.length > 0 && entries.every(([k]) => k in actions);
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (actionFirst) {
      for (const binding of Array.isArray(v) ? v : [v]) {
        out[binding] = k;
      }
    } else if (typeof v === 'string') {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Merge config layers from least to most specific (built-in defaults -> XDG ->
 * ./config.toml -> --config). A scalar set by a more specific layer wins;
 * keybindings merge per binding, so overriding one shortcut never unmaps the
 * rest. An explicitly empty keybindings table contributes nothing.
 * Tables with sub-options merge per key.
 */
export function mergeConfigs(raws: RawConfig[]): RawConfig {
  const out: Record<string, unknown> = {};
  const keys: Record<string, string> = {};

  for (const raw of raws) {
    for (const [key, value] of Object.entries(raw)) {
      if (value === undefined) continue;

      const opt = CONFIG_OPTIONS.find((o) => o.key === key);
      if (!opt) continue;

      if (opt.type === 'table' && opt.subOptions && typeof value === 'object') {
        // Merge table with sub-options per key
        const existing = (out[key] as Record<string, unknown>) ?? {};
        const merged = { ...existing, ...(value as Record<string, unknown>) };
        out[key] = merged;
      } else if (opt.key === 'keybindings') {
        // keybindings merge per binding
        Object.assign(keys, normalizeKeybindings(value as RawKeybindings));
      } else {
        // scalar: most specific wins
        out[key] = value;
      }
    }
  }

  if (Object.keys(keys).length > 0) out.keybindings = keys;
  return out as RawConfig;
}

/**
 * Validate a parsed config against CONFIG_OPTIONS and fill any missing option
 * from its default. Keys awrit does not know are reported, not rejected, so a
 * newer config still loads under an older build.
 */
export function normalizeConfig(raw: RawConfig): NormalizedConfig {
  const out: Record<string, unknown> = {};
  const unknownKeys: string[] = [];

  for (const opt of CONFIG_OPTIONS) {
    const value = raw[opt.key];
    if (value == null) {
      if (opt.type === 'table' && opt.subOptions) {
        const table: Record<string, unknown> = {};
        for (const sub of opt.subOptions) {
          table[sub.key] = sub.default;
        }
        out[opt.key] = table;
      } else if (opt.type === 'table') {
        out[opt.key] = { ...(opt.default as object) };
      } else {
        out[opt.key] = opt.default;
      }
      continue;
    }

    if (opt.type === 'table') {
      if (typeof value !== 'object') {
        throw new Error(`${opt.key} must be a table, got ${typeof value}`);
      }
      if (opt.subOptions) {
        const table: Record<string, unknown> = {};
        for (const sub of opt.subOptions) {
          const subValue = (value as Record<string, unknown>)[sub.key];
          if (subValue == null) {
            table[sub.key] = sub.default;
            continue;
          }
          if (typeof subValue !== sub.type) {
            throw new Error(`${opt.key}.${sub.key} must be a ${sub.type}, got ${typeof subValue}`);
          }
          table[sub.key] = subValue;
        }
        // Check for unknown keys in the table
        for (const k of Object.keys(value as Record<string, unknown>)) {
          if (!opt.subOptions.some((s) => s.key === k)) unknownKeys.push(`${opt.key}.${k}`);
        }
        out[opt.key] = table;
      } else if (opt.key === 'keybindings') {
        // Existing keybindings validation
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          const ok =
            typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
          if (!ok) {
            throw new Error(
              `${opt.key}.${k} must be a string (a key sequence) or an array of them, got ${typeof v}`,
            );
          }
        }
        out[opt.key] = normalizeKeybindings(value as RawKeybindings);
      }
      continue;
    }

    if (typeof value !== opt.type) {
      throw new Error(`${opt.key} must be a ${opt.type}, got ${typeof value}`);
    }
    out[opt.key] = value;
  }

  for (const key of Object.keys(raw)) {
    if (!CONFIG_OPTIONS.some((o) => o.key === key)) unknownKeys.push(key);
  }

  // Derive homepage from searchEngine when "auto" (the default).
  const browser = out.browser as RawBrowserConfig;
  if (browser.homepage === 'auto') {
    browser.homepage = baseUrlFromSearchEngine(browser.searchEngine as string);
  }

  // `out` has an entry for every declared option — that is the AwritConfig
  // contract, but a Record with computed keys can't express it structurally.
  return { config: out as unknown as AwritConfig, unknownKeys };
}

/** Get XDG config home directory. */
export function getXdgConfigHome(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return xdg;
  return join(homedir(), '.config');
}

/** Directory for runtime state (the resolved config JSON, the log). */
export function getStateDir(): string {
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg) return join(xdg, CONFIG_DIR);
  return join(homedir(), '.local', 'state', CONFIG_DIR);
}

/** Where the runner writes the normalized config Electron reads. */
export function defaultResolvedConfigJsonPath(): string {
  return join(getStateDir(), CONFIG_FILE_NAME);
}
