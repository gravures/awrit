import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// AWRIT_PERF=1 → rolling 1s buckets appended to ~/.local/share/awrit/perf.log.
// Off (default): one boolean check per call — no timer, no file, no output.
// Output never touches stdout/stderr: plain text would corrupt the escape stream.
let enabled = process.env.AWRIT_PERF === '1';

const counters = new Map<string, number>();
const timers = new Map<string, { count: number; sum: number; max: number }>();
const gauges = new Map<string, number>(); // live values (persist across buckets)
const gaugeMax = new Map<string, number>(); // per-bucket peaks
const values = new Map<string, string | number>(); // plain values (cleared per bucket)
let interval: ReturnType<typeof setInterval> | undefined;

const LOG_PATH = path.join(os.homedir(), '.local/share/awrit/perf.log');

function ensureTimer() {
  if (interval) return;
  interval = setInterval(flushToFile, 1000);
  interval.unref();
}

export function perfCount(name: string) {
  if (!enabled) return;
  counters.set(name, (counters.get(name) ?? 0) + 1);
  ensureTimer();
}

export function perfTime(): number | undefined {
  return enabled ? performance.now() : undefined;
}

/** Record elapsed ms since `t0` under `name`. No-op when disabled or t0 is undefined. */
export function perfEnd(name: string, t0: number | undefined) {
  if (!enabled || t0 == null) return;
  const d = performance.now() - t0;
  const t = timers.get(name);
  if (t) {
    t.count += 1;
    t.sum += d;
    if (d > t.max) t.max = d;
  } else {
    timers.set(name, { count: 1, sum: d, max: d });
  }
  ensureTimer();
}

/** In-flight gauge (e.g. pending paints); per-bucket max is reported. */
export function perfPending(name: string, delta: number) {
  if (!enabled) return;
  const cur = Math.max(0, (gauges.get(name) ?? 0) + delta);
  gauges.set(name, cur);
  const peak = gaugeMax.get(name);
  if (peak == null || cur > peak) gaugeMax.set(name, cur);
  ensureTimer();
}

/** Record a plain value (e.g. `frame`, `3840x2160`) reported as `name=v` in the bucket line. */
export function perfValue(name: string, v: string | number) {
  if (!enabled) return;
  values.set(name, v);
  ensureTimer();
}

/** Fold current bucket into one line and clear it. Pure — unit-tested. */
export function flushBucket(): string | undefined {
  if (counters.size === 0 && timers.size === 0 && gaugeMax.size === 0 && values.size === 0) {
    return undefined;
  }
  const parts: string[] = [];
  for (const [name, n] of counters) parts.push(`${name}=${n}`);
  for (const [name, t] of timers) {
    parts.push(`${name}=${(t.sum / t.count).toFixed(1)}/${t.max.toFixed(1)}ms(n=${t.count})`);
  }
  for (const [name, peak] of gaugeMax) parts.push(`${name}.max=${peak}`);
  for (const [name, v] of values) parts.push(`${name}=${v}`);
  counters.clear();
  timers.clear();
  gaugeMax.clear();
  values.clear();
  return parts.join(' ');
}

function flushToFile() {
  const line = flushBucket();
  if (!line) return;
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // perf logging must never break the session
  }
}

/** Test hook: toggle + drop live gauges and any armed timer. */
export function __setPerfEnabledForTest(value: boolean) {
  enabled = value;
  if (!value) {
    if (interval) clearInterval(interval);
    interval = undefined;
    gauges.clear();
  }
}
