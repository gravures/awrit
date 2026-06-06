/** Homepage
 * The page that's displayed by default when no URL is provided
 **/
const homepage = 'https://github.com/chase/awrit';

/** Keybindings
 *
 * @typedef {import('./src/keybindings').KeyBindingAction} KeyBindingAction
 */

/**
 * Keybindings configuration object that maps Neovim-style key sequences to actions.
 *
 * Keybinding Format:
 * - Single key: "a", "b", "1", etc.
 * - Special keys: "<Tab>", "<Enter>", etc.
 * - Modifiers:
 *   - <C-...> for Ctrl (e.g., <C-s> for Ctrl+S)
 *   - <A-...> for Alt
 *   - <S-...> for Shift
 *   - <M-...> for Meta/Command
 * - Multiple modifiers can be combined: <C-A-s> for Ctrl+Alt+S
 * - Multi-key sequences: <C-w>l for Ctrl+W followed by L
 *
 * Behavior:
 * - Single-key bindings execute immediately
 * - Multi-key bindings match exact sequences
 * - Modifier order is handled consistently (e.g., <C-A-s> matches both Ctrl+Alt+S and Alt+Ctrl+S)
 * - When a key sequence is a prefix of another binding:
 *   - The system waits for a timeout period
 *   - If the longer sequence is completed within the timeout, it executes
 *   - If no further keys are pressed within the timeout, the shorter binding executes
 *
 * Example:
 * ```js
 * {
 *   // Executes after timeout if no longer sequence
 *   '<C-a>': () => console.log('Select all'),
 *   // Executes after timeout if no longer sequence
 *   '<C-w>': () => console.log('Close window'),
 *   // Executes immediately if pressed within timeout
 *   '<C-w>l': () => console.log('Next window'),
 * }
 * ```
 *
 * @type {Record<string, KeyBindingAction> & {
 *   mac?: Record<string, KeyBindingAction>,
 *   linux?: Record<string, KeyBindingAction>
 * }}
 */
const keybindings = {
  '<C-c>': () => {
    process.emit('SIGINT');
  },
  '<Mouse4>': back,
  '<Mouse5>': forward,
  mac: {
    '<M-a>': ({ view }) => {
      view.focusedContent.selectAll();
    },
    '<M-]>': forward,
    '<M-[>': back,
    '<M-f>': find,
    '<M-r>': refresh,

    // Zoom controls
    '<A-=>': zoomIn,
    '<A-minus>': zoomOut,
    '<C-0>': zoomReset,
  },
  linux: {
    '<C-]>': forward,
    '<C-[>': back,
    '<C-f>': find,
    '<C-r>': refresh,

    // Zoom controls
    '<A-=>': zoomIn,
    '<A-minus>': zoomOut,
    '<C-0>': zoomReset,
  },
};

/** @type {KeyBindingAction} */
function back({ view }) {
  view.back();
}

/** @type {KeyBindingAction} */
function forward({ view }) {
  view.forward();
}

/** @type {KeyBindingAction} */
function refresh({ view }) {
  view.refresh();
}

function find({ view }) {
  view.toolbar.webContents.send('toolbar:toggle-find');
  view.content.blurWebView();
  view.toolbar.focusOnWebView();
  view.focusedContent = view.toolbar.webContents;
}


const { exec } = require('child_process');
const electron = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Clipboard timeout to prevent blocking (execSync causes freeze if xclip hangs)
const CLIPBOARD_TIMEOUT_MS = 500;

/**
 * Write text to the terminal emulator's clipboard using OSC 52.
 */
function writeToTerminalClipboard(text) {
  const base64 = Buffer.from(text).toString('base64');
  process.stdout.write(`\x1b]52;c;${base64}\x07`);
}

/**
 * Execute a command with timeout protection
 * Returns stdout or null on failure/timeout
 */
