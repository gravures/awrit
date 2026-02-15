import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  buildTmuxDeleteImageCommand,
  TMUX_IMAGE_PLACEHOLDER,
  buildTmuxPlaceholderLines,
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
    const commands = buildTmuxUploadCommands(png, 0x12ab34, 10, 4);

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

    expect(firstControl.get('a')).toBe('T');
    expect(firstControl.get('q')).toBe('2');
    expect(firstControl.get('f')).toBe('100');
    expect(firstControl.get('U')).toBe('1');
    expect(firstControl.get('c')).toBe('10');
    expect(firstControl.get('r')).toBe('4');
    expect(firstControl.get('m')).toBe('1');

    expect(middleControl.get('q')).toBe('2');
    expect(middleControl.get('m')).toBe('1');
    expect(middleControl.get('a')).toBeUndefined();

    expect(lastControl.get('q')).toBe('2');
    expect(lastControl.get('m')).toBe('0');
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

    const placeholderCount = [...lines.join('')].filter((char) => char === TMUX_IMAGE_PLACEHOLDER).length;
    expect(placeholderCount).toBe(6);
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
    expect(gfx.payload).toBe('');
  });
});

const hasTimg = spawnSync('timg', ['--version'], { stdio: 'ignore' }).status === 0;
const maybeTimgTest = hasTimg ? test : test.skip;

maybeTimgTest('tmux upload stream stays compatible with timg control fields', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'awrit-timg-contract-'));
  const fixturePath = join(fixtureDir, 'pixel.png');

  // 1x1 transparent PNG fixture
  const fixture = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Wl7sAAAAASUVORK5CYII=',
    'base64',
  );
  writeFileSync(fixturePath, fixture);

  try {
    const timg = spawnSync('timg', ['-pk', '--frames=1', '--loops=1', '-g', '4x3', fixturePath], {
      encoding: 'utf8',
    });
    expect(timg.status).toBe(0);
    const raw = timg.stdout;
    const timgGraphics = parseFirstGraphicsCommand(raw);
    const timgControl = controlMap(timgGraphics.control);

    // Build our tmux stream using timg's own encoded payload as input bytes.
    const payloadBytes = Buffer.from(timgGraphics.payload, 'base64');
    const oursWrapped = buildTmuxUploadCommands(payloadBytes, 42, 4, 3);
    const ours = parseFirstGraphicsCommand(unwrapTmux(oursWrapped[0]));
    const oursControl = controlMap(ours.control);

    expect(oursControl.get('a')).toBe(timgControl.get('a'));
    expect(oursControl.get('q')).toBe(timgControl.get('q'));
    expect(oursControl.get('f')).toBe(timgControl.get('f'));
    expect(oursControl.get('m')).toBe(timgControl.get('m'));
    expect(ours.payload).toBe(timgGraphics.payload);

    // tmux-specific placeholder mode fields we expect in our native stream.
    expect(oursControl.get('U')).toBe('1');
    expect(oursControl.get('c')).toBe('4');
    expect(oursControl.get('r')).toBe('3');
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
