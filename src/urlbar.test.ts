import { expect, test } from 'bun:test';
import { type BarState, isBarEditing, renderBar } from './urlbar';

const CUP1 = '\x1b[1;1H';
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
  ...over,
});

/** The exactly-`cols`-wide cells between the SGR on/off pair. */
const barLine = (out: string) => out.slice(out.indexOf(SGR_ON) + SGR_ON.length, out.indexOf(SGR_OFF));

test('normal mode shows the URL padded to the pane, cursor hidden', () => {
  const out = renderBar(state({ mode: 'normal', url: 'abc', cols: 6 }));
  expect(out.startsWith(CUP1 + SGR_ON)).toBe(true);
  expect(barLine(out)).toBe('abc   ');
  expect(out.endsWith(CURSOR_OFF)).toBe(true);
  expect(out).not.toContain(CURSOR_ON);
});

test('normal-editing shows the prompt, pads, and places a shown cursor', () => {
  const out = renderBar(state({ mode: 'normal-editing', buffer: '', cols: 6 }));
  expect(barLine(out)).toBe('>     ');
  expect(out).toContain('\x1b[1;3H'); // cell 2 (after "> ") → 1-based col 3
  expect(out.endsWith('\x1b[1;3H' + CURSOR_ON)).toBe(true);
});

test('normal-editing cursor follows the buffer index', () => {
  const out = renderBar(state({ mode: 'normal-editing', buffer: 'exa', cursor: 3, cols: 8 }));
  expect(barLine(out)).toBe('> exa   ');
  expect(out).toContain('\x1b[1;6H'); // 2 prompt + 3 chars → 1-based col 6
});

test('find and find-editing use the "/ " prompt; find hides the cursor', () => {
  const found = renderBar(state({ mode: 'find', buffer: 'hi', cols: 8 }));
  expect(barLine(found)).toBe('/ hi    ');
  expect(found).not.toContain(CURSOR_ON);

  const editing = renderBar(state({ mode: 'find-editing', buffer: 'hi', cursor: 2, cols: 8 }));
  expect(barLine(editing)).toBe('/ hi    ');
  expect(editing).toContain('\x1b[1;5H'); // 2 prompt + 2 chars → 1-based col 5
  expect(editing).toContain(CURSOR_ON);
});

test('overflow shows the tail and keeps the cursor inside the pane', () => {
  const out = renderBar(
    state({ mode: 'normal-editing', buffer: 'abcdefghij', cursor: 10, cols: 6 }),
  );
  expect(barLine(out)).toBe('efghij'); // last 6 of "> abcdefghij"
  expect(out).toContain('\x1b[1;6H'); // clamped to the last column
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
