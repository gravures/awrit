import { app, dialog, ipcMain } from 'electron';
import {
  termEnableFeatures,
  listenForInput,
  type TermEvent,
  termDisableFeatures,
  getWindowSize,
} from './native';
import * as out from './tty/output';
import { handleInput } from './inputHandler';
import { createWindowWithToolbar, focusedView } from './windows';
import { console_ } from './console';
import { options } from './args';
import { features } from './features';
import { clearPlacements, gfxAck } from './tty/kittyGraphics';
import { loadKeyBindings } from './keybindings';
import { actions } from './actions';
import { getForcedTmuxMouseCoordinateMode } from './tty/mouseCoordinates';
import fs from 'node:fs';
import path from 'node:path';
import { closeTmuxRenderer, setSharedTexture } from './paint';
import { setRasterScale } from './raster';
import { getAllowPassthrough, getTmuxVersion, isTmuxSession, mouseEnabled } from './tty/tmux';

// ps/pane_current_command read /proc/self/comm, which the kernel resets from
// the binary name on exec — argv[0] alone is not enough. Set after spawn.
process.title = 'awrit';
try {
  fs.writeFileSync('/proc/self/comm', 'awrit');
} catch {
  // non-Linux or permission — process.title still covers ps on other platforms
}

import {
  RESOLVED_CONFIG_ENV,
  defaultResolvedConfigJsonPath,
  normalizeConfig,
  type AwritConfig,
} from './config';

let homepage = 'https://github.com/chase/awrit';

// The runner resolves, parses and normalizes the TOML config and writes it as
// JSON (09-04 option-a); this side only reads that JSON, applies it and
// re-reads it when it changes.
function loadConfig(config: AwritConfig) {
  homepage = config.homepage;
  setRasterScale(config.rasterScale);
  setSharedTexture(config.sharedTexture);
  features.searchEngine = config.searchEngine;
  const { unknown } = loadKeyBindings({ keybindings: config.keybindings }, actions);
  for (const name of unknown) {
    console_.error(`Unknown keybinding action: "${name}"`);
  }
}

function readResolvedConfig(): AwritConfig | null {
  const p = process.env[RESOLVED_CONFIG_ENV] ?? defaultResolvedConfigJsonPath();
  try {
    const txt = fs.readFileSync(p, 'utf8');
    return normalizeConfig(JSON.parse(txt)).config;
  } catch (e) {
    console_.error('Error reading resolved config:', e);
    return null;
  }
}

// A missing/broken resolved config falls back to the declared defaults, so a
// first start without JSON still has a working homepage and keybindings.
let lastGoodConfig: AwritConfig = readResolvedConfig() ?? normalizeConfig({}).config;
loadConfig(lastGoodConfig);

const resolvedConfigPath = process.env[RESOLVED_CONFIG_ENV] ?? defaultResolvedConfigJsonPath();

let configReloadTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleConfigReload() {
  if (configReloadTimer) clearTimeout(configReloadTimer);
  configReloadTimer = setTimeout(() => {
    configReloadTimer = undefined;
    reloadConfig();
  }, 300);
}

function reloadConfig() {
  const cfg = readResolvedConfig();
  if (!cfg) return; // read/parse failed (reason already reported) — keep last good
  try {
    loadConfig(cfg);
    lastGoodConfig = cfg;
    // Send updated searchEngine to toolbar
    const window = focusedView.current;
    if (window?.toolbar?.webContents) {
      window.toolbar.webContents.send('toolbar:search-engine-changed', cfg.searchEngine);
    }
  } catch (e) {
    console_.error('Error applying config, keeping last good:', e);
    loadConfig(lastGoodConfig);
  }
}

// Watch the resolved JSON (written by runner). Also watch the env path if it changes.
try {
  const dir = path.dirname(resolvedConfigPath);
  fs.watch(dir, (_event, filename) => {
    if (filename && path.basename(resolvedConfigPath) === filename) {
      scheduleConfigReload();
    }
  });
} catch (e) {
  console_.error('fs.watch unavailable, falling back to fs.watchFile:', e);
  try {
    fs.watchFile(resolvedConfigPath, { interval: 1000 }, (curr, prev) => {
      if (curr.mtime <= prev.mtime) return;
      reloadConfig();
    });
  } catch {}
}

// Don't show a dialog box on uncaught errors
dialog.showErrorBox = (title, content) => {
  console_.error(title, content);
};

const INITIAL_URL = options.url || homepage;

let quitListening = () => {};

const cleanup = (signum = 1, reason?: string) => {
  quitListening();
  closeTmuxRenderer();
  clearPlacements();
  out.cleanup();
  if (features.current) {
    termDisableFeatures(features.current);
  }
  if (reason) {
    console_.log(reason);
  }
  process.exit(signum);
};

