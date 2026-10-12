import { exec } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { features } from './features';
import type { ActionRegistry, KeyBindingEvent } from './keybindings';

/**
 * Electron is required lazily. This module is imported by unit tests, where the
 * `electron` package resolves to its binary-path string rather than the runtime
 * API, and `src/paint.test.ts` registers a shared module mock — a top-level
 * import here poisoned that mock's export set (a `Bun` test-suite interaction,
 * not an app behaviour).
 */
function electronApi(): typeof import('electron') {
  return require('electron') as typeof import('electron');
}

/**
 * Built-in keybinding actions (09-04).
 *
 * These used to live inside the shipped `config.js`, which meant every user
 * config carried application code. They now live here and are addressed by
 * name, so a `config.toml` binding is data (`"<C-r>" = "refresh"`) instead of
 * a closure. Behaviour is unchanged from the old default — only the location
 * and the names are new.
 */

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

// Clipboard timeout to prevent blocking (execSync causes freeze if xclip hangs)
const CLIPBOARD_TIMEOUT_MS = 500;

/** Write text to the terminal emulator's clipboard using OSC 52. */
function writeToTerminalClipboard(text: string) {
  const base64 = Buffer.from(text).toString('base64');
  process.stdout.write(`\x1b]52;c;${base64}\x07`);
}

/**
 * Execute a command with timeout protection.
 * Returns stdout or null on failure/timeout.
 */
function execWithTimeout(
  cmd: string,
  input: string | null,
  timeoutMs = CLIPBOARD_TIMEOUT_MS,
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = exec(cmd, { encoding: 'utf8', timeout: timeoutMs }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
    if (input) {
      child.stdin?.write(input);
      child.stdin?.end();
    }
  });
}

/**
 * Write text to system clipboard.
 * Uses Electron clipboard (fast, non-blocking) with native fallback.
 */
async function writeToSystemClipboard(text: string) {
  try {
    // Primary: Electron clipboard (fast, non-blocking)
    electronApi().clipboard.writeText(text);

    // Secondary: Terminal OSC 52 (Robust over SSH/Wayland)
    writeToTerminalClipboard(text);
  } catch {
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
      console.error('[Clipboard] Copy failed:', (nativeErr as Error).message);
    }
  }
}

/**
 * Read text from system clipboard.
 * Uses Electron clipboard (fast, non-blocking) with native fallback.
 */
