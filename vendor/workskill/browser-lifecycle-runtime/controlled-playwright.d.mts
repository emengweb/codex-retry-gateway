import type { Browser, BrowserType, LaunchOptions } from "playwright";

export const CONTROLLED_BROWSER_OWNERSHIP: unique symbol;

export interface ControlledBrowserOwnership {
  taskId: string;
  registryPath: string;
  profilePath: string;
  rootPid: number;
  processGroupId?: number;
}

export interface ControlledBrowser extends Browser {
  readonly [CONTROLLED_BROWSER_OWNERSHIP]: ControlledBrowserOwnership;
  emit(event: "disconnected"): boolean;
}

export const chromium: Pick<BrowserType<Browser>, "executablePath"> & {
  launch(options?: LaunchOptions): Promise<ControlledBrowser>;
};
