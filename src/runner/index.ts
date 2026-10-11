import fs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { $, type Subprocess } from 'bun';
import { options, possibleOptions } from '../args';
import { RESOLVED_CONFIG_ENV } from '../config';
import { getDisplayScale } from '../dpi';
import { colorsToTailwind, queryColors } from './kittyColors';
import { beginLaunch, fatal, logDiagnostic, resolveRoot } from './launch';
import { loadConfig } from './config';

const { stdout } = process;

// Two live layouts (09-03): the compiled release binary derives its install root
// from process.execPath, the dev checkout from the source tree. AWRIT_ROOT is gone.
const { root, isRelease } = resolveRoot();

// Electron is not bundled in the release: the tarball ships electron/path.txt
// beside the runner. Dev still resolves through the electron npm package.
function resolveElectronPath(): string {
  const override = process.env.AWRIT_ELECTRON;
  if (override) return override;
  if (isRelease) {
    const pathTxt = join(root, 'electron', 'path.txt');
    if (!fs.existsSync(pathTxt)) {
      throw new Error(`awrit: electron runtime not found at ${pathTxt}`);
    }
    return join(root, 'electron', 'dist', fs.readFileSync(pathTxt, 'utf-8').trim());
  }
  // electron's package entry returns the absolute path to the executable
  return require('electron') as unknown as string;
}

// The Electron app entry differs by layout: the release tarball nests it under
// electron/app/ (beside the runtime), while the dev tree builds it into the
// same shape at dist/electron/app/ so dist/ stays a single shippable tree.
function resolveAppEntry(): string {
  return isRelease ? join(root, 'electron/app/index.js') : join(root, 'dist/electron/app/index.js');
}

// There is no shell wrapper to rename us anymore (09-03): the process names
// itself so ps/comm show `awrit` rather than the bun binary.
process.title = 'awrit';
try {
  fs.writeFileSync('/proc/self/comm', 'awrit');
} catch {
  // non-Linux — process.title still covers ps elsewhere
}

const RESET = '\x1b[0m';
const DIM_WHITE = '\x1b[0;2m';
const BOLD_GREEN = '\x1b[1;32m';
const BOLD_WHITE = '\x1b[1m';

export function showHelp() {
  stdout.write(RESET);
  stdout.write(`Usage: ${BOLD_GREEN}awrit${RESET} ${DIM_WHITE}[options] [url]${RESET}\n\n`);
  stdout.write('Options:\n');
  for (const [key, value] of Object.entries(possibleOptions)) {
    if ('arg' in value) {
      stdout.write(`  ${DIM_WHITE}[${key}]${RESET}: ${value.description}\n`);
    } else {
      stdout.write(
        `  ${BOLD_WHITE}-${value.short}${RESET}, ${BOLD_WHITE}--${key}${RESET}: ${value.description}\n`,
      );
    }
  }
}

if (options.help) {
  showHelp();
  process.exit(0);
}

if (options.version) {
  const version = isRelease
    ? (await Bun.file(join(root, 'electron/app/version')).text()).trim()
    : (await $`git rev-parse --short HEAD`.quiet()).text().trim();
  if (stdout.isTTY) {
    stdout.write(`${BOLD_GREEN}awrit${RESET} ${version}\n`);
  } else {
    stdout.write(version);
  }
  process.exit(0);
}

// dist/ is the single shippable tree: the dev flow (mise run awrit) and the
// release pipeline share the layout, so this branch writes the app into
// dist/electron/app/ and leaves the runtime/metadata/runner to the release
// pipeline. The native addon must sit beside app/ for the externalized
// `../awrit-native-rs` require; dev points it at the source tree (bundle_electron
// wipes dist/ first, so the symlink never leaks into a release tarball).
if (!isRelease) {
  const appDir = join(root, 'dist/electron/app');
  await $`mkdir -p ${appDir}`.nothrow().quiet();

  const addonLink = join(root, 'dist/electron/awrit-native-rs');
  if (!fs.existsSync(addonLink)) {
    // existsSync follows the link: a dangling link reports false but still
    // occupies the name, and symlinkSync would then throw EEXIST.
    if (fs.lstatSync(addonLink, { throwIfNoEntry: false })?.isSymbolicLink()) {
      fs.unlinkSync(addonLink);
    }
    fs.symlinkSync(join(root, 'awrit-native-rs'), addonLink, 'dir');
  }

  {
    const { success } = await Bun.build({
      entrypoints: [join(root, 'src/index.ts'), join(root, 'src/preload.js')],
      outdir: appDir,
      root: join(root, 'src'),
      target: 'node',
      format: 'cjs',
      sourcemap: 'inline',
      // '*/awrit-native-rs' keeps src/native.ts's re-export external, so the
      // bundle requires it at runtime instead of baking a build-machine path.
      external: ['electron', '*.node', '*/awrit-native-rs'],
    });

    if (!success) {
      fatal('Failed to build');
    }
  }

  const version = require(join(root, 'package.json')).version;
  const distVersion = Bun.file(join(appDir, 'version'));

  if (!(await distVersion.exists()) || (await distVersion.text()) !== version || options.rebuild) {
    logDiagnostic('building toolbar');
    let didQueryColors = false;
    const isTTY = process.stdout.isTTY && process.stdin.isTTY;
    let warned = false; // only log once, and suppress when not a TTY
    for (let tries = 0; !didQueryColors && tries < 3; tries++) {
      try {
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        const colors = await queryColors();
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        if (!colors) {
          if (isTTY && !warned) {
            logDiagnostic('Failed to query terminal colors');
            warned = true;
          }
        } else {
          await Bun.write(join(appDir, 'kitty.css'), colorsToTailwind(colors));
          didQueryColors = true;
        }
      } catch {
        if (isTTY && !warned) {
          logDiagnostic('Failed to query terminal colors');
          warned = true;
        }
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
      }
    }
    // TODO: figure out why this isn't reliable for some users
    if (!didQueryColors) {
      // empty placeholder required for building in case of failure
      await Bun.write(join(appDir, 'kitty.css'), '');
    }

    try {
      await $`bun ${join(root, 'node_modules/vite/bin/vite.js')} build`.cwd(
        join(root, 'src/runner'),
      );
    } catch (e) {
      const e_ = e as { stderr?: { toString(): string } };
      fatal(e_.stderr?.toString() ?? String(e));
    }

    distVersion.write(version);
  }
}

