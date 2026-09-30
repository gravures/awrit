import { describe, expect, test } from 'bun:test';
import {
  buildTmuxDeleteImageCommand,
  TMUX_IMAGE_PLACEHOLDER,
  buildTmuxPlaceholderLines,
  buildTmuxShmUploadCommands,
  buildTmuxUploadCommands,
} from './tmuxProtocol';

function unwrapTmux(sequence: string) {
  const prefix = '\x1bPtmux;';
  const suffix = '\x1b\\';
  if (!sequence.startsWith(prefix) || !sequence.endsWith(suffix)) {
    throw new Error('Not a tmux-wrapped sequence');
  }
  const innerEscaped = sequence.slice(prefix.length, -suffix.length);
  return innerEscaped.split('\x1b\x1b').join('\x1b');
}

function parseFirstGraphicsCommand(sequence: string) {
  const esc = '\x1b';
  const match = sequence.match(new RegExp(`${esc}_G([\\s\\S]*?)${esc}\\\\`));
  if (!match) {
    throw new Error('No kitty graphics command found');
  }
  const body = match[1];
  const splitIndex = body.indexOf(';');
  const control = splitIndex === -1 ? body : body.slice(0, splitIndex);
  const payload = splitIndex === -1 ? '' : body.slice(splitIndex + 1);
  return { control, payload };
}

function controlMap(control: string) {
  const map = new Map<string, string>();
  for (const part of control.split(',')) {
    const [key, value] = part.split('=');
    if (value != null) map.set(key, value);
  }
  return map;
}

