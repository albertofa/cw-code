import { Component, type ReactNode } from "react";

interface BoundaryState {
  error: string | null;
}

export class RootErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(err: unknown): BoundaryState {
    return { error: err instanceof Error ? err.message : "Unknown render error" };
  }

  componentDidCatch(err: unknown): void {
    console.error(`renderer root error: ${(err as Error)?.message ?? err}`);
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="empty fatal-fallback" role="alert">
          <div className="empty-mark">!</div>
          <div>Something went wrong rendering the app.</div>
          <div className="notif-msg">{this.state.error}</div>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            Reload app
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
