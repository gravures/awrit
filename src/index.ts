import { app, dialog, ipcMain } from 'electron';
import {
  termEnableFeatures,
  listenForInput,
  type TermEvent,
  termDisableFeatures,
  getWindowSize,
} from 'awrit-native-rs';
import * as out from './tty/output';
import { handleInput } from './inputHandler';
import { createWindowWithToolbar } from './windows';
import { console_ } from './console';
import { options } from './args';
import { features } from './features';
import { clearPlacements } from './tty/kittyGraphics';
import { loadKeyBindings } from './keybindings';
import { getForcedTmuxMouseCoordinateMode } from './tty/mouseCoordinates';
import fs from 'node:fs';
import path from 'node:path';
import { closeTmuxRenderer } from './paint';
import { getAllowPassthrough, getTmuxVersion, isTmuxSession, mouseEnabled } from './tty/tmux';

// ps/pane_current_command read /proc/self/comm, which the kernel resets from
// the binary name on exec — argv[0] alone is not enough. Set after spawn.
process.title = 'awrit';
try {
  fs.writeFileSync('/proc/self/comm', 'awrit');
} catch {
  // non-Linux or permission — process.title still covers ps on other platforms
}

let homepage = 'https://github.com/chase/awrit';

function loadConfig(config: typeof import('../config.js')) {
  if (config.homepage) homepage = config.homepage;
  if (config.keybindings) {
    if (process.platform === 'darwin') {
      Object.assign(config.keybindings, config.keybindings.mac);
      config.keybindings.linux = undefined;
    } else {
      Object.assign(config.keybindings, config.keybindings.linux);
      config.keybindings.mac = undefined;
    }
    loadKeyBindings(config);
  }
}

const CONFIG_PATH = '../config.js';
const CONFIG_PATH_RESOLVED = path.resolve(__dirname, CONFIG_PATH);
loadConfig(require(CONFIG_PATH_RESOLVED));

function reloadConfig() {
  const oldConfig = require(CONFIG_PATH_RESOLVED);
  require.cache[CONFIG_PATH_RESOLVED] = undefined;

  try {
    const newConfig = require(CONFIG_PATH_RESOLVED);
    loadConfig(newConfig);
  } catch (e) {
    console_.error('Error loading config:', e);
    // Restore old config if new one fails
    try {
      loadConfig(oldConfig);
    } catch (e) {
      console_.error('Error restoring old config:', e);
    }
  }
}

let configReloadTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleConfigReload() {
  if (configReloadTimer) clearTimeout(configReloadTimer);
  configReloadTimer = setTimeout(() => {
    configReloadTimer = undefined;
    reloadConfig();
  }, 300);
}

// fs.watch is event-driven; watchFile polls every 1000ms by comparison.
try {
  // Watch the directory, not the file: editors that save via rename-replace
  // leave a file-level inotify watch pointing at the deleted inode.
  const configName = path.basename(CONFIG_PATH_RESOLVED);
  fs.watch(path.dirname(CONFIG_PATH_RESOLVED), (_event, filename) => {
    if (filename === configName) scheduleConfigReload();
  });
} catch (e) {
  console_.error('fs.watch unavailable, falling back to fs.watchFile:', e);
  fs.watchFile(CONFIG_PATH_RESOLVED, { interval: 1000 }, (curr, prev) => {
    if (curr.mtime <= prev.mtime) return;
    reloadConfig();
  });
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
  if (options['debug-paint'] && evt.eventType === 'graphics') {
    console_.error('Graphics protocol: ', evt.graphics);
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
});
