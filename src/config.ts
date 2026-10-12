import { homedir } from 'node:os';
import { join } from 'node:path';
import { actions } from './actions';

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

export interface RawConfig {
  homepage?: string;
  rasterScale?: number;
  sharedTexture?: boolean;
  searchEngine?: string;
  barTheme?: string;
  keybindings?: RawKeybindings;
}

/** A fully resolved config: every declared option is present. */
export interface AwritConfig {
  homepage: string;
  rasterScale: number;
  sharedTexture: boolean;
  searchEngine: string;
  barTheme: string;
  keybindings: Record<string, string>;
}

export type ConfigOptionType = 'string' | 'number' | 'boolean' | 'table';

export interface ConfigOption {
  key: keyof RawConfig;
  type: ConfigOptionType;
  default: unknown;
  doc: string;
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
    key: 'homepage',
    type: 'string',
    default: 'https://github.com/chase/awrit',
    doc: 'Page shown when no URL is given.',
  },
  {
    key: 'rasterScale',
    type: 'number',
    default: 2,
    doc:
      'Pane pixels divided by this is the bitmap Electron renders; the terminal stretches it ' +
      'back over the same cells. 2 = a quarter of the pixels, upscaled 2x (larger text, softer ' +
      'edges). 1 = 1:1 with the pane. Any positive number works.',
  },
  {
    key: 'sharedTexture',
    type: 'boolean',
    default: true,
    doc:
      'GPU shared-texture paint path for the fallback renderer (Ghostty outside tmux). Removes ' +
      'the CPU pixel read; gateable for comparison.',
  },
  {
    key: 'searchEngine',
    type: 'string',
    default: 'https://duckduckgo.com/?q=',
    doc: 'Search engine URL template. Use {q} for the query (URL-encoded).',
  },
  {
    key: 'barTheme',
    type: 'string',
    default: 'reverse',
    doc:
      'Row-0 bar colour preset: reverse, none, dark, light, accent. An unknown value falls ' +
      'back to reverse (the default look).',
  },
  {
    key: 'keybindings',
    type: 'table',
    default: DEFAULT_KEYBINDINGS,
    doc: 'Action name -> key sequence (or a list of keys). Pressing a key runs the named action.',
  },
];

/** The default config, built from CONFIG_OPTIONS — the source of the generated file. */
export function defaultConfig(): RawConfig {
  const out: Record<string, unknown> = {};
  for (const opt of CONFIG_OPTIONS) {
    out[opt.key] = opt.type === 'table' ? { ...(opt.default as object) } : opt.default;
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
    if (opt.type === 'table') continue;
    const value = (config[opt.key] as unknown) ?? opt.default;
    lines.push(`# ${opt.doc}`);
    lines.push(`${opt.key} = ${tomlValue(value)}`);
    lines.push('');
  }

  for (const opt of CONFIG_OPTIONS) {
    if (opt.type !== 'table') continue;
    const table = (config[opt.key] as RawKeybindings) ?? (opt.default as RawKeybindings);
    lines.push(`# ${opt.doc}`);
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
 */
export function mergeConfigs(raws: RawConfig[]): RawConfig {
  const out: Record<string, unknown> = {};
  const keys: Record<string, string> = {};
  for (const raw of raws) {
    for (const [key, value] of Object.entries(raw)) {
      if (key === 'keybindings' || value === undefined) continue;
      out[key] = value;
    }
    if (raw.keybindings !== undefined) Object.assign(keys, normalizeKeybindings(raw.keybindings));
  }
  out.keybindings = keys;
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
      out[opt.key] = opt.type === 'table' ? { ...(opt.default as object) } : opt.default;
      continue;
    }

    if (opt.type !== 'table' && typeof value !== opt.type) {
      throw new Error(`${opt.key} must be a ${opt.type}, got ${typeof value}`);
    }

    if (opt.type === 'table') {
      if (typeof value !== 'object') {
        throw new Error(`${opt.key} must be a table, got ${typeof value}`);
      }
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
      continue;
    }

    out[opt.key] = value;
  }

  for (const key of Object.keys(raw)) {
    if (!CONFIG_OPTIONS.some((o) => o.key === key)) unknownKeys.push(key);
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