function execWithTimeout(cmd, input, timeoutMs = CLIPBOARD_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = exec(cmd, { encoding: 'utf8', timeout: timeoutMs }, (err, stdout) => {
      if (err) {
        resolve(null);
      } else {
        resolve(stdout);
      }
    });
    if (input) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

/**
 * Write text to system clipboard
 * Uses Electron clipboard (fast, non-blocking) with native fallback
 */
async function writeToSystemClipboard(text) {
  try {
    // Primary: Electron clipboard (fast, non-blocking)
    electron.clipboard.writeText(text);

    // Secondary: Terminal OSC 52 (Robust over SSH/Wayland)
    writeToTerminalClipboard(text);
  } catch (e) {
    // Fallback: native clipboard with timeout
    try {
      if (process.platform === 'darwin') {
        await execWithTimeout('pbcopy', text);
      } else if (process.platform === 'linux') {
        if (process.env.WAYLAND_DISPLAY) {
          await execWithTimeout('wl-copy', text);
        } else {
          await execWithTimeout('xclip -selection clipboard', text);
        }
      } else if (process.platform === 'win32') {
        await execWithTimeout('clip', text);
      }
    } catch (nativeErr) {
      console.error('[Clipboard] Copy failed:', nativeErr.message);
    }
  }
}

/**
 * Read text from system clipboard
 * Uses Electron clipboard (fast, non-blocking) with native fallback
 */
async function readFromSystemClipboard() {
  try {
    // Primary: Electron clipboard (fast, non-blocking)
    const text = electron.clipboard.readText();
    if (text) return text;
  } catch (e) {
    // Continue to fallback
  }

  // Fallback: native clipboard with timeout
  try {
    let result;
    if (process.platform === 'darwin') {
      result = await execWithTimeout('pbpaste', null);
    } else if (process.platform === 'linux') {
      if (process.env.WAYLAND_DISPLAY) {
        result = await execWithTimeout('wl-paste', null);
      } else {
        result = await execWithTimeout('xclip -selection clipboard -o', null);
      }
    } else if (process.platform === 'win32') {
      result = await execWithTimeout('powershell Get-Clipboard', null);
    }
    return result || '';
  } catch (e) {
    console.error('[Clipboard] Paste failed:', e.message);
  }
  return '';
}

/** @type {KeyBindingAction} */
function copy({ view }) {
  if (!view) return;
  const target = view.focusedContent;

  // Use JavaScript extraction for more predictable behavior in offscreen mode
  const copyScript = `(() => {
    try {
      const activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
        return activeEl.value.substring(activeEl.selectionStart, activeEl.selectionEnd);
      }
      return window.getSelection().toString();
    } catch (e) {
      return '';
    }
  })()`;

  target
    .executeJavaScript(copyScript)
    .then((selectedText) => {
      if (selectedText && selectedText.length > 0) {
        // Write to both Electron and Terminal clipboards
        writeToSystemClipboard(selectedText).catch((err) => {
          console.error('[Clipboard] Write failed:', err);
        });
      }
    })
    .catch((err) => {
      console.error('[Action] Copy failed:', err);
    });
}

/** @type {KeyBindingAction} */
function paste({ view }) {
  if (!view) return;
  const target = view.focusedContent;

  readFromSystemClipboard().then((text) => {
    if (text && text.length > 0) {
      setImmediate(() => {
        target.insertText(text);
      });
    }
  }).catch((err) => {
    console.error('[Clipboard] Read failed:', err);
  });
}

/**
 * Diagnostic tool to check if clipboard writing works at all
 */
function diagnosticCopy() {
  const testText = `CLIPBOARD TEST - ${new Date().toLocaleTimeString()}`;
  console.log('[Diagnostic] Attempting to write test text to clipboard.');
  writeToSystemClipboard(testText).catch(e => console.error(e));
}

/** @type {KeyBindingAction} */
function quit() {
  process.emit('SIGINT');
}

// Zoom limits
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
const ZOOM_STEP = 0.1;

/**
 * Helper to extract origin from a URL.
 * Returns empty string on parse failure.
 */
function getOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** @type {KeyBindingAction} */
function zoomIn({ view }) {
  if (!view) return false;
  try {
    const url = view.content.webContents.getURL();
    const origin = getOrigin(url);
    if (!origin) return false;

    const current = view.content.webContents.getZoomFactor();
    const newZoom = Math.min(current + ZOOM_STEP, ZOOM_MAX);
    view.content.webContents.setZoomFactor(newZoom);

    // Persist zoom state
    const zoomDir = path.join(os.homedir(), '.local', 'share', 'awrit');
    const zoomFile = path.join(zoomDir, 'zoom-state.json');
    let zoomState = {};
    try {
      if (fs.existsSync(zoomFile)) {
        zoomState = JSON.parse(fs.readFileSync(zoomFile, 'utf8'));
      }
    } catch {}
    zoomState[origin] = newZoom;
    try {
      if (!fs.existsSync(zoomDir)) fs.mkdirSync(zoomDir, { recursive: true });
      fs.writeFileSync(zoomFile, JSON.stringify(zoomState, null, 2));
    } catch {}

    return true;
  } catch (err) {
    console.error('[Action] zoomIn failed:', err.message);
    return false;
  }
}

/** @type {KeyBindingAction} */
function zoomOut({ view }) {
  if (!view) return false;
  try {
    const url = view.content.webContents.getURL();
    const origin = getOrigin(url);
    if (!origin) return false;

    const current = view.content.webContents.getZoomFactor();
    const newZoom = Math.max(current - ZOOM_STEP, ZOOM_MIN);
    view.content.webContents.setZoomFactor(newZoom);

    // Persist zoom state
    const zoomDir = path.join(os.homedir(), '.local', 'share', 'awrit');
    const zoomFile = path.join(zoomDir, 'zoom-state.json');
    let zoomState = {};
    try {
      if (fs.existsSync(zoomFile)) {
        zoomState = JSON.parse(fs.readFileSync(zoomFile, 'utf8'));
      }
    } catch {}
    zoomState[origin] = newZoom;
    try {
      if (!fs.existsSync(zoomDir)) fs.mkdirSync(zoomDir, { recursive: true });
      fs.writeFileSync(zoomFile, JSON.stringify(zoomState, null, 2));
    } catch {}

    return true;
  } catch (err) {
    console.error('[Action] zoomOut failed:', err.message);
    return false;
  }
}

/** @type {KeyBindingAction} */
function zoomReset({ view }) {
  if (!view) return false;
  try {
    const url = view.content.webContents.getURL();
    const origin = getOrigin(url);
    if (!origin) return false;

    view.content.webContents.setZoomFactor(1.0);

    // Persist zoom state (remove entry or set to 1.0)
    const zoomDir = path.join(os.homedir(), '.local', 'share', 'awrit');
    const zoomFile = path.join(zoomDir, 'zoom-state.json');
    let zoomState = {};
    try {
      if (fs.existsSync(zoomFile)) {
        zoomState = JSON.parse(fs.readFileSync(zoomFile, 'utf8'));
      }
    } catch {}
    zoomState[origin] = 1.0;
    try {
      if (!fs.existsSync(zoomDir)) fs.mkdirSync(zoomDir, { recursive: true });
      fs.writeFileSync(zoomFile, JSON.stringify(zoomState, null, 2));
    } catch {}

    return true;
  } catch (err) {
    console.error('[Action] zoomReset failed:', err.message);
    return false;
  }
}

const config = {
  homepage,
  keybindings,
};

module.exports = config;

/** Utilities */

const util = require('node:util');

function debug(...args) {
  process.stderr.write(
    util
      .formatWithOptions(
        {
          colors: true,
        },
        ...args,
      )
      .replaceAll('\n', '\r\n'),
  );
}
