import type { AppConfig } from "./config.js";
import { BrowserManager } from "./browser.js";
import { AuthManager } from "./auth.js";

/** Bundle of shared services handed to every tool. */
export interface AppContext {
  cfg: AppConfig;
  browser: BrowserManager;
  auth: AuthManager;
}

export function createContext(cfg: AppConfig): AppContext {
  const browser = new BrowserManager(cfg);
  const auth = new AuthManager(cfg, browser);
  return { cfg, browser, auth };
}
