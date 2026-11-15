import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { installLockdown } from "./ui/lockdown";

// Release build only: no browser right-click menu or browser shortcuts (the dev build keeps them for debugging).
installLockdown(document, !import.meta.env.DEV);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