function inputHandler(evt: TermEvent) {
  if (
    evt.eventType === 'key' &&
    evt.keyEvent.code === 'd' &&
    evt.keyEvent.modifiers.includes('ctrl')
  ) {
    cleanup(0);
  }

  // Graphics protocol events now come through graphics events
  if (evt.eventType === 'graphics') {
    const g = evt.graphics;
    if (g) {
      // Resolve the send→display round trip, which is what tells us whether
      // the terminal is keeping pace or falling behind.
      if (g.status === 'OK') gfxAck();
      if (options['debug-paint']) console_.error('Graphics protocol: ', g);
    }
  }

  handleInput(evt);
}

function setup() {
  const cleanup_ = () => cleanup();
  process.on('SIGINT', () => cleanup(0));
  process.on('SIGTERM', cleanup_);
  process.on('SIGABRT', cleanup_);

  out.setup();
  features.current = termEnableFeatures();
  const { keyboard, images } = features.current;
  const tmux = isTmuxSession();
  if (tmux) {
    try {
      const tmuxVersion = getTmuxVersion();
      if (getAllowPassthrough() !== 'all') {
        console_.error(
          'This pane does not allow hidden passthrough cleanup. Launch Awrit through its `awrit` wrapper.',
        );
      }
      if (!mouseEnabled()) {
        console_.error('tmux mouse mode is disabled. Set `set -g mouse on` for pointer input.');
      }
      const forcedMouseCoords = process.env.AWRIT_TMUX_MOUSE_COORDS;
      if (forcedMouseCoords && !getForcedTmuxMouseCoordinateMode(forcedMouseCoords)) {
        console_.error(
          `Invalid AWRIT_TMUX_MOUSE_COORDS="${forcedMouseCoords}". Expected "cell" or "pixel".`,
        );
      }
      if (
        tmuxVersion &&
        (tmuxVersion.major < 3 || (tmuxVersion.major === 3 && tmuxVersion.minor < 4))
      ) {
        console_.error(
          `tmux ${tmuxVersion.major}.${tmuxVersion.minor} detected. tmux >= 3.4 is recommended for reliable passthrough.`,
        );
      }
    } catch (error) {
      console_.error('Unable to read tmux capabilities:', error);
    }
    if (!keyboard) {
      console_.error('Extended keyboard support unavailable in tmux; continuing without it.');
    }
    if (!images) {
      console_.error('Kitty graphics detection failed in tmux; continuing with tmux placeholder mode.');
    }
  } else {
    if (!keyboard) {
      cleanup(1, 'Extended keyboard support is required');
    }
    if (!images) {
      cleanup(1, 'Basic Kitty graphics protocol support is required');
    }
  }

  quitListening = listenForInput(inputHandler, 200);

  out.clearScreen();
  out.placeCursor({ x: 0, y: 0 });
}

setup();

// Disable Electron's stdout logging
app.commandLine.appendSwitch('log-level', '0');
app.commandLine.appendSwitch('disable-logging');
// Disable Chrome DevTools logging
app.commandLine.appendSwitch('silent-debugger-extension-api');

// Prevent sysctlbyname crash: https://github.com/electron/electron/issues/45653#issuecomment-2663510200
app.commandLine.appendSwitch('disable-features', 'UseBrowserCalculatedOrigin');

// Disable Blink's compositor smooth scrolling.
//
// `buildWheelEvent` sets `hasPreciseScrollingDeltas: true`, which only selects
// pixel units over line units -- it does NOT stop the compositor animator. The
// 06-06 note claiming otherwise was wrong, so the animator has been running the
// whole time. It queues wheel deltas and animates toward them, which is what
// produces the lag that accumulates, the jump-then-ease, and the direction
// reversal when queued deltas from a previous gesture are animated after the
// direction has changed. The animator also keeps requesting frames, so each
// animation step re-sends the full tmux placeholder grid (see
// buildTmuxPlaceholderLines) -- that is where most of the per-frame bytes go.
app.commandLine.appendSwitch('disable-smooth-scrolling');

app.whenReady().then(async () => {
  const window = await createWindowWithToolbar(getWindowSize(), INITIAL_URL);

  ipcMain.handle('findInPage', (_, text: string, opts) => {
    window.content.webContents.findInPage(text, opts);
  });

  ipcMain.handle('stopFindInPage', () => {
    window.content.webContents.stopFindInPage('clearSelection');
    window.toolbar.blurWebView();
    window.content.focusOnWebView();
    window.focusedContent = window.content.webContents;
  });

  // Toolbar search-engine IPC (07-02)
  ipcMain.handle('toolbar:get-search-engine', () => features.searchEngine);
});
