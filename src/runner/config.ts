import fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  CONFIG_TOML_NAME,
  defaultResolvedConfigJsonPath,
  getXdgConfigHome,
  generateToml,
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
 * Resolve the config file with precedence:
 *   --config <path> → ./config.toml → $XDG_CONFIG_HOME/awrit/config.toml
 * An explicit --config that does not exist is an error, never a silent skip.
 * When nothing is found, the default file is written to the XDG location.
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

  const candidates = [join(opts.cwd, CONFIG_TOML_NAME), xdgPath];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // unreadable candidate — treat as absent and keep looking
    }
  }

  // Nothing found: write the default into the XDG location. Best effort —
  // loadConfig re-checks and reports if this failed (read-only home, ...).
  try {
    fs.mkdirSync(dirname(xdgPath), { recursive: true });
    fs.writeFileSync(xdgPath, generateToml());
  } catch {
    // fall through to the existence check in loadConfig
  }

  return xdgPath;
}

export interface LoadConfigResult {
  config: AwritConfig;
  configPath: string;
  jsonPath: string;
  unknownKeys: string[];
}

/**
 * Resolve, parse and validate the config, then write the normalized JSON that
 * Electron reads (09-04 option-a: TOML is parsed here, under Bun, because the
 * Electron bundle has no TOML parser).
 */
export function loadConfig(opts: ResolveOptions & { stateDir?: string }): LoadConfigResult {
  const configPath = resolveConfigPath(opts);

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `awrit: config file not found at ${configPath} — it could not be created there, ` +
        'create it yourself or pass --config <path>',
    );
  }

  const tomlText = fs.readFileSync(configPath, 'utf8');
  let raw: RawConfig;
  try {
    raw = Bun.TOML.parse(tomlText) as RawConfig;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`awrit: failed to parse config TOML in ${configPath}: ${msg}`);
  }

  let normalized: NormalizedConfig;
  try {
    normalized = normalizeConfig(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`awrit: invalid config in ${configPath}: ${msg}`);
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

  return { ...normalized, configPath, jsonPath };
}
