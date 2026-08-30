# awrit — Electron Installation Failure

**Date**: 2026-08-30
**Bun version**: 1.4.0
**Electron version**: 37.3.1
**Platform**: Linux x86_64

## Symptom

Running `./awrit` after a fresh `./setup.sh` produces the following error (logged to `awrit_error.txt`):

```
Electron failed to install correctly, please delete node_modules/electron and try installing again
```

The error is thrown by `node_modules/electron/index.js` when it cannot locate the `path.txt` file that points to the electron binary.

## Root Cause

During `bun install`, the electron npm package's postinstall script (`node_modules/electron/install.js`) performs two steps:

1. **Download** the electron binary zip via `@electron/get` — this succeeded.
2. **Extract** the zip into `node_modules/electron/dist/` via `extract-zip` — this failed partway.

### Evidence

| Artifact | Expected | Actual |
|---|---|---|
| `node_modules/electron/dist/` | Full electron distribution (binary, `.pak` files, libraries, etc.) | Only `locales/de.pak` |
| `node_modules/electron/path.txt` | Contains `electron` (Linux) | Missing entirely |
| `~/.cache/electron/` | Cached zip | Present (109 MB) |

Because extraction failed before completion, `path.txt` was never written (it is created at the end of `extractFile()` in `install.js`). When `index.js` runs, it finds no `path.txt` and throws.

### Likely Cause

Bun v1.4.0's handling of the `extract-zip` module (a dependency of electron's `install.js`) is imperfect. This is a known category of issues where bun's postinstall lifecycle does not always execute complex extraction scripts correctly. The zip file itself was downloaded and cached successfully — only the extraction step failed.

## Diagnosis Steps

1. Check `node_modules/electron/dist/` — found only `locales/de.pak`, missing the `electron` binary
2. Check for `node_modules/electron/path.txt` — missing
3. Check `~/.cache/electron/` — zip present, confirming download succeeded
4. Inspected `node_modules/electron/install.js` — confirmed `path.txt` is written after `extract-zip` completes
5. Manually ran `node node_modules/electron/install.js` — extraction silently failed again (bun environment issue)

## Manual Fix

Re-extract the cached zip using the system `unzip` command and create `path.txt`:

```bash
cd node_modules/electron
unzip -o ~/.cache/electron/*/electron-v37.3.1-linux-x64.zip -d dist/
printf 'electron' > path.txt
```

> **Important**: Use `printf` instead of `echo` (even `echo -n`). Some environments and
> tools append a trailing newline to `path.txt`, which causes Bun to look for a binary
> named `electron\n` and fail with `ENOENT: no such file or directory, posix_spawn`.
> Verify with `xxd path.txt` — it should be exactly 8 bytes with no trailing `0a`.

### Verification

```bash
node_modules/electron/dist/electron --version
# → v37.3.1
xxd node_modules/electron/path.txt
# → 00000000: 656c 6563 7472 6f6e                      electron
```

## Follow-up: Trailing Newline in `path.txt`

After manually fixing the extraction, a second error occurred:

```
ENOENT: no such file or directory, posix_spawn '.../electron\n'
```

The `path.txt` file contained `electron` followed by a newline (`0a`). Bun's
`readFileSync('path.txt', 'utf-8')` preserves the newline, so the resolved path
becomes `electron\n` — an invalid filename.

### Cause

The manual fix used `echo -n "electron" > path.txt`, but the file still ended up
with a trailing newline. This can happen depending on shell behavior, toolchain
(e.g., a file-writing tool that appends `\n`), or editor auto-formatting.

### Fix

```bash
printf 'electron' > node_modules/electron/path.txt
```

Verify with `xxd` — the file must be exactly 8 bytes:

```
00000000: 656c 6563 7472 6f6e                      electron
```

## Prevention

Two approaches to prevent recurrence on a fresh `setup.sh` run:

### Option 1: Post-install check in setup.sh

After `bun install`, verify that the electron binary exists. If not, re-run the electron install script:

```bash
ELECTRON_DIR="$BASE_DIR/node_modules/electron"
if [ ! -f "$ELECTRON_DIR/path.txt" ]; then
  echo "Electron install incomplete, retrying..."
  "$BUN_EXE" run "$ELECTRON_DIR/install.js"
fi
```

### Option 2: System unzip fallback

If bun's extract-zip keeps failing, fall back to the system `unzip` against the cached zip:

```bash
ELECTRON_DIR="$BASE_DIR/node_modules/electron"
if [ ! -f "$ELECTRON_DIR/path.txt" ]; then
  CACHED_ZIP=$(find ~/.cache/electron/ -name "electron-*.zip" -print -quit 2>/dev/null)
  if [ -n "$CACHED_ZIP" ]; then
    echo "Extracting electron from cache using system unzip..."
    unzip -o "$CACHED_ZIP" -d "$ELECTRON_DIR/dist/"
    printf 'electron' > "$ELECTRON_DIR/path.txt"
  fi
fi
```

### Trade-offs

| | Option 1 (re-run install.js) | Option 2 (system unzip) |
|---|---|---|
| Pros | Uses upstream logic, always correct | Bypasses bun's extract-zip entirely |
| Cons | May fail again if bun + extract-zip is the problem | Must detect correct zip version manually |
| Complexity | Low | Medium |
