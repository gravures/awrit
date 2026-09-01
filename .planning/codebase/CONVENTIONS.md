# Coding Conventions

**Analysis Date:** 2026-09-01

## Naming Patterns

**Files:**
- TypeScript: `camelCase.ts` (e.g., `inputHandler.ts`, `kittyGraphics.ts`, `registerPaintedContent.ts`)
- Rust: `snake_case.rs` (standard Rust convention)
- Config: Standard lowercase (`biome.json`, `tsconfig.json`, `package.json`)

**Functions:**
- TypeScript: `camelCase` (e.g., `createWindowWithToolbar`, `paintInitialFrame`, `handleEvent`, `loadKeyBindings`)
- Rust: `snake_case` (e.g., `term_enable_features`, `listen_for_input`, `get_window_size`)

**Variables:**
- Local: `camelCase`
- Constants: `camelCase` (e.g., `TIMEOUT_MS`, `WHEEL_DELTA`, `CONFIG_PATH`)
- Private/internal: trailing underscore (e.g., `console_`, `weakPaintedContents_`, `imageId_`)

**Types/Interfaces:**
- PascalCase (e.g., `LayoutNode`, `PaintedContent`, `WindowView`, `TermEvent`, `KeyBindingAction`)

## Code Style

**Formatting (Biome):**
- Indent: 2 spaces
- Line width: 100
- Line ending: LF
- Quotes: Single quotes
- Semicolons: Always
- Trailing commas: All
- Arrow parens: Always
- Config: `biome.json` at root

**Linting:**
- `noExplicitAny`: Off
- `a11y` rules: All disabled
- `useTemplate`: Off
- VCS aware (respects `.gitignore`)

**TypeScript:**
- `strict: true`, `noImplicitAny: true`, `skipLibCheck: true`
- Target: ESNext

**Rust:**
- `tab_spaces = 2`, `edition = "2021"` (`awrit-native-rs/rustfmt.toml`)
- Clippy enforced via `#![deny(clippy::all)]`

## Import Organization

**Order:**
1. Node/Bun built-ins
2. Third-party packages
3. Internal modules

**Path Aliases:**
- Not used — relative imports with `./` and `../`

## Error Handling

**Patterns:**
- TypeScript: Try/catch with `console_.error()` for logging (console is globally overridden)
- Rust: `Result` type with `?` propagation, `anyhow` for error context
- No custom error types — uses string-based errors

## Logging

**Framework:** Custom console override (`src/console.ts`)

**Patterns:**
- All `console.log`, `console.error`, `console.warn` are silently suppressed
- Actual output uses saved reference: `console_` (e.g., `console_.error(...)`, `console_.log(...)`)
- This is by design — prevents Electron renderer noise

## Comments

**When to Comment:**
- TODO for unresolved design decisions
- NOTE for important behavioral notes
- No JSDoc/TSDoc usage observed

**JSDoc/TSDoc:**
- Not used — types are defined inline or in separate type files

## Function Design

**Size:** No enforced limits, but modules tend to be focused (<300 lines for TS)

**Parameters:** Prefer options objects for complex functions

**Return Values:** Explicit returns, no early returns in most cases

## Module Design

**Exports:** Named exports only (no default exports)

**Barrel Files:** Not used — direct imports from specific modules

---

*Convention analysis: 2026-09-01*
