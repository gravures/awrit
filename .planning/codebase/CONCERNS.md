# Codebase Concerns

**Analysis Date:** 2026-09-01

## Tech Debt

**Dead code — `registerPaintedContent.ts`:**
- Issue: Duplicate `registerPaintedContent` function exists in both `src/paint.ts` (line 29) and `src/registerPaintedContent.ts` (line 9). `windows.ts` imports from `./paint`. The `registerPaintedContent.ts` module appears to be an unused alternative implementation.
- Files: `src/registerPaintedContent.ts`, `src/paint.ts`
- Impact: Confusion for contributors; dead code increases maintenance surface
- Fix approach: Delete `src/registerPaintedContent.ts` and verify no imports reference it

**Empty file — `ipc/renderer.ts`:**
- Issue: `src/ipc/renderer.ts` is completely empty (0 lines). The typesafe IPC types in `ipc/typesafe.ts` are defined but never imported by any file.
- Files: `src/ipc/renderer.ts`, `src/ipc/typesafe.ts`
- Impact: Incomplete IPC abstraction; dead types
- Fix approach: Remove empty file and unused typesafe types, or complete the IPC implementation

**Console globally suppressed:**
- Issue: `src/console.ts` silently overrides `console.log`, `console.error`, `console.warn` globally. All output goes through saved `console_` reference.
- Files: `src/console.ts`
- Impact: Confuses contributors; makes debugging harder; new contributors may waste time figuring out why `console.log` doesn't work
- Fix approach: Document this prominently in README or CONTRIBUTING.md

**Patched dependency:**
- Issue: `lru-cache@5.1.1` has a patch in `patches/lru-cache@5.1.1.patch`. Patched dependencies can break on upgrades.
- Files: `patches/lru-cache@5.1.1.patch`
- Impact: Upgrade friction; patch may become stale
- Fix approach: Track upstream for fix, or fork and maintain separately

## Known Bugs

**Typo in comment — `windows.ts`:**
- Symptoms: Misleading comment at line 59: "the happens before load" should be "this happens before load"
- Files: `src/windows.ts:59`
- Trigger: Reading code
- Workaround: N/A (cosmetic)

## Security Considerations

**`child_process.exec()` with tmux commands:**
- Risk: `exec()` in `src/runner/index.ts` lines 108-115 runs tmux commands. The `tmux_ext_keys_format` variable is read from tmux's stdout and passed back into `exec()` at line 171 without sanitization. While the value comes from tmux itself (low risk), this pattern could be dangerous if the source ever changed.
- Files: `src/runner/index.ts:108-115, 171`
- Current mitigation: Value sourced from tmux itself
- Recommendations: Sanitize/validate tmux output before using in shell commands

**`unsafe` Rust in shared memory operations:**
- Risk: Uses `unsafe` for `mmap`/`munmap` and raw pointer manipulation with shared memory segments. Finalizer ignores `shm_unlink` failure.
- Files: `awrit-native-rs/src/lib.rs:117-153`
- Current mitigation: Shared memory name is timestamp-based, permissions set to user-only
- Recommendations: Consider using safe Rust abstractions for mmap; log shm_unlink failures

**`executeJavaScript()` in selection.ts:**
- Risk: Runs arbitrary JavaScript in webContents via `executeJavaScript()`. Code is hardcoded (not user-input), but this is inherently sensitive in Electron apps.
- Files: `src/selection.ts:15`
- Current mitigation: Hardcoded JavaScript string
- Recommendations: Consider using IPC instead of executeJavaScript where possible

**`process.emit('SIGINT')` as abort mechanism:**
- Risk: Uses `@ts-expect-error` to emit SIGINT, bypassing normal process exit flow.
- Files: `src/abort.ts:4`
- Current mitigation: None
- Recommendations: Refactor to use proper AbortController pattern

## Performance Bottlenecks

