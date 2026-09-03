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
    // v1.16 — theme-aware through the same tokens as the app (with system
    // fallbacks when the token file itself failed to load). Reload stays:
    // this is the last resort after a render crash, not a transport action.
    return (
      <div style={{
        display: "flex", height: "100vh", alignItems: "center", justifyContent: "center",
        background: "var(--canvas, #0f0f0f)", color: "var(--gray-200, #d6d6d6)",
        fontFamily: "system-ui, sans-serif",
      }}>
        <div style={{ maxWidth: 480, padding: 24, textAlign: "center" }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8, color: "var(--gray-100, #f2f2f2)" }}>
            Something went wrong / 界面发生错误
          </div>
          <div style={{ fontSize: 12, color: "var(--gray-500, #9e9e9e)", marginBottom: 16, wordBreak: "break-word" }}>
            {String(this.state.error.message || this.state.error)}
          </div>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: "8px 20px", borderRadius: 8, border: "1px solid var(--edge-strong, #3d3d3d)",
              background: "var(--elevated, #292929)", color: "var(--gray-100, #f2f2f2)", cursor: "pointer", fontSize: 13,
            }}
          >
            Reload window / 重新加载窗口
          </button>
        </div>
      </div>
    );
  }
}
