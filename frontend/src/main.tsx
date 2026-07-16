import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { I18nProvider } from "./i18n";
import { ThemeProvider, applyTheme, initialTheme } from "./theme";
import "./index.css";

// Apply the saved theme before first paint to avoid a flash.
applyTheme(initialTheme());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <I18nProvider>
          <App />
        </I18nProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
