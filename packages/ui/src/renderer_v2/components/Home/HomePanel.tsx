import React from 'react'

/**
 * Home tab — embeds the Dynacat dashboard (lab service status + news feeds) that runs as a
 * sidecar on :8081 in this container. Served same-origin via the Vite /dash proxy, so its
 * CSP frame-ancestors 'self' permits the iframe (no token, no CORS, no mixed content) — same
 * approach as the Grafana embeds. Dynacat handles its own refresh/live updates.
 */
export const HomePanel: React.FC = () => (
  <div style={{ position: 'absolute', inset: 0, background: 'var(--app-bg)' }}>
    <iframe
      src="/dash/"
      title="Dashboard"
      style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
    />
  </div>
)
