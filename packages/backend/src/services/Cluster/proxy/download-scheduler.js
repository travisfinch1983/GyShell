import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
const DATA_DIR = process.env.AILAB_PROXY_DATA_DIR || (process.cwd() + '/data');

const SCHED_PATH = join(DATA_DIR, 'download-scheduler.json');

const DEFAULTS = {
  hf: {
    mode: 'manual',       // 'auto' | 'manual'
    manualState: 'running', // 'running' | 'paused'
    schedule: Array.from({ length: 7 }, () => Array(24).fill(true)),
  },
  civ: {
    mode: 'manual',
    manualState: 'running',
    schedule: Array.from({ length: 7 }, () => Array(24).fill(true)),
  },
};

export function loadScheduler() {
  try {
    if (existsSync(SCHED_PATH)) return { ...DEFAULTS, ...JSON.parse(readFileSync(SCHED_PATH, 'utf8')) };
  } catch {}
  return { ...DEFAULTS };
}

export function saveScheduler(data) {
  writeFileSync(SCHED_PATH, JSON.stringify(data, null, 2));
}

/**
 * Check if new downloads are allowed for a given source ('hf' or 'civ').
 * Returns true if a new download may start, false if the queue is paused
 * or the current hour is not scheduled.
 */
export function isDownloadAllowed(source) {
  const sched = loadScheduler();
  const cfg = sched[source];
  if (!cfg) return true;

  if (cfg.mode === 'manual') {
    return cfg.manualState === 'running';
  }

  // Auto mode — check schedule grid
  const now = new Date();
  const day = now.getDay();   // 0=Sunday
  const hour = now.getHours();
  return !!(cfg.schedule?.[day]?.[hour]);
}
