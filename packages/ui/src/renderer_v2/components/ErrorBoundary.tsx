import React from 'react'

/**
 * Contains a render crash to one section instead of the whole application.
 *
 * React unmounts the ENTIRE tree when a component throws during render and nothing catches it, so
 * a single bad field read blanks the app — which is exactly what one undefined array in the
 * Support Models panel did: the page went black and unresponsive, with the real cause visible
 * only in the browser console. Everything else on the page was fine.
 *
 * The boundary does not hide the failure — it shows it in place, keeps the rest of the UI usable,
 * and still logs to the console for the stack trace.
 */
interface Props { children: React.ReactNode; label?: string }
interface State { error: Error | null }

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Keep the console path: the stack is what makes this diagnosable, and the panel below
    // deliberately shows only the message.
    console.error(`[ui] ${this.props.label || 'section'} failed to render:`, error, info.componentStack)
  }

  render(): React.ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div
        style={{
          padding: '10px 12px', margin: '8px 0', borderRadius: 6, fontSize: 12, lineHeight: 1.5,
          border: '1px solid var(--danger, #e66)',
          background: 'color-mix(in srgb, var(--danger, #e66) 10%, transparent)',
          color: 'var(--danger, #e66)',
        }}
      >
        <strong>{this.props.label || 'This section'} failed to render.</strong>
        <div style={{ marginTop: 4, opacity: 0.85, fontFamily: 'ui-monospace, monospace', wordBreak: 'break-word' }}>
          {error.message}
        </div>
        <div style={{ marginTop: 6, opacity: 0.75 }}>
          The rest of the page still works. Full stack trace is in the browser console.
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            style={{
              marginLeft: 8, padding: '2px 8px', borderRadius: 4, cursor: 'pointer', fontSize: 11,
              border: '1px solid var(--border)', background: 'var(--control-bg)', color: 'var(--fg)',
            }}
          >
            Retry
          </button>
        </div>
      </div>
    )
  }
}
