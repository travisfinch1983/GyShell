import React from 'react'

/**
 * Files tab — embeds FileBrowser Quantum (browsing the mounted NAS pools at /nas), which runs as a
 * sidecar on :8082 in this container. Served same-origin via the Vite /files proxy (baseURL=/files),
 * so X-Frame-Options:SAMEORIGIN permits the iframe — no token, no CORS, no mixed content. Replaces the
 * old bare-bones ProxLab-backed file manager (which used the now-disconnected /api/file-manager bridge).
 */
export const FilesPanel: React.FC = () => (
  <div style={{ position: 'absolute', inset: 0, background: 'var(--app-bg)' }}>
    <iframe
      src="/files/"
      title="File Manager"
      style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
    />
  </div>
)
