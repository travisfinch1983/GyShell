import React from 'react'

/**
 * GrafanaPanel — embeds a single Grafana panel via the `d-solo` endpoint.
 *
 * RULE #1: the iframe src is SAME-ORIGIN (`/grafana/...`). The Vite dev server
 * proxies `/grafana` → Grafana (CT 105) server-side and injects the service-account
 * Bearer token, so the browser never talks to 10.0.0.x directly and no token is
 * exposed. Grafana is configured with serve_from_sub_path so all its sub-resources
 * also resolve under `/grafana` and flow back through the proxy.
 *
 * Reusable across any tab — pass a dashboard uid + panelId (find them in Grafana's
 * dashboard JSON / panel "Share → Embed").
 */
interface Props {
  uid: string
  panelId: number
  from?: string
  to?: string
  refresh?: string
  height?: number
  /** Grafana template variable overrides → &var-<key>=<value> */
  vars?: Record<string, string>
}

export const GrafanaPanel: React.FC<Props> = ({
  uid,
  panelId,
  from = 'now-3h',
  to = 'now',
  refresh = '10s',
  height = 180,
  vars,
}) => {
  const params = new URLSearchParams({
    orgId: '1',
    panelId: String(panelId),
    from,
    to,
    refresh,
    theme: 'dark',
  })
  if (vars) {
    for (const [k, v] of Object.entries(vars)) params.append(`var-${k}`, v)
  }
  const src = `/grafana/d-solo/${uid}/x?${params.toString()}`
  return (
    <iframe
      src={src}
      title={`grafana-${uid}-${panelId}`}
      loading="lazy"
      style={{
        width: '100%',
        height,
        border: '1px solid var(--border)',
        borderRadius: 8,
        background: 'var(--panel-bg)',
      }}
    />
  )
}
