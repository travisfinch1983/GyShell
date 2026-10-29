/**
 * `?doneLimit=N` on a downloads poll: every unfinished item plus only the N newest completed
 * ones, and `doneTotal` = how many completed there are. The UI polls this every few seconds;
 * returning all 1000+ finished rows (~2 MB with the HF list) every time queued the gateway's
 * ping reply behind megabytes of frames, the web shim read that as a dead socket and tore it
 * down mid-request ("Socket Disconnected"), and the reconnect repeated it. Absent = full list.
 */
export function trimDoneDownloads(list, doneLimitRaw) {
  const doneLimit = Number.parseInt(String(doneLimitRaw ?? ''), 10);
  const done = list.filter((d) => d.status === 'complete');
  if (!Number.isFinite(doneLimit) || doneLimit < 0) return { downloads: list, doneTotal: done.length };
  const ts = (d) => Date.parse(d.completedAt || d.startedAt || '') || 0;
  const keep = new Set(done.slice().sort((a, b) => ts(b) - ts(a)).slice(0, doneLimit));
  return { downloads: list.filter((d) => d.status !== 'complete' || keep.has(d)), doneTotal: done.length };
}
