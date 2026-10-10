# AGENTS.md — awrit.tmux-pane

## What this is
Terminal web browser via Kitty graphics protocol with tmux passthrough support. Hybrid Rust/TypeScript. Node >=22.11.0, Bun runtime.

## Quick commands
- Run (dev): `mise run awrit [url]` — the Bun runner owns the install root, tmux passthrough and Electron spawn.
- Dev setup: `mise install` installs the tools (bun, rust) and then — via the `postinstall` hook in `mise.toml` — runs the `setup` task (deps, native addon build, Electron verify/patch), so it is also a valid cold-start entry point; `mise run setup` runs that task directly. Cold start: `mise run setup:clean && mise run setup`.
- Preferred interface: `mise run test|lint|typecheck|format` (task aliases); direct `bun test` etc. work too.
- Tests: `bun test`  — unit tests + the tmux launch contract (`src/runner/launch.test.ts`).
- Single test: `bun test src/keybindings.test.ts`
- Lint/format: `biome lint ./src` ; `biome lint --write ./src` ; `biome format --write .`
- Typecheck: `tsc --noEmit --skipLibCheck`
- Runner dev: `src/runner/` is a workspace with Vite dev server.

## Architecture notes
- Entry point: `src/runner/index.ts` (dev = `mise run awrit` → `bun run src/runner`; release = the compiled `awrit` binary). Owns install-root resolution, the tmux passthrough contract (`src/runner/launch.ts`) and the error/log sink.
- Main entry: `src/index.ts` → Electron BrowserWindow + TTY layer.
- TTY layer: `src/tty/` — tmux vs kitty rendering branch on `isTmuxSession()`.
  - `tmux.ts` — pane queries via `tmux` CLI, caches size.
  - `tmuxRenderer.ts` — slot-based image management, visibility-gated flush.
  - `tmuxProtocol.ts` — Kitty protocol encoding for passthrough.
  - `mouseCoordinates.ts` — cell vs pixel normalization. Override via env `AWRIT_TMUX_MOUSE_COORDS=cell|pixel`.
- Rust native: `awrit-native-rs/` NAPI bindings for terminal I/O, tmux passthrough, shared memory.
- Paint flow: `src/paint.ts` routes Electron paint events to `TmuxRenderer` or `kittyGraphics.ts`.
- Config hot-reload: `config.toml` — resolved by the runner (`--config` → `./config.toml` → `$XDG_CONFIG_HOME/awrit/config.toml`, generated on first start); TOML is parsed in the runner and handed to Electron as JSON via `AWRIT_CONFIG_JSON`. Changes to the active file propagate without restart; invalid edits keep the last good config and log the reason.
- Config machinery: `src/config.ts` (option schema, defaults, TOML generator, validation) and `src/runner/config.ts` (resolve, parse, write the JSON); `src/actions.ts` is the keybinding action registry that config names reference.

## tmux requirements
- tmux 3.4+ with `allow-passthrough on` and `mouse on`.
- The runner temporarily sets pane-local `allow-passthrough all` and restores it on exit (`src/runner/launch.ts`).
- `TMUX_PANE` must match `^%[0-9]+$` or launch is refused.
- Launch tests: `src/runner/launch.test.ts` (via `bun test`) — headless, fake `tmux`, verifies in-pane launch & passthrough restore.

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
- `src/runner/launch.test.ts` is the source of truth for tmux launch behavior.

## Important paths
- Entry point: `src/runner/index.ts` (dev: `mise run awrit`; release: the compiled `awrit` binary at the tarball root)
- Launch contract: `src/runner/launch.ts` — install root, tmux passthrough, error sink; tested by `src/runner/launch.test.ts`
- Config: `src/config.ts` (schema + defaults); active file `./config.toml` or `$XDG_CONFIG_HOME/awrit/config.toml` (generated on first start)
- Zoom state: `~/.local/share/awrit/zoom-state.json` per origin.
- Logs: `$XDG_STATE_HOME/awrit/awrit.log` (fallback `~/.local/state/awrit/awrit.log`)
- Build output: `dist/`
- Native module: `awrit-native-rs/` — source-tree component (not an npm package); resolved via `src/native.ts`, installed/built by `mise run setup`.

## Conventions
- Do not change the tmux passthrough restore logic in `src/runner/launch.ts` — must fail closed.
- Keep tmux and non-tmux code paths parallel; do not delete native Kitty path.
- Biome is authoritative over ESLint. Do not add new linter configs.
- Config changes to the resolved `config.toml` are live-reloaded; invalid edits preserve the last good config.

## Constraints from repo
- Node engine >=22.11.0 enforced in package.json.
- `start` script is a no-op, always use `mise run awrit`.
- `src/runner` is a separate workspace, built with Vite.
