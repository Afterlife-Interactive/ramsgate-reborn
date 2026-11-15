import { Component, type ErrorInfo, type ReactNode } from "react";
import { SupportLink } from "./SupportLink";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Changing this value clears a caught error, e.g. when the user switches tabs. */
  resetKey?: string;
}

interface ErrorBoundaryState {
  failed: boolean;
}

/** Keeps one broken section from taking the whole launcher window down with it. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) console.error("[ui] section crashed:", error, info.componentStack);
  }

  componentDidUpdate(previous: ErrorBoundaryProps) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  render() {
    if (!this.state.failed) return this.props.children;

    return (
      <div className="mx-auto max-w-xl px-8 py-16">
        <h1 className="display text-[28px] leading-none text-text">Something broke</h1>
        <p className="mt-3 text-sm text-text-muted">This page didn't load. Try another tab and come back, or restart the launcher.</p>
        <p className="mt-2 text-sm text-text-muted"><SupportLink /></p>
      </div>
    );
  }
}
