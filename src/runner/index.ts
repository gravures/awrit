import fs from 'node:fs';
import { join } from 'node:path';
import { $, type Subprocess } from 'bun';
import { options, possibleOptions } from '../args';
import { getDisplayScale } from '../dpi';
import { colorsToTailwind, queryColors } from './kittyColors';
import { beginLaunch, fatal, logDiagnostic, resolveRoot } from './launch';

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
    ? (await Bun.file(join(root, 'dist/version')).text()).trim()
    : (await $`git rev-parse --short HEAD`.quiet()).text().trim();
  if (stdout.isTTY) {
    stdout.write(`${BOLD_GREEN}awrit${RESET} ${version}\n`);
  } else {
    stdout.write(version);
  }
  process.exit(0);
}

// Release tarballs ship a pre-built dist/ (Task 1); only the dev tree builds it.
if (!isRelease) {
  await $`mkdir -p ${root}/dist`.nothrow().quiet();

  {
    const { success } = await Bun.build({
      entrypoints: [join(root, 'src/index.ts'), join(root, 'src/preload.js')],
      outdir: join(root, 'dist'),
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
  const distVersion = Bun.file(join(root, 'dist/version'));

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
          await Bun.write(join(root, 'dist/kitty.css'), colorsToTailwind(colors));
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
      await Bun.write(join(root, 'dist/kitty.css'), '');
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

const args = [electronPath, join(root, 'dist/index.js'), '--high-dpi-support=1'];

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