const children: [string, Subprocess][] = [];
const isDev = options.dev;

// Vite is a dev-only dependency and is not shipped in the release tarball, so the
// dev server must not be imported at startup: static import would require `vite`
// even when not in dev (09-02 Task 2).
let stopDevServer: (() => void) | undefined;
if (isDev) {
  const { server } = await import('./devServer');
  await server.listen();
  stopDevServer = () => server.close();
}

// Load and resolve config (09-04, option-a). The runner parses TOML and writes
// normalized JSON for Electron; Electron reads via AWRIT_CONFIG_JSON.
let configJsonPath: string;
let configPath: string;
let lastSeenConfigMtime = 0;
try {
  const res = loadConfig({
    cwd: process.cwd(),
    argvConfig: options.config,
  });
  configJsonPath = res.jsonPath;
  configPath = res.configPath;
  lastSeenConfigMtime = fs.statSync(configPath).mtimeMs;
  for (const key of res.unknownKeys) {
    logDiagnostic(`config: ignoring unknown option "${key}" in ${res.configPath}`);
  }
} catch (e) {
  fatal((e as Error).message);
}

// Hot-reload: watch the config DIRECTORY, not the file — editors that save via
// rename-replace (and our own tmp+rename of the JSON) leave a file-level watch
// pointing at a deleted inode. The mtime check keeps unrelated changes in the
// same directory from being parsed, and an invalid file is attempted once per
// edit: the last good config stays active and the reason is logged.
try {
  const configDir = dirname(configPath);
  const configName = basename(configPath);
  fs.watch(configDir, (_event, filename) => {
    if (filename && filename !== configName) return;
    let mtime: number;
    try {
      mtime = fs.statSync(configPath).mtimeMs;
    } catch {
      return; // mid-save rename; the next event sees the new file
    }
    if (mtime === lastSeenConfigMtime) return;
    lastSeenConfigMtime = mtime;
    try {
      const res = loadConfig({
        cwd: process.cwd(),
        argvConfig: options.config,
      });
      configJsonPath = res.jsonPath;
      logDiagnostic(`reloaded config from ${configPath}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logDiagnostic(`config reload failed, keeping last good: ${msg}`);
    }
  });
} catch (e) {
  logDiagnostic(`fs.watch unavailable for config: ${e instanceof Error ? e.message : String(e)}`);
}

// One entry point (09-03): scope tmux passthrough before Electron starts, then
// arrange the restore. Fails closed if tmux cannot be scoped.
try {
  beginLaunch();
} catch (e) {
  fatal((e as Error).message);
}

let electronPath: string;
try {
  electronPath = resolveElectronPath();
} catch (e) {
  fatal((e as Error).message);
}

const args = [electronPath, resolveAppEntry(), '--high-dpi-support=1'];
// Pass resolved config JSON path to Electron
process.env[RESOLVED_CONFIG_ENV] = configJsonPath;

// Kitty respects the virtual scale size, while other terminals respect the physical scale size, which confuses things
const forcedDisplayScale = getDisplayScale();
if (forcedDisplayScale) {
  args.push(`--force-device-scale-factor=${forcedDisplayScale}`);
}
args.push(...process.argv.slice(2));

children.push([
  'electron',
  Bun.spawn(args, {
    stdio: ['inherit', 'inherit', 'inherit'],
    serialization: 'json',
    ipc(_message, _subprocess) {
      // TODO: do cool stuff with IPC between bun and the electron process
    },
    windowsHide: true,
    onExit() {
      destroyAllSubprocesses();
    },
  }),
]);

function destroySubprocess(name: string, child: Subprocess) {
  if (child.killed) return;
  logDiagnostic(`destroying ${name}`);
  child.kill();
}

function destroyAllSubprocesses() {
  for (const [name, child] of children) {
    destroySubprocess(name, child);
  }
  if (isDev) {
    logDiagnostic('stopping dev server');
    stopDevServer?.();
  }
  process.exit(0);
}

process.on('SIGINT', destroyAllSubprocesses);
process.on('SIGTERM', destroyAllSubprocesses);
