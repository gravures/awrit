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
  [key: string]: string | undefined;
}

export interface RawConfig {
  homepage?: string;
  rasterScale?: number;
  sharedTexture?: boolean;
  keybindings?: RawKeybindings;
}

/** A fully resolved config: every declared option is present. */
export interface AwritConfig {
  homepage: string;
  rasterScale: number;
  sharedTexture: boolean;
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
    key: 'keybindings',
    type: 'table',
    default: DEFAULT_KEYBINDINGS,
    doc: 'Key sequence -> action name. Pressing a key runs the named action.',
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
    for (const [key, value] of Object.entries(table)) {
      if (typeof value === 'string') lines.push(`${tomlValue(key)} = ${tomlValue(value)}`);
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
        if (typeof v !== 'string') {
          throw new Error(`${opt.key}.${k} must be a string (an action name), got ${typeof v}`);
        }
      }
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
