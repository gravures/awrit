#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/awrit-launcher.XXXXXX")"
TEMP_DIR="$(cd "$TEMP_DIR" && pwd -P)"
COPY="$TEMP_DIR/awrit"
FAKE_BIN="$TEMP_DIR/bin"
OPEN_LOG="$TEMP_DIR/open.log"
BUN_LOG="$TEMP_DIR/bun.log"
BUN_DIRECT_LOG="$TEMP_DIR/bun-direct.log"
PASSED=0
FAILED=0

cleanup() { rm -rf "$TEMP_DIR"; }
trap cleanup EXIT
pass() { printf 'ok - %s\n' "$1"; PASSED=$((PASSED + 1)); }
fail() { printf 'not ok - %s\n' "$1"; FAILED=$((FAILED + 1)); }

mkdir -p "$COPY/.bun/bin" "$COPY/node_modules" "$COPY/src/runner" "$FAKE_BIN"
cp "$ROOT/awrit" "$COPY/awrit"
chmod +x "$COPY/awrit"

cat >"$FAKE_BIN/open" <<'EOF'
#!/usr/bin/env bash
printf '<%s>\n' "$@" >"$AWRIT_TEST_OPEN_LOG"
exit 99
EOF
cat >"$COPY/.bun/bin/bun" <<'EOF'
#!/usr/bin/env bash
{
  printf 'TMUX=%s\nTMUX_PANE=%s\nPWD=%s\n' "${TMUX-unset}" "${TMUX_PANE-unset}" "$PWD"
  printf '<%s>\n' "$@"
} >"$AWRIT_TEST_BUN_LOG"
EOF
chmod +x "$FAKE_BIN/open" "$COPY/.bun/bin/bun"

workdir="$TEMP_DIR/project with spaces"
mkdir -p "$workdir"
workdir="$(cd "$workdir" && pwd -P)"
if (
  cd "$workdir"
  PATH="$FAKE_BIN:/usr/bin:/bin" TMUX=/tmp/tmux TMUX_PANE=%42 \
    AWRIT_OPEN_BIN="$FAKE_BIN/open" AWRIT_TEST_OPEN_LOG="$OPEN_LOG" \
    AWRIT_TEST_BUN_LOG="$BUN_LOG" \
    "$COPY/awrit" 'https://example.com/a?b=c' >/dev/null
) \
  && grep -Fxq 'TMUX=/tmp/tmux' "$BUN_LOG" \
  && grep -Fxq 'TMUX_PANE=%42' "$BUN_LOG" \
  && grep -Fxq "PWD=$workdir" "$BUN_LOG" \
  && grep -Fxq '<run>' "$BUN_LOG" \
  && grep -Fxq "<$COPY/src/runner>" "$BUN_LOG" \
  && grep -Fxq '<https://example.com/a?b=c>' "$BUN_LOG" \
  && [[ ! -e "$OPEN_LOG" ]]; then
  pass "tmux launch stays in the current pane and preserves exact argv"
else
  fail "tmux launch stays in the current pane and preserves exact argv"
fi

if PATH="$FAKE_BIN:/usr/bin:/bin" AWRIT_TEST_BUN_LOG="$BUN_DIRECT_LOG" \
    env -u TMUX -u TMUX_PANE "$COPY/awrit" --help >/dev/null \
  && grep -Fxq 'TMUX=unset' "$BUN_DIRECT_LOG" \
  && grep -Fxq 'TMUX_PANE=unset' "$BUN_DIRECT_LOG" \
  && grep -Fxq '<run>' "$BUN_DIRECT_LOG" \
  && grep -Fxq "<$COPY/src/runner>" "$BUN_DIRECT_LOG" \
  && grep -Fxq '<--help>' "$BUN_DIRECT_LOG"; then
  pass "direct launch keeps the existing Bun runner contract"
else
  fail "direct launch keeps the existing Bun runner contract"
fi

if bash -n "$ROOT/awrit" "$ROOT/docs/get"; then
  pass "launcher and installer parse as Bash"
else
  fail "launcher and installer parse as Bash"
fi

printf 'Results: %s passed, %s failed\n' "$PASSED" "$FAILED"
exit "$FAILED"
