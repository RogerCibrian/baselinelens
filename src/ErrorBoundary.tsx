import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Top-level boundary that catches render errors below it and shows a
 * recovery panel so an unhandled exception in one component doesn't
 * blank the whole app. Class component because React's error-boundary
 * lifecycle methods (`getDerivedStateFromError`, `componentDidCatch`)
 * have no function-component equivalent — boundaries are the documented
 * exception to the "function components only" convention.
 */
export default class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Unhandled render error:", error, info.componentStack);
  }

  handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" className="error-boundary">
        <h1>Something went wrong</h1>
        <p>
          The app hit an unexpected error and can&apos;t continue
          rendering. Reload to recover — your scan data is safe on disk.
        </p>
        <pre className="error-boundary-detail">{error.message}</pre>
        <button
          type="button"
          className="button-primary"
          onClick={this.handleReload}
        >
          Reload
        </button>
      </div>
    );
  }
}
