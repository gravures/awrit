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
TMUX_LOG="$TEMP_DIR/tmux.log"
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
cat >"$FAKE_BIN/tmux" <<'EOF'
#!/usr/bin/env bash
command="${1:-}"
{
  printf '%s' "$command"
  shift || true
  printf ' <%s>' "$@"
  printf '\n'
} >>"$AWRIT_TEST_TMUX_LOG"
if [[ "${AWRIT_TEST_TMUX_FAIL_COMMAND:-}" == "$command" ]]; then
  exit 55
fi
if [[ "$command" == "show-options" ]]; then
  if [[ " $* " == *" -A "* ]]; then
    printf '%s\n' "${AWRIT_TEST_TMUX_EFFECTIVE_PASSTHROUGH:-on}"
  elif [[ -n "${AWRIT_TEST_TMUX_LOCAL_PASSTHROUGH:-}" ]]; then
    printf '%s\n' "$AWRIT_TEST_TMUX_LOCAL_PASSTHROUGH"
  fi
fi
EOF
cat >"$COPY/.bun/bin/bun" <<'EOF'
#!/usr/bin/env bash
{
  printf 'TMUX=%s\nTMUX_PANE=%s\nPWD=%s\n' "${TMUX-unset}" "${TMUX_PANE-unset}" "$PWD"
  printf '<%s>\n' "$@"
} >"$AWRIT_TEST_BUN_LOG"
exit "${AWRIT_TEST_BUN_EXIT:-0}"
EOF
chmod +x "$FAKE_BIN/open" "$FAKE_BIN/tmux" "$COPY/.bun/bin/bun"

workdir="$TEMP_DIR/project with spaces"
mkdir -p "$workdir"
workdir="$(cd "$workdir" && pwd -P)"
if (
  cd "$workdir"
  PATH="$FAKE_BIN:/usr/bin:/bin" TMUX=/tmp/tmux TMUX_PANE=%42 \
    AWRIT_OPEN_BIN="$FAKE_BIN/open" AWRIT_TEST_OPEN_LOG="$OPEN_LOG" \
    AWRIT_TEST_BUN_LOG="$BUN_LOG" AWRIT_TEST_TMUX_LOG="$TMUX_LOG" \
    "$COPY/awrit" 'https://example.com/a?b=c' >/dev/null
) \
  && grep -Fxq 'TMUX=/tmp/tmux' "$BUN_LOG" \
  && grep -Fxq 'TMUX_PANE=%42' "$BUN_LOG" \
  && grep -Fxq "PWD=$workdir" "$BUN_LOG" \
  && grep -Fxq '<run>' "$BUN_LOG" \
  && grep -Fxq "<$COPY/src/runner>" "$BUN_LOG" \
  && grep -Fxq '<https://example.com/a?b=c>' "$BUN_LOG" \
  && grep -Fxq 'set-option <-p> <-t> <%42> <allow-passthrough> <all>' "$TMUX_LOG" \
  && grep -Fxq 'set-option <-p> <-u> <-t> <%42> <allow-passthrough>' "$TMUX_LOG" \
  && [[ ! -e "$OPEN_LOG" ]]; then
  pass "tmux launch stays in-pane and scopes passthrough for its lifetime"
else
  fail "tmux launch stays in the current pane and preserves exact argv"
fi

: >"$TMUX_LOG"
(
  cd "$workdir"
  PATH="$FAKE_BIN:/usr/bin:/bin" TMUX=/tmp/tmux TMUX_PANE=%42 \
    AWRIT_TEST_BUN_EXIT=7 AWRIT_TEST_BUN_LOG="$BUN_LOG" AWRIT_TEST_TMUX_LOG="$TMUX_LOG" \
    "$COPY/awrit" --help >/dev/null
)
failure_status=$?
if [[ "$failure_status" -eq 7 ]] \
  && grep -Fxq 'set-option <-p> <-t> <%42> <allow-passthrough> <all>' "$TMUX_LOG" \
  && grep -Fxq 'set-option <-p> <-u> <-t> <%42> <allow-passthrough>' "$TMUX_LOG"; then
  pass "tmux passthrough is restored after runner failure"
else
  fail "tmux passthrough is restored after runner failure"
fi

: >"$TMUX_LOG"
if (
  cd "$workdir"
  PATH="$FAKE_BIN:/usr/bin:/bin" TMUX=/tmp/tmux TMUX_PANE=%42 \
    AWRIT_TEST_TMUX_LOCAL_PASSTHROUGH=off AWRIT_TEST_TMUX_EFFECTIVE_PASSTHROUGH=off \
    AWRIT_TEST_BUN_LOG="$BUN_LOG" AWRIT_TEST_TMUX_LOG="$TMUX_LOG" \
    "$COPY/awrit" --help >/dev/null
) \
  && grep -Fxq 'set-option <-p> <-t> <%42> <allow-passthrough> <all>' "$TMUX_LOG" \
  && grep -Fxq 'set-option <-p> <-t> <%42> <allow-passthrough> <off>' "$TMUX_LOG"; then
  pass "tmux passthrough restores an existing pane-local override"
else
  fail "tmux passthrough restores an existing pane-local override"
fi

QUERY_FAILURE_BUN_LOG="$TEMP_DIR/query-failure-bun.log"
if ! (
  cd "$workdir"
  PATH="$FAKE_BIN:/usr/bin:/bin" TMUX=/tmp/tmux TMUX_PANE=%42 \
    AWRIT_TEST_TMUX_FAIL_COMMAND=show-options AWRIT_TEST_BUN_LOG="$QUERY_FAILURE_BUN_LOG" \
    AWRIT_TEST_TMUX_LOG="$TMUX_LOG" "$COPY/awrit" --help >/dev/null 2>&1
) && [[ ! -e "$QUERY_FAILURE_BUN_LOG" ]]; then
  pass "tmux launch fails closed when passthrough cannot be queried"
else
  fail "tmux launch fails closed when passthrough cannot be queried"
fi

SET_FAILURE_BUN_LOG="$TEMP_DIR/set-failure-bun.log"
if ! (
  cd "$workdir"
  PATH="$FAKE_BIN:/usr/bin:/bin" TMUX=/tmp/tmux TMUX_PANE=%42 \
    AWRIT_TEST_TMUX_FAIL_COMMAND=set-option AWRIT_TEST_BUN_LOG="$SET_FAILURE_BUN_LOG" \
    AWRIT_TEST_TMUX_LOG="$TMUX_LOG" "$COPY/awrit" --help >/dev/null 2>&1
) && [[ ! -e "$SET_FAILURE_BUN_LOG" ]]; then
  pass "tmux launch fails closed when passthrough cannot be enabled"
else
  fail "tmux launch fails closed when passthrough cannot be enabled"
fi

INVALID_PANE_BUN_LOG="$TEMP_DIR/invalid-pane-bun.log"
if ! (
  cd "$workdir"
  PATH="$FAKE_BIN:/usr/bin:/bin" TMUX=/tmp/tmux TMUX_PANE=invalid \
    AWRIT_TEST_BUN_LOG="$INVALID_PANE_BUN_LOG" AWRIT_TEST_TMUX_LOG="$TMUX_LOG" \
    "$COPY/awrit" --help >/dev/null 2>&1
) && [[ ! -e "$INVALID_PANE_BUN_LOG" ]]; then
  pass "tmux launch fails closed with an invalid pane identity"
else
  fail "tmux launch fails closed with an invalid pane identity"
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
