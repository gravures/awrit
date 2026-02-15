import { GFX } from './escapeCodes';
import { ROW_COLUMN_DIACRITICS } from './rowColumnDiacritics';
import { tmuxWrap } from './tmux';

export const TMUX_IMAGE_PLACEHOLDER = '\u{10eeee}';
const DEFAULT_CHUNK_BYTES = 3072; // 4096 base64 chars

type PaneBounds = {
  cols: number;
  rows: number;
};

function idToRgb(id: number) {
  return {
    r: (id >> 16) & 0xff,
    g: (id >> 8) & 0xff,
    b: id & 0xff,
  };
}

function diacritic(value: number) {
  return ROW_COLUMN_DIACRITICS[value] ?? '';
}

export function buildTmuxUploadCommands(
  pngBuffer: Buffer,
  id: number,
  cols: number,
  rows: number,
  chunkBytes = DEFAULT_CHUNK_BYTES,
) {
  const commands: string[] = [];
  let offset = 0;
  let first = true;
  while (offset < pngBuffer.length) {
    const remaining = pngBuffer.length - offset;
    const take = Math.min(remaining, chunkBytes);
    const chunk = pngBuffer.subarray(offset, offset + take);
    offset += take;
    const more = offset < pngBuffer.length ? 1 : 0;

    let control = `q=2,m=${more}`;
    if (first) {
      control = `a=T,i=${id},f=100,${control},U=1,c=${cols},r=${rows}`;
      first = false;
    }
    commands.push(tmuxWrap(GFX`${control};${chunk.toString('base64')}`));
  }
  return commands;
}

export function buildTmuxDeleteImageCommand(id: number) {
  return tmuxWrap(GFX`a=d,d=I,i=${id}`);
}

export function buildTmuxPlaceholderLines(
  id: number,
  startCol: number,
  startRow: number,
  cols: number,
  rows: number,
  pane: PaneBounds,
) {
  if (cols > ROW_COLUMN_DIACRITICS.length || rows > ROW_COLUMN_DIACRITICS.length) {
    throw new Error(
      `Image grid ${cols}x${rows} exceeds placeholder encoding limits (${ROW_COLUMN_DIACRITICS.length})`,
    );
  }

  const visibleCols = Math.max(0, Math.min(cols, pane.cols - startCol));
  const visibleRows = Math.max(0, Math.min(rows, pane.rows - startRow));
  if (visibleCols === 0 || visibleRows === 0) return [];

  const lines: string[] = [];
  const { r, g, b } = idToRgb(id);
  const msb = (id >> 24) & 0xff;
  const msbMark = msb === 0 ? '' : diacritic(msb);
  for (let row = 0; row < visibleRows; row++) {
    let line = '';
    line += `\x1b[${startRow + row + 1};${startCol + 1}H`;
    line += `\x1b[38:2:${r}:${g}:${b}m`;
    const rowMark = diacritic(row);
    for (let col = 0; col < visibleCols; col++) {
      line += TMUX_IMAGE_PLACEHOLDER + rowMark + diacritic(col) + msbMark;
    }
    line += '\x1b[39m';
    lines.push(line);
  }
  return lines;
}
