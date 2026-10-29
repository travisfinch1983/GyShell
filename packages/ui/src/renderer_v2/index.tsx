import ReactDOM from 'react-dom/client'
import './styles/global.scss'

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement)

// `?embed=civitai-review` = the browser extension's side panel: the CivitAI Review screen only.
// Both branches are dynamic imports so the embed never constructs AppStore or boots the rest of
// the app (terminals, agents, polling).
const embed = new URLSearchParams(window.location.search).get('embed')

// NOTE: Keep StrictMode off to avoid double-invoking effects that initialize xterm/pty sessions.
if (embed === 'civitai-review') {
  void import('./components/ModelDownloads/CivitaiReviewEmbed').then(({ CivitaiReviewEmbed }) => {
    root.render(<CivitaiReviewEmbed />)
  })
} else {
  void import('./App').then(({ App }) => {
    root.render(<App />)
  })
}
