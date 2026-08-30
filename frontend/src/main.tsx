import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { I18nProvider } from "./i18n";
import { ThemeProvider, applyTheme, initialTheme } from "./theme";
import { ToastProvider } from "./components/Toast";
import "./index.css";
import "./work-result.css";
import "./agent-task.css";
import "./execution-review.css";
import "./agent/agent-shell.css";
import "./agent/agent-state.css";
import "./agent/command-center.css";
import "./agent/agent-runtime.css";

applyTheme(initialTheme());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <I18nProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </I18nProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
