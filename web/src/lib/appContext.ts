import { createContext, useContext, useEffect, useState } from "react";
import type { DeployState } from "./data";
import type { Session } from "./wallet";

export type AppState = {
  session: Session | null;
  setSession: (s: Session | null) => void;
  toast: (msg: string, kind?: "ok" | "err") => void;
  deploy: DeployState | undefined;
  refreshDeploy: () => void;
  /** Ask the user to connect; resolves to the session or null. */
  requireWallet: () => Session | null;
};

export const AppCtx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(AppCtx);
  if (!v) throw new Error("AppCtx missing");
  return v;
}

export type Route = { page: "explore" } | { page: "launch" } | { page: "token"; id: number } | { page: "deploy" } | { page: "about" };

function parse(hash: string): Route {
  const h = hash.replace(/^#\/?/, "");
  const [a, b] = h.split("/");
  if (a === "launch") return { page: "launch" };
  if (a === "deploy") return { page: "deploy" };
  if (a === "about") return { page: "about" };
  if (a === "t" && b !== undefined && /^\d+$/.test(b)) return { page: "token", id: Number(b) };
  return { page: "explore" };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parse(location.hash));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export const go = (path: string) => {
  location.hash = path;
};