describe('tmuxProtocol', () => {
  test('buildTmuxUploadCommands chunks payload and wraps for tmux', () => {
    const png = Buffer.alloc(6400, 0x41);
    const { upload: commands, placement } = buildTmuxUploadCommands(png, 0x12ab34, 10, 4);

    expect(commands.length).toBe(3);
    for (const command of commands) {
      expect(command.startsWith('\x1bPtmux;')).toBe(true);
      expect(command.endsWith('\x1b\\')).toBe(true);
      expect(unwrapTmux(command).startsWith('\x1b_G')).toBe(true);
    }

    const first = parseFirstGraphicsCommand(unwrapTmux(commands[0]));
    const middle = parseFirstGraphicsCommand(unwrapTmux(commands[1]));
    const last = parseFirstGraphicsCommand(unwrapTmux(commands[2]));
    const firstControl = controlMap(first.control);
    const middleControl = controlMap(middle.control);
    const lastControl = controlMap(last.control);

    expect(firstControl.get('a')).toBe('t');
    expect(firstControl.get('q')).toBe('2');
    expect(firstControl.get('f')).toBe('100');
    expect(firstControl.get('m')).toBe('1');

    expect(middleControl.get('q')).toBe('2');
    expect(middleControl.get('m')).toBe('1');
    expect(middleControl.get('a')).toBeUndefined();

    expect(lastControl.get('q')).toBe('2');
    expect(lastControl.get('m')).toBe('0');

    expect(placement.startsWith('\x1bPtmux;')).toBe(true);
    expect(placement.endsWith('\x1b\\')).toBe(true);
    const placementGfx = parseFirstGraphicsCommand(unwrapTmux(placement));
    const placementCtrl = controlMap(placementGfx.control);
    expect(placementCtrl.get('a')).toBe('p');
    expect(placementCtrl.get('U')).toBe('1');
    expect(placementCtrl.get('c')).toBe('10');
    expect(placementCtrl.get('r')).toBe('4');
    expect(placementCtrl.get('q')).toBe('2');
  });

  test('buildTmuxShmUploadCommands sends one name-carrying command, not the pixels', () => {
    const { upload: commands, placement } = buildTmuxShmUploadCommands(
      'L2F3cml0X2FiYzEyMw==',
      0x12ab34,
      10,
      4,
      790,
      814,
    );

    // One command regardless of raster size: the payload is a base64 name, not
    // the image. 12.6MB of shm-backed RGBA still crosses as a single escape code.
    expect(commands.length).toBe(1);
    const command = commands[0];
    expect(command.startsWith('\x1bPtmux;')).toBe(true);
    expect(command.endsWith('\x1b\\')).toBe(true);

    const { control, payload } = parseFirstGraphicsCommand(unwrapTmux(command));
    const ctrl = controlMap(control);
    expect(ctrl.get('a')).toBe('t');
    expect(ctrl.get('f')).toBe('32');
    expect(ctrl.get('t')).toBe('s');
    expect(ctrl.get('s')).toBe('790');
    expect(ctrl.get('v')).toBe('814');
    expect(ctrl.get('i')).toBe('1223476'); // 0x12ab34 in decimal, as the protocol wants
    expect(ctrl.get('q')).toBe('2');
    // f=32 must be an explicit dimensioned transfer — no m= chunking key.
    expect(ctrl.get('m')).toBeUndefined();
    expect(payload).toBe('L2F3cml0X2FiYzEyMw==');
    // The name must survive tmux's ESC-doubling intact.
    expect(unwrapTmux(command)).toContain(payload);

    const placementCtrl = controlMap(parseFirstGraphicsCommand(unwrapTmux(placement)).control);
    expect(placementCtrl.get('a')).toBe('p');
    expect(placementCtrl.get('U')).toBe('1');
    expect(placementCtrl.get('c')).toBe('10');
    expect(placementCtrl.get('r')).toBe('4');
    expect(placementCtrl.get('q')).toBe('2');
  });

  test('a crop may ride a larger segment as long as it declares its true size', () => {
    // The shm ring is allocated once at the largest raster the window sends and
    // is never resized, because a per-crop realloc churns the ring and lets GC
    // unlink a segment the terminal is still reading (black frames / tearing).
    // A crop therefore lands in a segment bigger than it needs, and s=/v= are
    // what tell the terminal how much to read. If s=/v= were omitted the
    // terminal would read the whole segment and show garbage.
    const { upload } = buildTmuxShmUploadCommands('c2Vnb25seQ==', 7, 40, 10, 800, 200);
    const ctrl = controlMap(parseFirstGraphicsCommand(unwrapTmux(upload[0])).control);
    expect(ctrl.get('s')).toBe('800');
    expect(ctrl.get('v')).toBe('200');
    // Declared raster must be exactly what the caller passed, not the segment's.
    expect(ctrl.get('c')).toBeUndefined();
  });

  test('buildTmuxPlaceholderLines clips to pane bounds', () => {
    const lines = buildTmuxPlaceholderLines(
      0x123456,
      2,
      1,
      6,
      4,
      { cols: 5, rows: 3 }, // clips to 3x2 visible cells
    );

    expect(lines.length).toBe(2);
    expect(lines[0].includes('\x1b[2;3H')).toBe(true);
    expect(lines[0].includes('\x1b[38:2:18:52:86m')).toBe(true);
    expect(lines[0].includes('\x1b[39m')).toBe(true);

    const placeholderCount = [...lines.join('')].filter(
      (char) => char === TMUX_IMAGE_PLACEHOLDER,
    ).length;
    expect(placeholderCount).toBe(6);
  });

  test('checks placeholder limits after clipping to pane bounds', () => {
    const lines = buildTmuxPlaceholderLines(0x123456, 0, 0, 500, 500, {
      cols: 5,
      rows: 3,
    });

    expect(lines.length).toBe(3);
    const placeholderCount = [...lines.join('')].filter(
      (char) => char === TMUX_IMAGE_PLACEHOLDER,
    ).length;
    expect(placeholderCount).toBe(15);
  });

  test('rejects a visible grid that exceeds placeholder encoding limits', () => {
    expect(() =>
      buildTmuxPlaceholderLines(0x123456, 0, 0, 500, 500, { cols: 500, rows: 3 }),
    ).toThrow('Visible image grid');
  });

  test('buildTmuxDeleteImageCommand wraps delete command for tmux', () => {
    const command = buildTmuxDeleteImageCommand(1234);
    expect(command.startsWith('\x1bPtmux;')).toBe(true);
    expect(command.endsWith('\x1b\\')).toBe(true);
    const inner = unwrapTmux(command);
    const gfx = parseFirstGraphicsCommand(inner);
    const control = controlMap(gfx.control);
    expect(control.get('a')).toBe('d');
    expect(control.get('d')).toBe('I');
    expect(control.get('i')).toBe('1234');
    expect(control.get('q')).toBe('2');
    expect(gfx.payload).toBe('');
  });
});
