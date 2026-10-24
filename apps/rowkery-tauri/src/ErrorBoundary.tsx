import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback: (error: Error) => ReactNode;
  /** A change to any of these clears a caught error (a new tab or run shows again). */
  resetKeys?: readonly unknown[];
  /** Told once per caught error (an overlay closes itself and toasts). */
  onError?: (error: Error) => void;
}

interface State {
  error: Error | null;
  keys?: readonly unknown[];
}

/** Catches render errors so the webview never goes blank. */
export class RenderErrorBoundary extends Component<Props, State> {
  state: State = { error: null, keys: this.props.resetKeys };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    const next = props.resetKeys;
    if (next === state.keys) return null;
    const changed =
      !next || !state.keys || next.length !== state.keys.length || next.some((k, i) => !Object.is(k, state.keys![i]));
    return changed ? { keys: next, error: null } : { keys: next };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Rowkery render error", error, info.componentStack);
    this.props.onError?.(error);
  }

  render() {
    if (this.state.error) {
      return this.props.fallback(this.state.error);
    }
    return this.props.children;
  }
}
