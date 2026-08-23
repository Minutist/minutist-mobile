import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string | null;
}

/**
 * Renders the error instead of nothing when a descendant throws during render.
 *
 * Without a boundary React unmounts the tree, leaving a blank white screen with
 * no message, no recovery and nothing for a user to report. That is close to
 * undiagnosable on a phone: there is no CLI route to a device's unified log
 * (macOS 15 dropped `log stream --device`, and `devicectl` covers iOS 17+ only),
 * so the screen is the only channel available. Showing the message turns a
 * silent failure into a legible one.
 *
 * The message is deliberately shown in release builds too. This app's floor is
 * iOS 15, several years behind its development simulators, so the failures most
 * likely to reach a user are exactly the ones that never appear in testing.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ componentStack: info.componentStack ?? null });
    // Also to the console, which is reachable over Safari's Web Inspector when
    // a device is attached.
    console.error('Unhandled render error', error, info.componentStack);
  }

  render() {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="error-boundary" role="alert">
        <h1>Something broke</h1>
        <p className="error-boundary-message">{error.message || String(error)}</p>
        {error.stack ? <pre className="error-boundary-stack">{error.stack}</pre> : null}
        {componentStack ? (
          <pre className="error-boundary-stack">{componentStack}</pre>
        ) : null}
        <button type="button" onClick={() => this.setState({ error: null, componentStack: null })}>
          Try again
        </button>
      </div>
    );
  }
}
