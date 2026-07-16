import React from "react";

/**
 * Last-resort error boundary. Without it, ANY render crash unmounted the whole
 * tree — a permanent white screen in a desktop window with no refresh chrome
 * (the user had to kill and restart the app). This shows the (redation-safe,
 * message-only) error and a reload button instead. Deliberately dependency-free
 * and not localized: if rendering is broken, the i18n provider may be too.
 */
type State = { error: Error | null };

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{
        display: "flex", height: "100vh", alignItems: "center", justifyContent: "center",
        background: "#0b0e14", color: "#d1d5db", fontFamily: "system-ui, sans-serif",
      }}>
        <div style={{ maxWidth: 480, padding: 24, textAlign: "center" }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
            Something went wrong / 界面发生错误
          </div>
          <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 16, wordBreak: "break-word" }}>
            {String(this.state.error.message || this.state.error)}
          </div>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: "8px 20px", borderRadius: 8, border: "1px solid #374151",
              background: "#1f2937", color: "#e5e7eb", cursor: "pointer", fontSize: 13,
            }}
          >
            Reload / 重新加载
          </button>
        </div>
      </div>
    );
  }
}
