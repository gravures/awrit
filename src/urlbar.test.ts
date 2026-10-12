import { expect, test } from 'bun:test';
import {
  BAR_THEMES,
  type BarState,
  isBarEditing,
  lockForUrl,
  renderBar,
} from './urlbar';

const TEST_ROWS = 24;
const CUP24 = `\x1b[${TEST_ROWS};1H`;
const SGR_ON = '\x1b[7m';
const SGR_OFF = '\x1b[0m';
const CURSOR_ON = '\x1b[?25h';
const CURSOR_OFF = '\x1b[?25l';

const state = (over: Partial<BarState>): BarState => ({
  mode: 'normal',
  buffer: '',
  cursor: 0,
  url: '',
  cols: 8,
  lock: 'none',
  findCount: { index: 0, total: 0 },
  theme: 'reverse',
  ...over,
});

/** The exactly-`cols`-wide cells between the SGR on/off pair. */
const barLine = (out: string) => out.slice(out.indexOf(SGR_ON) + SGR_ON.length, out.indexOf(SGR_OFF));

test('normal mode shows the URL padded to the pane, cursor hidden', () => {
  const out = renderBar(state({ mode: 'normal', url: 'abc', cols: 6 }), TEST_ROWS);
  expect(out.startsWith(CUP24 + SGR_ON)).toBe(true);
  expect(barLine(out)).toBe('abc   ');
  expect(out.endsWith(CURSOR_OFF)).toBe(true);
  expect(out).not.toContain(CURSOR_ON);
});

test('normal-editing shows the prompt, pads, and places a shown cursor', () => {
  const out = renderBar(state({ mode: 'normal-editing', buffer: '', cols: 6 }), TEST_ROWS);
  expect(barLine(out)).toBe('>     ');
  expect(out).toContain(`\x1b[${TEST_ROWS};3H`); // cell 2 (after "> ") → 1-based col 3
  expect(out.endsWith(`\x1b[${TEST_ROWS};3H` + CURSOR_ON)).toBe(true);
});

test('normal-editing cursor follows the buffer index', () => {
  const out = renderBar(state({ mode: 'normal-editing', buffer: 'exa', cursor: 3, cols: 8 }), TEST_ROWS);
  expect(barLine(out)).toBe('> exa   ');
  expect(out).toContain(`\x1b[${TEST_ROWS};6H`); // 2 prompt + 3 chars → 1-based col 6
});

test('find and find-editing use the "/ " prompt; find hides the cursor', () => {
  const found = renderBar(state({ mode: 'find', buffer: 'hi', cols: 8 }), TEST_ROWS);
  expect(barLine(found)).toBe('/ hi    ');
  expect(found).not.toContain(CURSOR_ON);

  const editing = renderBar(state({ mode: 'find-editing', buffer: 'hi', cursor: 2, cols: 8 }), TEST_ROWS);
  expect(barLine(editing)).toBe('/ hi    ');
  expect(editing).toContain(`\x1b[${TEST_ROWS};5H`); // 2 prompt + 2 chars → 1-based col 5
  expect(editing).toContain(CURSOR_ON);
});

test('overflow shows the tail and keeps the cursor inside the pane', () => {
  const out = renderBar(
    state({ mode: 'normal-editing', buffer: 'abcdefghij', cursor: 10, cols: 6 }),
    TEST_ROWS,
  );
  expect(barLine(out)).toBe('efghij'); // last 6 of "> abcdefghij"
  expect(out).toContain(`\x1b[${TEST_ROWS};6H`); // clamped to the last column
});

test('cols is floored to at least 1 cell', () => {
  const out = renderBar(state({ mode: 'normal', url: 'abc', cols: 0 }));
  expect(barLine(out)).toBe('c'); // floored to 1 cell showing the tail
});

test('isBarEditing covers exactly the two editing modes', () => {
  expect(isBarEditing('normal-editing')).toBe(true);
  expect(isBarEditing('find-editing')).toBe(true);
  expect(isBarEditing('normal')).toBe(false);
  expect(isBarEditing('find')).toBe(false);
});

test('lockForUrl classifies https/http/other', () => {
  expect(lockForUrl('https://example.com')).toBe('secure');
  expect(lockForUrl('http://example.com')).toBe('insecure');
  expect(lockForUrl('file:///tmp/x.html')).toBe('none');
  expect(lockForUrl('about:blank')).toBe('none');
  expect(lockForUrl('')).toBe('none');
  expect(lockForUrl('not a url')).toBe('none');
});

test('normal mode prefixes the lock glyph and keeps exactly cols display cells', () => {
  const secure = renderBar(state({ mode: 'normal', url: 'abc', cols: 6, lock: 'secure' }), TEST_ROWS);
  expect(barLine(secure)).toBe('🔒 abc'); // 3 display cells (🔒 + space) + "abc"
  expect(secure).not.toContain(CURSOR_ON);

  const insecure = renderBar(state({ mode: 'normal', url: 'ab', cols: 5, lock: 'insecure' }), TEST_ROWS);
  expect(barLine(insecure)).toBe('⚠ ab ');
});

test('normal mode keeps the lock glyph visible when the URL overflows', () => {
  const out = renderBar(state({ mode: 'normal', url: 'abcdefghij', cols: 5, lock: 'secure' }), TEST_ROWS);
  expect(barLine(out)).toBe('🔒 ij'); // URL truncated from the front, glyph kept
});

test('lock prefix applies only in normal mode (edit cursor math unchanged)', () => {
  const editing = renderBar(state({ mode: 'normal-editing', buffer: '', cols: 6, lock: 'secure' }), TEST_ROWS);
  expect(barLine(editing)).toBe('>     ');
  expect(editing).toContain(`\x1b[${TEST_ROWS};3H`);
});

test('find shows the live match counter; zero total hides it', () => {
  const withCount = renderBar(
    state({ mode: 'find', buffer: 'hi', cols: 12, findCount: { index: 3, total: 12 } }),
    TEST_ROWS,
  );
  expect(barLine(withCount)).toBe('/ hi [3/12] ');

  const noCount = renderBar(state({ mode: 'find', buffer: 'hi', cols: 12 }), TEST_ROWS);
  expect(barLine(noCount)).toBe('/ hi        ');
});

test('barTheme selects the SGR preset; reverse is the default', () => {
  expect(BAR_THEMES.reverse).toBe('\x1b[7m');
  const dark = renderBar(state({ mode: 'normal', url: 'abc', cols: 6, theme: 'dark' }), TEST_ROWS);
  expect(dark).toContain('\x1b[37;40m');
  expect(dark.endsWith('\x1b[0m' + CURSOR_OFF)).toBe(true);
  const none = renderBar(state({ mode: 'normal', url: 'abc', cols: 6, theme: 'none' }), TEST_ROWS);
  expect(none.startsWith(CUP24 + 'abc')).toBe(true);
});
