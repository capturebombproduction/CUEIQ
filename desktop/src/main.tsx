import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { Toaster } from "sonner";
import { App } from "~/App";
import "./index.css";

// HashRouter: works under file:// (Electron) and in the browser dev server alike.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
      <Toaster richColors position="top-center" />
    </HashRouter>
  </React.StrictMode>
);
