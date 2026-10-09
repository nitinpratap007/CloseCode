// Phase 17: safe error boundary. Wraps editor panels so a component
// crash (e.g. a formatter, an extension, diagnostics) renders a
// fallback instead of taking the whole window down.
import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Optional label shown in the fallback UI. */
  label?: string;
}

interface State {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, message: "" };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message ?? String(error) };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Report to the main process error log so it is never silently lost.
    try {
      void (window as unknown as { closeCode?: { captureError: (e: unknown) => Promise<{ ok: boolean }> } }).closeCode?.captureError({
        process: "renderer",
        type: "ipc",
        message: `ErrorBoundary caught: ${error.message}`,
        stack: error.stack,
        context: {
          component: this.props.label ?? "unknown",
          componentStack: info.componentStack ?? undefined,
        },
      });
    } catch {}
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: 16, margin: 8, border: "1px solid #f44",
          borderRadius: 6, background: "#2a1a1a", color: "#faa",
        }}>
          <strong style={{ color: "#f66" }}>
            {this.props.label ? `${this.props.label}: ` : ""}Something went wrong
          </strong>
          <pre style={{ whiteSpace: "pre-wrap", color: "#fbb", marginTop: 8 }}>
            {this.state.message}
          </pre>
          <button
            onClick={() => this.setState({ hasError: false, message: "" })}
            style={{ marginTop: 8, cursor: "pointer" }}
          >
            Dismiss
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
