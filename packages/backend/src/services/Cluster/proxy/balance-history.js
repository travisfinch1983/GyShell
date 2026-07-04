import { readFileSync, appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

/**
 * Credit-tracker phase 2 — historical balance snapshots → cost-over-time / burn-rate / runway.
 *
 * Phase 1 (proxy.js `fetchExternalSourceBalance`) returns the LIVE balance for each external
 * source. This module persists a timestamped series (append-only JSONL, one row per source per
 * tick) and derives spend rate + runway from it. Dependencies are injected so it stays
 * decoupled from proxy.js internals:
 *   { historyFile, loadSources(): source[], fetchBalance(source): Promise<normalized>, intervalMs? }
 *
 * A snapshot row: { ts, sourceId, tag, displayName, kind, currency, balance, totalUsage, spendMonth }
 * (missing metrics are null). `balance`/`totalUsage` come from OpenRouter/DeepSeek; `spendMonth`
 * from the Anthropic admin cost report.
 */
export function createBalanceHistory({ historyFile, loadSources, fetchBalance, intervalMs = 6 * 3600_000 }) {
  let timer = null;

  function appendRows(rows) {
    if (!rows.length) return;
    mkdirSync(dirname(historyFile), { recursive: true });
    appendFileSync(historyFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }

  function readAll() {
    try {
      return readFileSync(historyFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Take one snapshot across all sources that expose a balance; returns the rows written. */
  async function snapshot(nowTs) {
    const sources = loadSources();
    const rows = [];
    for (const s of sources) {
      try {
        const b = await fetchBalance(s);
        if (!b || !b.supported) continue;
        rows.push({
          ts: nowTs,
          sourceId: s.id,
          tag: s.tag,
          displayName: s.displayName,
          kind: b.kind || null,
          currency: b.currency || null,
          balance: numOrNull(b.balance),
          totalUsage: numOrNull(b.totalUsage != null ? b.totalUsage : b.usage && b.usage.total),
          spendMonth: numOrNull(b.spendMonth),
        });
      } catch { /* skip this source this tick — a transient fetch failure shouldn't drop the batch */ }
    }
    appendRows(rows);
    return rows;
  }

  /** The time-sorted series for one source (optionally since `sinceTs`) + derived burn/runway. */
  function historyFor(sourceId, sinceTs) {
    const series = readAll()
      .filter((r) => r.sourceId === sourceId && (!sinceTs || r.ts >= sinceTs))
      .sort((a, b) => a.ts - b.ts);
    return { sourceId, series, ...computeBurn(series) };
  }

  function start() {
    if (timer) return;
    // First snapshot shortly after boot (let sources settle), then every interval. unref so the
    // timers never keep the process alive on their own.
    const kick = setTimeout(() => { snapshot(Date.now()).catch(() => {}); }, 30_000);
    if (kick.unref) kick.unref();
    timer = setInterval(() => { snapshot(Date.now()).catch(() => {}); }, intervalMs);
    if (timer.unref) timer.unref();
  }

  return { snapshot, historyFor, readAll, start };
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Derive burn-rate ($/day) + runway (days) from a time-sorted snapshot series.
 * Method priority (most→least robust):
 *   1. usage-delta   — cumulative totalUsage delta / days. Monotonic + top-up-immune (OpenRouter).
 *   2. spend-delta   — Anthropic monthly spendMonth; delta if increasing, else latest (month reset).
 *   3. balance-delta — balance decrease / days. Fallback; a mid-window top-up understates it.
 * runwayDays = current balance / burnPerDay (only where a balance exists; e.g. not Anthropic spend).
 */
export function computeBurn(series) {
  const samples = series ? series.length : 0;
  if (samples < 2) return { burnPerDay: null, runwayDays: null, method: null, windowDays: 0, samples };
  const first = series[0];
  const last = series[series.length - 1];
  const windowDays = (last.ts - first.ts) / 86_400_000;
  const out = { burnPerDay: null, runwayDays: null, method: null, windowDays, samples, currency: last.currency || null };
  if (windowDays <= 0) return out;

  if (isNum(first.totalUsage) && isNum(last.totalUsage) && last.totalUsage >= first.totalUsage) {
    out.burnPerDay = (last.totalUsage - first.totalUsage) / windowDays;
    out.method = 'usage-delta';
  } else if (last.kind === 'spend' && isNum(first.spendMonth) && isNum(last.spendMonth)) {
    const spend = last.spendMonth >= first.spendMonth ? last.spendMonth - first.spendMonth : last.spendMonth;
    out.burnPerDay = spend / windowDays;
    out.method = 'spend-delta';
  } else if (isNum(first.balance) && isNum(last.balance)) {
    out.burnPerDay = (first.balance - last.balance) / windowDays;
    out.method = 'balance-delta';
  }

  if (isNum(last.balance) && out.burnPerDay && out.burnPerDay > 0) {
    out.runwayDays = last.balance / out.burnPerDay;
  }
  return out;
}
