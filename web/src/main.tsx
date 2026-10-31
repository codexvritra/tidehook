import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { IS_LOCAL } from "./lib/chain";

async function boot() {
  // Dev-only test wallet for exercising the real UI against a local fork; stripped from production builds.
  if (import.meta.env.DEV && IS_LOCAL && import.meta.env.VITE_DEV_WALLET === "anvil") {
    const { installDevWallet } = await import("./lib/devWallet");
    installDevWallet();
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
boot();
