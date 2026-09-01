# Testing Patterns

**Analysis Date:** 2026-09-01

## Test Framework

**Runner:**
- Bun built-in test runner (`bun:test`)
- No external test framework (no Jest, Vitest, Mocha)

**Assertion Library:**
- Bun's built-in `expect` from `bun:test`

**Run Commands:**
```bash
bun test                    # Run all tests
bun test --watch            # Watch mode
bun test src/layout.test.ts # Run specific test file
```

**Config:**
- No `bunfig.toml` or test configuration file found
- No coverage tooling configured (no c8, istanbul, etc.)

## Test File Organization

**Location:**
- Co-located with source files (`.test.ts` alongside `.ts`)

**Naming:**
- `{module}.test.ts` (e.g., `layout.test.ts`, `keybindings.test.ts`)

**Structure:**
```
src/
├── layout.ts
├── layout.test.ts
├── keybindings.ts
├── keybindings.test.ts
└── fake-timers.test.ts
```

## Test Structure

**Suite Organization:**
```typescript
import { describe, expect, test, beforeEach } from 'bun:test';

describe('FeatureGroup', () => {
  describe('specificFeature', () => {
    test('description of behavior', () => {
      // Arrange
      // Act
      // Assert
    });
  });
});
```

**Patterns:**
- Uses `describe()` blocks for grouping related tests
- Uses `test()` (not `it()`)
- `beforeEach()` for setup
- No `afterEach()` or `afterAll()` — cleanup handled by `fakeTimers()` helper

## Mocking

**Framework:** None — tests work with real implementations

**Patterns:**
```typescript
// No mocking library used. Tests use real module implementations.
// Fake timers for time-dependent tests:
import { fakeTimers } from './fake-timers.test';
const { install, advance } = fakeTimers();
```

**What to Mock:**
- Not applicable — no mocking framework in use

**What NOT to Mock:**
- Everything runs with real implementations

## Fixtures and Factories

**Test Data:**
```typescript
// Inline test data — no external fixture files
const event = { key: 'a', shift: false, ctrl: false, alt: false, meta: false };
```

**Location:**
- Inline in test files — no external fixture directory

## Coverage

**Requirements:** None enforced

**View Coverage:**
```bash
# No coverage tooling configured
# Manual: count test cases vs source functions
```

## Test Types

**Unit Tests:**
- Layout engine: node creation, dimension calculations, row/column layouts, auto-sizing, nested layouts, DPI conversion, tag system
- Keybinding system: parsing, multi-key sequences, modifier ordering, timeouts, partial matches, event handling

**Integration Tests:**
- Not present — all tests are unit tests

**E2E Tests:**
- Not present

## Common Patterns

**Fake Timers (Custom Helper):**
```typescript
// src/fake-timers.test.ts
import { fakeTimers } from '@sinonjs/fake-timers';

export function fakeTimers() {
  const clock = fakeTimers.install();
  return {
    install: () => clock,
    advance: (ms: number) => clock.tick(ms),
    cleanup: () => clock.uninstall(),
  };
}
```

**Async Testing:**
- Not used — all tests are synchronous

**Error Testing:**
- Not present — no error-path tests observed

## Coverage Gaps

**Untested Areas:**
- `src/windows.ts` — Window management, layout integration, IPC setup, resize handling
- `src/paint.ts` — Paint pipeline, image rendering
- `src/inputHandler.ts` — Input event handling
- `src/tty/*` — Terminal I/O modules
- `src/session.ts` — Session management
- `src/extensions.ts` — Extension loading
- `src/args.ts` — CLI argument parsing
- All Rust native code — No Rust tests observed

**Priority:** High for `windows.ts`, `paint.ts`, `inputHandler.ts` (core functionality)

---

*Testing analysis: 2026-09-01*