**`bgra-to-rgba` SIMD conversion:**
- Problem: Heavy `unsafe` SIMD code for BGRA-to-RGBA pixel conversion — 484 lines. Platform-specific (SSE2, NEON, WASM SIMD).
- Files: `awrit-native-rs/crates/bgra-to-rgba/src/lib.rs`
- Cause: Performance-critical pixel conversion for rendering pipeline
- Improvement path: Profile on target platforms; consider WASM SIMD for cross-platform consistency

**Potential 200ms event loop block:**
- Problem: TODO comment in `awrit-native-rs/src/term.rs:47` suggests a potential 200ms block on the event loop.
- Files: `awrit-native-rs/src/term.rs:47`
- Cause: Unknown — needs investigation
- Improvement path: Profile and refactor to async if confirmed

## Fragile Areas

**Window management:**
- Files: `src/windows.ts`
- Why fragile: Complex integration of layout, IPC, resize handling, and toolbar management in 318 lines
- Safe modification: Test all window creation, resize, and toolbar interactions manually
- Test coverage: No tests

**Input handling pipeline:**
- Files: `src/inputHandler.ts`, `awrit-native-rs/src/input.rs`
- Why fragile: Complex event translation from crossterm to Electron format; thread spawning for input polling
- Safe modification: Test keyboard and mouse input on all platforms
- Test coverage: No tests

**Layout engine:**
- Files: `src/layout.ts`
- Why fragile: Complex breadth-first traversal, DPI conversion, tag caching in 533 lines
- Safe modification: Well-tested (layout.test.ts exists)
- Test coverage: Good (343 lines of tests)

## Scaling Limits

**Test coverage:**
- Current capacity: 3 test files covering layout and keybindings only
- Limit: Core functionality (windows, paint, input, tty) untested
- Scaling path: Add tests for `windows.ts`, `paint.ts`, `inputHandler.ts`, and tty modules

## Dependencies at Risk

**`lru-cache@5.1.1`:**
- Risk: Patched dependency — may break on upgrades
- Impact: Cache functionality
- Migration plan: Monitor upstream for native fix; consider alternatives if patch becomes stale

**`@biomejs/biome@1.9.4`:**
- Risk: Rapidly evolving tool — breaking changes possible
- Impact: Formatting and linting
- Migration plan: Pin version in package.json; review changelog before upgrades

## Missing Critical Features

**Test coverage for core functionality:**
- Problem: No tests for `windows.ts`, `paint.ts`, `inputHandler.ts`, tty modules, session management, extensions, or Rust native code
- Blocks: Reliable refactoring; regression detection; contributor confidence

**Rust test suite:**
- Problem: No Rust tests observed in `awrit-native-rs`
- Blocks: Confidence in native addon correctness; regression detection for platform-specific code

## Test Coverage Gaps

**`src/windows.ts`:**
- What's not tested: Window creation, layout integration, IPC setup, resize handling, toolbar management
- Files: `src/windows.ts`
- Risk: Window management regressions could break entire application
- Priority: High

**`src/paint.ts`:**
- What's not tested: Paint pipeline, image rendering, frame updates
- Files: `src/paint.ts`
- Risk: Rendering regressions could cause visual glitches or crashes
- Priority: High

**`src/inputHandler.ts`:**
- What's not tested: Input event handling, keyboard/mouse dispatch
- Files: `src/inputHandler.ts`
- Risk: Input regressions could make application unusable
- Priority: High

**`src/tty/*` modules:**
- What's not tested: Terminal I/O, process spawning, pty management
- Files: `src/tty/`
- Risk: TTY regressions could break terminal functionality
- Priority: Medium

**All Rust native code:**
- What's not tested: `awrit-native-rs/src/*.rs`
- Files: `awrit-native-rs/src/`
- Risk: Native addon regressions could cause crashes or data corruption
- Priority: Medium

---

*Concerns audit: 2026-09-01*