async function readFromSystemClipboard(): Promise<string> {
  try {
    // Primary: Electron clipboard (fast, non-blocking)
    const text = electronApi().clipboard.readText();
    if (text) return text;
  } catch {
    // Continue to fallback
  }

  // Fallback: native clipboard with timeout
  try {
    let result: string | null = null;
    if (process.platform === 'darwin') {
      result = await execWithTimeout('pbpaste', null);
    } else if (process.platform === 'linux') {
      result = process.env.WAYLAND_DISPLAY
        ? await execWithTimeout('wl-paste', null)
        : await execWithTimeout('xclip -selection clipboard -o', null);
    } else if (process.platform === 'win32') {
      result = await execWithTimeout('powershell Get-Clipboard', null);
    }
    return result || '';
  } catch (e) {
    console.error('[Clipboard] Paste failed:', (e as Error).message);
  }
  return '';
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function back({ view }: KeyBindingEvent) {
  view?.back();
}

function forward({ view }: KeyBindingEvent) {
  view?.forward();
}

function refresh({ view }: KeyBindingEvent) {
  view?.refresh();
}

function find({ view }: KeyBindingEvent) {
  if (!view) return;
  view.toolbar.webContents.send('toolbar:toggle-find');
  view.content.blurWebView();
  view.toolbar.focusOnWebView();
  view.focusedContent = view.toolbar.webContents;
}

/** Focus the URL bar. Sets `toolbarFocused` so Esc in `inputHandler` returns to the page. */
function focusUrl({ view }: KeyBindingEvent) {
  if (!view) return;
  view.content.blurWebView();
  view.toolbar.focusOnWebView();
  view.focusedContent = view.toolbar.webContents;
  view.toolbar.webContents.send('toolbar:focus-url');
  features.toolbarFocused = true;
}

function selectAll({ view }: KeyBindingEvent) {
  view?.focusedContent.selectAll();
}

// ---------------------------------------------------------------------------
// Zoom
// ---------------------------------------------------------------------------

// Zoom limits
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
const ZOOM_STEP = 0.1;

// The old config.js wrote this exact path on every platform; kept as-is so
// behaviour does not change in this plan.
const ZOOM_STATE_FILE = path.join(os.homedir(), '.local', 'share', 'awrit', 'zoom-state.json');

/** Extract a URL's origin; empty string on parse failure. */
function getOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function persistZoom(origin: string, factor: number) {
  let zoomState: Record<string, number> = {};
  try {
    if (fs.existsSync(ZOOM_STATE_FILE)) {
      zoomState = JSON.parse(fs.readFileSync(ZOOM_STATE_FILE, 'utf8'));
    }
  } catch {}
  zoomState[origin] = factor;
  try {
    fs.mkdirSync(path.dirname(ZOOM_STATE_FILE), { recursive: true });
    fs.writeFileSync(ZOOM_STATE_FILE, JSON.stringify(zoomState, null, 2));
  } catch {}
}

function zoomIn({ view }: KeyBindingEvent) {
  if (!view) return;
  try {
    const origin = getOrigin(view.content.webContents.getURL());
    if (!origin) return;
    const current = view.content.webContents.getZoomFactor();
    const newZoom = Math.min(current + ZOOM_STEP, ZOOM_MAX);
    view.content.webContents.setZoomFactor(newZoom);
    persistZoom(origin, newZoom);
  } catch (err) {
    console.error('[Action] zoomIn failed:', (err as Error).message);
  }
}

function zoomOut({ view }: KeyBindingEvent) {
  if (!view) return;
  try {
    const origin = getOrigin(view.content.webContents.getURL());
    if (!origin) return;
    const current = view.content.webContents.getZoomFactor();
    const newZoom = Math.max(current - ZOOM_STEP, ZOOM_MIN);
    view.content.webContents.setZoomFactor(newZoom);
    persistZoom(origin, newZoom);
  } catch (err) {
    console.error('[Action] zoomOut failed:', (err as Error).message);
  }
}

function zoomReset({ view }: KeyBindingEvent) {
  if (!view) return;
  try {
    const origin = getOrigin(view.content.webContents.getURL());
    if (!origin) return;
    view.content.webContents.setZoomFactor(1.0);
    persistZoom(origin, 1.0);
  } catch (err) {
    console.error('[Action] zoomReset failed:', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Clipboard actions
// ---------------------------------------------------------------------------

function copy({ view }: KeyBindingEvent) {
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
    .then((selectedText: string) => {
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

function paste({ view }: KeyBindingEvent) {
  if (!view) return;
  const target = view.focusedContent;

  readFromSystemClipboard()
    .then((text) => {
      if (text && text.length > 0) {
        setImmediate(() => {
          target.insertText(text);
        });
      }
    })
    .catch((err) => {
      console.error('[Clipboard] Read failed:', err);
    });
}

/** Diagnostic tool to check if clipboard writing works at all. */
function diagnosticCopy() {
  const testText = `CLIPBOARD TEST - ${new Date().toLocaleTimeString()}`;
  console.log('[Diagnostic] Attempting to write test text to clipboard.');
  writeToSystemClipboard(testText).catch((e) => console.error(e));
}

function quit() {
  process.emit('SIGINT');
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * name → action. A keybinding in `config.toml` names one of these; the loader
 * reports an unknown name instead of failing silently.
 */
export const actions: ActionRegistry = {
  back,
  forward,
  refresh,
  find,
  'focus-url': focusUrl,
  'select-all': selectAll,
  'zoom-in': zoomIn,
  'zoom-out': zoomOut,
  'zoom-reset': zoomReset,
  copy,
  paste,
  'diagnostic-copy': diagnosticCopy,
  quit,
};
