import fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  CONFIG_TOML_NAME,
  defaultConfig,
  defaultResolvedConfigJsonPath,
  getXdgConfigHome,
  generateToml,
  mergeConfigs,
  normalizeConfig,
  type AwritConfig,
  type NormalizedConfig,
  type RawConfig,
} from '../config';
import { logDiagnostic } from './launch';

export interface ResolveOptions {
  cwd: string;
  argvConfig?: string;
  envXdgConfigHome?: string;
}

/**
 * Resolve the primary config file with precedence:
 *   --config <path> → ./config.toml → $XDG_CONFIG_HOME/awrit/config.toml
 * An explicit --config that does not exist is an error, never a silent skip.
 * The XDG file is regenerated whenever it is missing, so there is always an
 * editable default even when a cwd config exists.
 * This picks the single most-specific file; loadConfig additionally merges
 * every existing layer below it (defaults -> XDG -> cwd -> --config).
 */
export function resolveConfigPath(opts: ResolveOptions): string {
  const xdg = opts.envXdgConfigHome ?? getXdgConfigHome();
  const xdgPath = join(xdg, 'awrit', CONFIG_TOML_NAME);

  if (opts.argvConfig) {
    const explicit = resolve(opts.cwd, opts.argvConfig);
    if (!fs.existsSync(explicit)) {
      throw new Error(`awrit: --config file not found at ${explicit}`);
    }
    return explicit;
  }

  const cwdPath = join(opts.cwd, CONFIG_TOML_NAME);
  const cwdExists = pathExists(cwdPath);

  if (!pathExists(xdgPath)) {
    // The XDG file is the user's editable copy: regenerate it whenever it is
    // missing, even when a cwd config exists. Best effort — loadConfig
    // re-checks and reports if this failed (read-only home, ...).
    try {
      fs.mkdirSync(dirname(xdgPath), { recursive: true });
      fs.writeFileSync(xdgPath, generateToml());
    } catch {
      // fall through to the existence check in loadConfig
    }
  }

  return cwdExists ? cwdPath : xdgPath;
}

function pathExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false; // unreadable candidate — treat as absent and keep looking
  }
}

export interface LoadConfigResult {
  config: AwritConfig;
  configPath: string;
  jsonPath: string;
  unknownKeys: string[];
  /** Every config file that exists and was merged in, least to most specific. */
  sources: string[];
}

/**
 * Resolve, parse and merge every existing config layer, then write the
 * normalized JSON that Electron reads (09-04 option-a: TOML is parsed here,
 * under Bun, because the Electron bundle has no TOML parser).
 *
 * Layers merge built-in defaults -> XDG -> ./config.toml -> --config, so a
 * setting in the cwd file always wins over the XDG one and never has to repeat
 * the whole file; keybindings merge per binding.
 */
export function loadConfig(opts: ResolveOptions & { stateDir?: string }): LoadConfigResult {
  // resolveConfigPath validates --config and regenerates the XDG default when
  // it is missing.
  const configPath = resolveConfigPath(opts);

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `awrit: config file not found at ${configPath} — it could not be created there, ` +
        'create it yourself or pass --config <path>',
    );
  }

  const xdg = opts.envXdgConfigHome ?? getXdgConfigHome();

  const layers: RawConfig[] = [defaultConfig()];
  const sources: string[] = [];
  const addLayer = (path: string) => {
    if (!fs.existsSync(path)) return;
    let raw: RawConfig;
    try {
      raw = Bun.TOML.parse(fs.readFileSync(path, 'utf8')) as RawConfig;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`awrit: failed to parse config TOML in ${path}: ${msg}`);
    }
    layers.push(raw);
    sources.push(path);
  };

  // Least to most specific.
  addLayer(join(xdg, 'awrit', CONFIG_TOML_NAME));
  addLayer(join(opts.cwd, CONFIG_TOML_NAME));
  if (opts.argvConfig) addLayer(resolve(opts.cwd, opts.argvConfig));

  let normalized: NormalizedConfig;
  try {
    normalized = normalizeConfig(mergeConfigs(layers));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`awrit: invalid config: ${msg}`);
  }

  const jsonPath = opts.stateDir
    ? join(opts.stateDir, 'config.json')
    : defaultResolvedConfigJsonPath();

  // Write via rename so the reader never sees a half-written file.
  try {
    fs.mkdirSync(dirname(jsonPath), { recursive: true });
    const tmpPath = `${jsonPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(normalized.config));
    fs.renameSync(tmpPath, jsonPath);
  } catch (e) {
    logDiagnostic(
      `failed to write resolved config JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return { ...normalized, configPath, jsonPath, sources };
}
