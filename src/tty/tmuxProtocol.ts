import { GFX } from './escapeCodes';
import { ROW_COLUMN_DIACRITICS } from './rowColumnDiacritics';
import { wrapTmuxPassthrough } from '../native';

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
): { upload: string[]; placement: string } {
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
      control = `a=t,i=${id},f=100,${control}`;
      first = false;
    }
    commands.push(wrapTmuxPassthrough(GFX`${control};${chunk.toString('base64')}`));
  }
  // q=2: suppress OK/ERR APC replies — tmux has no APC key handler and
  // shreds them into keystrokes sent to whichever pane is focused.
  const placement = wrapTmuxPassthrough(GFX`a=p,i=${id},U=1,c=${cols},r=${rows},q=2`);
  return { upload: commands, placement };
}

export function buildTmuxDeleteImageCommand(id: number) {
  return wrapTmuxPassthrough(GFX`a=d,d=I,i=${id},q=2`);
}

/**
 * Upload via POSIX shared memory instead of inline base64 pixels.
 *
 * The escape code carries a base64 *name*, not the image, so this is a single
 * ~76-byte command regardless of frame size — against ~82KB of base64+DCS for
 * the same frame via `buildTmuxUploadCommands`. The terminal reads the pixels
 * straight out of the shm segment and unlinks it, so the caller must refill the
 * segment before every send (see `ShmGraphicBuffer::write`).
 *
 * Verified end-to-end through tmux passthrough in Ghostty: 08-01-SHM-TEST.md.
 */
export function buildTmuxShmUploadCommands(
  nameBase64: string,
  id: number,
  cols: number,
  rows: number,
  width: number,
  height: number,
  isFirst: boolean,
  startCol: number,
  startRow: number,
): { upload: string[]; placement: string } {
  // f=32 raw RGBA. a=T: transfer AND display (create new image).
  // a=t: transfer only (update existing image).
  // t=s: unlink after read — terminal consumes segment, enabling pool rotation.
  const action = isFirst ? 'T' : 't';
  const upload = [
    wrapTmuxPassthrough(GFX`a=${action},i=${id},f=32,t=s,s=${width},v=${height},q=2;${nameBase64}`),
  ];
  // q=2 on both: tmux has no APC key handler and shreds replies into keystrokes.
  // x/y position the image at the correct pane location (matches placeholder CUP).
  const placement = wrapTmuxPassthrough(GFX`a=p,i=${id},U=1,c=${cols},r=${rows},x=${startCol},y=${startRow},q=2`);
  return { upload, placement };
}

export function buildTmuxPlaceholderLines(
  id: number,
  startCol: number,
  startRow: number,
  cols: number,
  rows: number,
  pane: PaneBounds,
) {
  const visibleCols = Math.max(0, Math.min(cols, pane.cols - startCol));
  const visibleRows = Math.max(0, Math.min(rows, pane.rows - startRow));
  if (visibleCols === 0 || visibleRows === 0) return [];
  if (visibleCols > ROW_COLUMN_DIACRITICS.length || visibleRows > ROW_COLUMN_DIACRITICS.length) {
    throw new Error(
      `Visible image grid ${visibleCols}x${visibleRows} exceeds placeholder encoding limits (${ROW_COLUMN_DIACRITICS.length})`,
    );
  }

  const lines: string[] = [];
  const { r, g, b } = idToRgb(id);
  const msb = (id >> 24) & 0xff;
  const msbMark = msb === 0 ? '' : diacritic(msb);
  for (let row = 0; row < visibleRows; row++) {
    let line = '';
    line += `\x1b[${startRow + row + 1};${startCol + 1}H`;
    line += `\x1b[38:2:${r}:${g}:${b}m`;
    // Diacritics are inherited from the placeholder cell to the left, so only
    // the first cell of a row needs them. A bare run of placeholders then
    // advances the column by one per cell automatically. This is the entire
    // wire cost of the tmux path -- measured at deliver.placeholderKB=32, i.e.
    // all of deliver.wireKB -- so dropping the repeats is the difference
    // between 2.5x the bytes and 1x.
    line += TMUX_IMAGE_PLACEHOLDER + diacritic(row) + diacritic(0) + msbMark;
    for (let col = 1; col < visibleCols; col++) {
      line += TMUX_IMAGE_PLACEHOLDER;
    }
    line += '\x1b[39m';
    lines.push(line);
  }
  return lines;
}
