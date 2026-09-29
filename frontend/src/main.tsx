import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { I18nProvider } from "./i18n";
import { ThemeProvider, applyTheme, initialTheme } from "./theme";
import { ToastProvider } from "./components/Toast";
import { initSidecarBaseUrl } from "./config";
import "./index.css";
import "./styles/components.css";
import "./styles/app.css";
import "./styles/document.css";
import "./styles/markdown.css";

applyTheme(initialTheme());

void initSidecarBaseUrl().finally(() => {
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
    </React.StrictMode>,
  );
});
