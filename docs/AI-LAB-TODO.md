# AI-Lab — Rebuild TODO / Backlog

Running backlog for the ProxLab-on-Ai-Lab rebuild. Add items as they surface; check off when done.

## Cluster tab — metric cards (PARKED 2026-06-25, working but to be fleshed out)
The configurable metric-template system is functional (per-category templates, multi-value
series+fields entities, viz types, live preview, PromQL metric-name autocomplete). Deferred polish:

- [ ] **Label-aware autocomplete** — when the cursor is inside `{ ... }`, suggest label NAMES and
      their VALUES (e.g. `id=` → `lxc/177`, `node/pbs`). Backend `metrics:labelValues` RPC already exists.
- [ ] **Per-field thresholds / coloring** — color a field or gauge segment by value (e.g. ARC over a
      limit turns red); gauge-card-pro-style segments / secondary value / badges.
- [ ] **Node-card templates** — bring the top node cards into the same multi-value template system
      (total RAM, % used, ZFS ARC `node_zfs_arc_size`, swap, load, NIC throughput). This is where the
      density feature really pays off.
- [ ] **Backend-shared template persistence** — templates currently live in localStorage (per-browser).
      Move to a small backend `templates:get/set` RPC (JSON on CT 152) so they sync across browsers/devices.
      Editor + rendering stay the same; only load/save calls change.
- [ ] **Per-chart options** — height, min/max override, legend toggle, unit decimals, `rate()`/`avg_over_time`
      helpers, stat "sparkline background" mode.
- [ ] **More viz** — bar-gauge / horseshoe-style multi-segment gauge (flex-horseshoe-card), stacked area.
- [ ] **Metric browser/picker panel** — a searchable catalog of available metrics + their labels, to build
      queries by clicking rather than typing.
- [ ] Reference cards for inspiration: apexcharts-card, gauge-card-pro, flex-horseshoe-card (HA).

## Cluster tab — other
- [ ] Live exercise of write actions (stop/migrate/gpu) against real guests — verify error paths.
- [ ] Consider WS push (ProxLab `guests-update`) instead of 10s polling for the guest list.

## Verified / done so far
- Cluster tab migrated to Ai-Lab (read-only overview → inline controls → write actions).
- 2-row guest entries (controls row + expandable metrics row), sortable, draggable node order.
- pve-exporter on CT 160 feeding per-guest metrics into Prometheus.
- Native uPlot charts via backend `metrics:*` RPCs (bypassing Grafana iframes for inline use).
- Grafana embed path retained (GrafanaPanel + /grafana proxy) for big dashboards only.
