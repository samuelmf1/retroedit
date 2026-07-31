import { Component } from 'react'

export default class AppErrorBoundary extends Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('RetroEdit render failure', error, info)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <main className="fatalerror" role="alert">
        <div className="fatalerrorcard">
          <a className="controlbrand" href="/">RetroEdit</a>
          <h1>Something interrupted this view</h1>
          <p>Your browser data was not uploaded. Reload RetroEdit to start with a clean workspace.</p>
          <div>
            <button type="button" className="primary" onClick={() => window.location.reload()}>
              Reload RetroEdit
            </button>
            <a href="/">Return home</a>
          </div>
          <details>
            <summary>Technical detail</summary>
            <code>{this.state.error?.message || 'Unknown rendering error'}</code>
          </details>
        </div>
      </main>
    )
  }
}
