# AGENTS.md — awrit.tmux-pane

## What this is
Terminal web browser via Kitty graphics protocol with tmux passthrough support. Hybrid Rust/TypeScript. Node >=22.11.0, Bun runtime.

## Quick commands
- Run: `./awrit [url]`  — launcher script handles tmux setup & bun boot.
- Dev setup: `mise install` installs the tools (bun, rust) and then — via the `postinstall` hook in `mise.toml` — runs the `setup` task (deps, native addon build, Electron verify/patch), so it is also a valid cold-start entry point; `mise run setup` runs that task directly. Cold start: `mise run setup:clean && mise run setup`.
- Preferred interface: `mise run test|lint|typecheck|format` (task aliases); direct `bun test` etc. work too.
- Tests: `bun test && bash tests/test-launcher.sh`  — unit tests + launcher integration.
- Single test: `bun test src/keybindings.test.ts`
- Lint/format: `biome lint ./src` ; `biome lint --write ./src` ; `biome format --write .`
- Typecheck: `tsc --noEmit --skipLibCheck`
- Runner dev: `src/runner/` is a workspace with Vite dev server.

## Architecture notes
- Main entry: `src/index.ts` → Electron BrowserWindow + TTY layer.
- TTY layer: `src/tty/` — tmux vs kitty rendering branch on `isTmuxSession()`.
  - `tmux.ts` — pane queries via `tmux` CLI, caches size.
  - `tmuxRenderer.ts` — slot-based image management, visibility-gated flush.
  - `tmuxProtocol.ts` — Kitty protocol encoding for passthrough.
  - `mouseCoordinates.ts` — cell vs pixel normalization. Override via env `AWRIT_TMUX_MOUSE_COORDS=cell|pixel`.
- Rust native: `awrit-native-rs/` NAPI bindings for terminal I/O, tmux passthrough, shared memory.
- Paint flow: `src/paint.ts` routes Electron paint events to `TmuxRenderer` or `kittyGraphics.ts`.
- Config hot-reload: root `config.js` — homepage + keybindings. Changes propagate to running instance.

## tmux requirements
- tmux 3.4+ with `allow-passthrough on` and `mouse on`.
- Launcher `awrit` temporarily sets pane-local `allow-passthrough all`, restores on EXIT.
- `TMUX_PANE` must match `^%[0-9]+$` or launch is refused.
- Launcher tests: `bash tests/test-launcher.sh` — headless, verifies in-pane launch & passthrough restore.

## Code style & tooling
- Formatter/linter: Biome v2.2.2, files `src/**/*.ts`/`src/**/*.tsx`.
- Indent 2 spaces, single quotes, semicolons always, lineWidth 100.
- tsconfig excludes tests, `src/runner`, `src/toolbar`, `awrit-native-rs`.
- `.npmrc`: legacy-peer-deps=true, engine-strict=false.

## Testing quirks
- Tests co-located `*.test.ts` using Bun built-in test runner + `expect`.
- No mocking library; use temp dirs, env var save/restore, fake executables.
- Shared fake timers: `src/fake-timers.test.ts`.
- Integration tests create real file descriptors and fake `tmux` binaries.
- `test-launcher.sh` is the source of truth for tmux launch behavior.

## Important paths
- Launcher: `./awrit`
- Config: `./config.js`
- Zoom state: `~/.local/share/awrit/zoom-state.json` per origin.
- Build output: `dist/`
- Native module: `awrit-native-rs/` — source-tree component (not an npm package); resolved via `src/native.ts`, installed/built by `mise run setup`. Launcher resolves bun via `mise -C <repo> which bun` (returns the pinned executable), falling back to `bun` on PATH.

## Conventions
- Do not change `awrit` passthrough restore logic — must fail closed.
- Keep tmux and non-tmux code paths parallel; do not delete native Kitty path.
- Biome is authoritative over ESLint. Do not add new linter configs.
- Changes to `config.js` are live-reloaded; require cache is cleared.

## Constraints from repo
- Node engine >=22.11.0 enforced in package.json.
- `start` script is a no-op, always use `./awrit`.
- `src/runner` is a separate workspace, built with Vite.
