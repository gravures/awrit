import { appendFileSync } from 'node:fs';

let targetPath: string | undefined;

function getTargetPath() {
  if (targetPath !== undefined) return targetPath;
  targetPath = process.env.AWRIT_DEBUG_LOG;
  return targetPath;
}

export function debugLog(message: string) {
  const path = getTargetPath();
  if (path) {
    try {
      appendFileSync(path, message + '\n');
      return;
    } catch {
      // fall through to stderr if file logging fails
    }
  }
  console.error(message);
}
