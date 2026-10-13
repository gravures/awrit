import type { BrowserWindow } from 'electron';

/**
 * Cursor position in the window, width is assumed to be 1.
 *
 * @property x - The x coordinate of the cursor.
 * @property y - The y coordinate of the cursor.
 * @property height - The height of the cursor.
 */
export type Cursor = { x: number; y: number; height: number };

export async function getCursorPosition(view: BrowserWindow): Promise<Cursor | undefined> {
  let bounds: Cursor | undefined;
  try {
    bounds = await view.webContents.executeJavaScript(
      `(window.__getCursorPosition ??= () => {
          const rect = window.getSelection()?.getRangeAt(0).getBoundingClientRect();
          return rect && { x: rect.left, y: rect.top, height: rect.height };
        }
      ) && window.__getCursorPosition()`,
    );
  } catch {}
  return bounds;
}
