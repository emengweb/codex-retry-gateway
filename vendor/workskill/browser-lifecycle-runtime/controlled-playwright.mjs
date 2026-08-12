import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium as playwrightChromium } from "playwright";
import { adoptOwnedProcess } from "./controlled-browser-process.mjs";

export const CONTROLLED_BROWSER_OWNERSHIP = Symbol.for("workskill.controlledBrowserOwnership");

export const chromium = {
  executablePath: (...args) => playwrightChromium.executablePath(...args),
  async launch(options = {}) {
    validateLaunchOptions(options);
    if (process.platform === "win32") {
      throw new Error("Controlled Chromium on Windows requires a per-task Job Object adapter and is not enabled by this runtime");
    }
    const launchId = randomUUID();
    const taskId = process.env.WORKSKILL_TASK_ID ?? `web-smoke-${process.pid}-${launchId}`;
    const ownershipRoot = process.env.WORKSKILL_BROWSER_OWNERSHIP_DIR ?? join(tmpdir(), "workskill-browser-ownership");
    await mkdir(ownershipRoot, { recursive: true });
    const registryPath = join(ownershipRoot, `${taskId.replace(/[^a-zA-Z0-9_.-]/g, "_")}-${launchId}.json`);
    const timeoutMs = options.timeout === undefined || options.timeout === 0 ? 30_000 : options.timeout;
    let connectedBrowser;
    let ownedProcess;
    let controlDisconnected = false;
    try {
      connectedBrowser = await playwrightChromium.launch({ ...options, timeout: timeoutMs });
      connectedBrowser.once("disconnected", () => {
        controlDisconnected = true;
        const timer = setTimeout(() => { void ownedProcess?.close().catch(() => {}); }, 100);
        timer.unref?.();
      });
      const launched = inspectPlaywrightLaunch(connectedBrowser);
      ownedProcess = await adoptOwnedProcess({
        taskId,
        childProcess: launched.childProcess,
        executablePath: launched.childProcess.spawnfile,
        profilePath: launched.profilePath,
        registryPath,
        requiredCommandFragments: [`--user-data-dir=${launched.profilePath}`],
        gracefulCloseTimeoutMs: 2_000,
        terminationGraceMs: 2_000,
        cleanupTimeoutMs: 2_000,
        watchdog: true,
        gracefulClose: async () => {
          if (connectedBrowser?.isConnected()) await connectedBrowser.close();
        },
        emergencyClose: async () => {
          if (connectedBrowser?.isConnected()) await connectedBrowser.close();
        },
      });
      if (controlDisconnected) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        await ownedProcess.close();
        throw new Error("Controlled Chromium disconnected before ownership setup completed");
      }
    } catch (error) {
      await ownedProcess?.close().catch(() => {});
      await connectedBrowser?.close().catch(() => {});
      throw error;
    }
    return new Proxy(connectedBrowser, {
      get(target, property) {
        if (property === "close") return () => ownedProcess.close();
        if (property === CONTROLLED_BROWSER_OWNERSHIP) {
          return { taskId, registryPath, profilePath: ownedProcess.profilePath, rootPid: ownedProcess.pid, processGroupId: ownedProcess.processGroupId };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  },
};

function inspectPlaywrightLaunch(browser) {
  const implementation = browser?._connection?.toImpl?.(browser);
  const process = implementation?.options?.browserProcess?.process;
  const profileArgument = process?.spawnargs?.find((argument) => argument.startsWith("--user-data-dir="));
  const profilePath = implementation?.options?.userDataDir ?? profileArgument?.slice("--user-data-dir=".length);
  if (!process?.pid || typeof process.spawnfile !== "string" || typeof profilePath !== "string") {
    throw new Error("Controlled Chromium could not inspect Playwright's local browser ownership");
  }
  return { childProcess: process, profilePath };
}

function validateLaunchOptions(options) {
  const supported = new Set(["args", "cwd", "env", "executablePath", "headless", "timeout"]);
  const unsupported = Object.keys(options).filter((key) => !supported.has(key));
  if (unsupported.length > 0) throw new Error(`Controlled Chromium does not support launch option(s): ${unsupported.join(", ")}`);
  if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout < 0)) {
    throw new Error("Controlled Chromium timeout must be a non-negative finite number");
  }
  if (options.args !== undefined && !Array.isArray(options.args)) throw new Error("Controlled Chromium args must be an array");
  for (const argument of options.args ?? []) {
    if (/^--(?:user-data-dir|remote-debugging-(?:port|pipe))(?:=|$)/.test(argument)) {
      throw new Error(`Controlled Chromium owns launch argument ${argument.split("=", 1)[0]}`);
    }
  }
}
