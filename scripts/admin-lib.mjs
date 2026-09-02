#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  findCompatibleClientUpstream,
  getDefaultClientConfigPaths,
  installClientConfigs,
  restoreClientConfigs,
} from "./client-configs.mjs";

export const DEFAULT_STATE_ROOT = path.join(os.homedir(), ".codex-retry-gateway");
export const DEFAULT_CODEX_CONFIG_PATH = path.join(os.homedir(), ".codex", "config.toml");
export const DEFAULT_LISTEN_HOST = "127.0.0.1";
export const DEFAULT_LISTEN_PORT = 4610;
export const DEFAULT_HEALTH_PATH = "/__codex_retry_gateway/health";
export const DEFAULT_REQUEST_BODY_LIMIT_BYTES = 100 * 1024 * 1024;
export const LEGACY_REQUEST_BODY_LIMIT_BYTES = 10 * 1024 * 1024;
export const DEFAULT_INTERCEPT_RULE_MODE = "reasoning_tokens";
export const FINAL_ONLY_HIGH_XHIGH_INTERCEPT_RULE_MODE = "final_answer_only_high_xhigh";
export const NONE_INTERCEPT_RULE_MODE = "none";
const INTERCEPT_RULE_MODES = new Set([
  DEFAULT_INTERCEPT_RULE_MODE,
  FINAL_ONLY_HIGH_XHIGH_INTERCEPT_RULE_MODE,
  NONE_INTERCEPT_RULE_MODE,
]);
export const MANUAL_REASONING_MATCH_MODE = "manual";
export const FORMULA_518N_MINUS_2_REASONING_MATCH_MODE = "formula_518n_minus_2";
export const DEFAULT_REASONING_MATCH_MODE = FORMULA_518N_MINUS_2_REASONING_MATCH_MODE;
export const DEFAULT_CONTINUATION_MARKER_TEXT = "Continue thinking...";
export const CONTINUATION_RECOVERY_STREAM_ACTION = "continuation_recovery";
export const DEFAULT_STREAM_ACTION = CONTINUATION_RECOVERY_STREAM_ACTION;
export const DEFAULT_GUARD_RETRY_ATTEMPTS = 5;
const MAX_GUARD_RETRY_ATTEMPTS = 32;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const TRANSIENT_RETRY_MAX_DELAY_MS = 10 * 60 * 1000;
const UPSTREAM_ERROR_ACTIONS = new Set([
  "pass_through",
  "return_502",
  "retry_then_pass_through",
  "retry_then_502",
]);
const FIRST_PROGRESS_ACTIONS = new Set(["return_502", "retry_then_502"]);
const DEFAULT_CAPACITY_ERROR_ACTION = "retry_then_pass_through";
const DEFAULT_HTTP_429_ACTION = "pass_through";
const DEFAULT_LATENCY_GUARD = {
  enabled: false,
  first_progress_timeout_ms: 0,
  first_progress_action: "return_502",
  total_timeout_ms: 0,
};
const DEFAULT_TRANSIENT_RETRY = {
  enabled: true,
  initial_delay_ms: 1000,
  max_delay_ms: TRANSIENT_RETRY_MAX_DELAY_MS,
};

function escapeRegExp(value) {
  return `${value}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeInterceptRuleMode(value) {
  const normalized = `${value || ""}`.trim().toLowerCase();
  return INTERCEPT_RULE_MODES.has(normalized) ? normalized : DEFAULT_INTERCEPT_RULE_MODE;
}

function normalizeReasoningMatchMode(value) {
  const normalized = `${value || ""}`.trim().toLowerCase();
  return normalized === MANUAL_REASONING_MATCH_MODE
    ? MANUAL_REASONING_MATCH_MODE
    : FORMULA_518N_MINUS_2_REASONING_MATCH_MODE;
}

function normalizeContinuationMarkerText(value) {
  if (typeof value !== "string") {
    return DEFAULT_CONTINUATION_MARKER_TEXT;
  }
  return value.trim() ? value : DEFAULT_CONTINUATION_MARKER_TEXT;
}

function isLegacyContinuationRuleMode(value) {
  return `${value || ""}`.trim().toLowerCase() === CONTINUATION_RECOVERY_STREAM_ACTION;
}

function normalizeUpstreamErrorAction(value, fallback) {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  return UPSTREAM_ERROR_ACTIONS.has(normalized) ? normalized : fallback;
}

function normalizeLatencyGuardInteger(value, fallback) {
  if (value === undefined || value === null || `${value}`.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= MAX_TIMER_DELAY_MS
    ? parsed
    : fallback;
}

function normalizeLatencyGuardConfig(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const normalized = {
    enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_LATENCY_GUARD.enabled,
    first_progress_timeout_ms: normalizeLatencyGuardInteger(
      source.first_progress_timeout_ms,
      DEFAULT_LATENCY_GUARD.first_progress_timeout_ms,
    ),
    first_progress_action: normalizeUpstreamErrorAction(
      source.first_progress_action,
      DEFAULT_LATENCY_GUARD.first_progress_action,
    ),
    total_timeout_ms: normalizeLatencyGuardInteger(
      source.total_timeout_ms,
      DEFAULT_LATENCY_GUARD.total_timeout_ms,
    ),
  };
  if (!FIRST_PROGRESS_ACTIONS.has(normalized.first_progress_action)) {
    normalized.first_progress_action = DEFAULT_LATENCY_GUARD.first_progress_action;
  }
  if (
    normalized.enabled &&
    normalized.first_progress_timeout_ms === 0 &&
    normalized.total_timeout_ms === 0
  ) {
    normalized.enabled = false;
  }
  return normalized;
}

function normalizeTransientRetryConfig(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const initialDelayMs = normalizeLatencyGuardInteger(
    source.initial_delay_ms,
    DEFAULT_TRANSIENT_RETRY.initial_delay_ms,
  );
  const maxDelayMs = normalizeLatencyGuardInteger(
    source.max_delay_ms,
    DEFAULT_TRANSIENT_RETRY.max_delay_ms,
  );
  const cappedInitialDelayMs = Math.min(TRANSIENT_RETRY_MAX_DELAY_MS, initialDelayMs);
  const cappedMaxDelayMs = Math.min(TRANSIENT_RETRY_MAX_DELAY_MS, maxDelayMs);
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_TRANSIENT_RETRY.enabled,
    initial_delay_ms: Math.min(cappedInitialDelayMs, cappedMaxDelayMs),
    max_delay_ms: cappedMaxDelayMs,
  };
}

export function parseOptions(argv, { booleanFlags = [] } = {}) {
  const options = { _: [] };
  const booleanSet = new Set(booleanFlags);

  for (let index = 2; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) {
      options._.push(current);
      continue;
    }

    const flagName = current.slice(2);
    const optionKey = flagName.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (booleanSet.has(flagName)) {
      options[optionKey] = true;
      continue;
    }

    const nextValue = argv[index + 1];
    if (nextValue === undefined) {
      throw new Error(`Missing value for --${flagName}`);
    }
    options[optionKey] = nextValue;
    index += 1;
  }

  return options;
}

export function getGatewayRoot() {
  return path.resolve(import.meta.dirname, "..");
}

export function getGatewayStatePaths(stateRoot = DEFAULT_STATE_ROOT) {
  return {
    stateRoot,
    configDir: path.join(stateRoot, "config"),
    logDir: path.join(stateRoot, "logs"),
    backupDir: path.join(stateRoot, "backups"),
    configPath: path.join(stateRoot, "config", "config.json"),
    logPath: path.join(stateRoot, "logs", "gateway.log"),
    statePath: path.join(stateRoot, "state.json"),
    pidPath: path.join(stateRoot, "gateway.pid"),
  };
}

export function getGatewayBaseUrl(listenHost, listenPort) {
  return `http://${listenHost}:${listenPort}`;
}

export function getGatewayBaseUrlFromConfig(gatewayConfig) {
  if (!gatewayConfig) {
    return null;
  }
  if (!gatewayConfig.listen_host || gatewayConfig.listen_port === undefined || gatewayConfig.listen_port === null) {
    return null;
  }
  return getGatewayBaseUrl(`${gatewayConfig.listen_host}`, Number.parseInt(`${gatewayConfig.listen_port}`, 10));
}

export async function ensureDirectory(targetPath) {
  await mkdir(targetPath, { recursive: true });
}

export function normalizeRequestBodyLimitBytes(value, fallback = DEFAULT_REQUEST_BODY_LIMIT_BYTES) {
  const parsed = Number.parseInt(`${value}`, 10);
  const normalized = Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  return normalized === LEGACY_REQUEST_BODY_LIMIT_BYTES ? DEFAULT_REQUEST_BODY_LIMIT_BYTES : normalized;
}

export async function writeUtf8File(targetPath, content) {
  const parent = path.dirname(targetPath);
  if (parent && parent !== ".") {
    await ensureDirectory(parent);
  }
  await writeFile(targetPath, content, "utf8");
}

export async function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const raw = await readFile(filePath, "utf8");
  if (!raw.trim()) {
    return null;
  }
  return JSON.parse(raw);
}

export async function writeJsonFile(filePath, value) {
  await writeUtf8File(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalizeJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJsonValue(item));
  }
  if (value && typeof value === "object") {
    const normalized = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = canonicalizeJsonValue(value[key]);
    }
    return normalized;
  }
  return value;
}

function jsonValuesEqual(left, right) {
  return JSON.stringify(canonicalizeJsonValue(left)) ===
    JSON.stringify(canonicalizeJsonValue(right));
}

function isFilePath(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    return false;
  }
  try {
    const fileStats = fs.lstatSync(filePath);
    return fileStats.isFile() && !fileStats.isSymbolicLink();
  } catch {
    return false;
  }
}

function installStateMatchesProvider(state, providerName, codexConfigPath) {
  if (!state?.provider_name || !state?.codex_config_path) {
    return false;
  }
  const normalizePath = (value) => {
    const resolved = path.resolve(`${value}`);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return (
    `${state.provider_name}` === `${providerName}` &&
    normalizePath(state.codex_config_path) === normalizePath(codexConfigPath)
  );
}

async function readLiveGatewayPid(pidPath) {
  if (!fs.existsSync(pidPath)) {
    return null;
  }
  const raw = (await readFile(pidPath, "utf8")).trim();
  const processId = Number.parseInt(raw, 10);
  return Number.isInteger(processId) && isProcessAlive(processId) ? processId : null;
}

async function isGatewayHealthy(gatewayConfig, expectedProcessId = null, timeoutMs = 1500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const baseUrl = getGatewayBaseUrlFromConfig(gatewayConfig);
    if (!baseUrl) {
      return false;
    }
    const response = await fetch(`${baseUrl}${gatewayConfig.health_path || DEFAULT_HEALTH_PATH}`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return false;
    }
    if (expectedProcessId === null) {
      return true;
    }
    const payload = await response.json();
    return Number(payload?.process_id) === expectedProcessId;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function readGatewayRuntimeConfig(baseUrl, expectedProcessId, timeoutMs = 1500) {
  if (!baseUrl || !Number.isInteger(expectedProcessId)) {
    return null;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `${`${baseUrl}`.replace(/\/+$/, "")}/__codex_retry_gateway/api/status`,
      { signal: controller.signal },
    );
    if (!response.ok) {
      return null;
    }
    const payload = await response.json();
    if (Number(payload?.process_id) !== expectedProcessId || !payload?.config) {
      return null;
    }
    return cloneJsonValue(payload.config);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function createUniqueBackupPath(backupDir) {
  const timestamp = new Date().toISOString().replace(/\D/g, "");
  let suffix = 0;
  while (true) {
    const suffixText = suffix === 0 ? "" : `-${suffix}`;
    const candidate = path.join(backupDir, `config-${timestamp}${suffixText}.toml`);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
    suffix += 1;
  }
}

export async function getCodexProviderContext(codexConfigPath) {
  const content = await readFile(codexConfigPath, "utf8");
  const providerMatch = content.match(/^\s*model_provider\s*=\s*"([^"]+)"\s*$/m);
  if (!providerMatch) {
    throw new Error(`model_provider was not found in ${codexConfigPath}`);
  }

  const providerName = providerMatch[1];
  const sectionHeaderRegex = new RegExp(`^\\[model_providers\\.${escapeRegExp(providerName)}\\]\\s*$`, "m");
  const sectionHeaderMatch = sectionHeaderRegex.exec(content);
  if (!sectionHeaderMatch) {
    throw new Error(`[model_providers.${providerName}] was not found in ${codexConfigPath}`);
  }

  const sectionIndex = sectionHeaderMatch.index;
  const headerEndIndex = sectionIndex + sectionHeaderMatch[0].length;
  const remainder = content.slice(headerEndIndex);
  const nextSectionMatch = /^\[.*$/m.exec(remainder);
  const sectionEndIndex = nextSectionMatch ? headerEndIndex + nextSectionMatch.index : content.length;
  const sectionText = content.slice(sectionIndex, sectionEndIndex);
  const baseUrlMatch = sectionText.match(/^\s*base_url\s*=\s*"([^"]+)"\s*$/m);
  if (!baseUrlMatch) {
    throw new Error(`base_url was not found in [model_providers.${providerName}]`);
  }

  return {
    content,
    providerName,
    sectionText,
    sectionIndex,
    sectionLength: sectionText.length,
    currentBaseUrl: baseUrlMatch[1],
    baseUrlLineText: baseUrlMatch[0],
  };
}

export async function setCodexProviderBaseUrl({ codexConfigPath, providerName, newBaseUrl }) {
  const context = await getCodexProviderContext(codexConfigPath);
  if (context.providerName !== providerName) {
    throw new Error(`model_provider changed unexpectedly: expected ${providerName}, actual ${context.providerName}`);
  }

  let replaced = false;
  const updatedSection = context.sectionText.replace(
    /^(\s*base_url\s*=\s*")([^"]*)("\s*)$/m,
    (_, prefix, __existing, suffix) => {
      replaced = true;
      return `${prefix}${newBaseUrl}${suffix}`;
    },
  );
  if (!replaced) {
    throw new Error(`base_url was not found in [model_providers.${providerName}]`);
  }

  const updatedContent =
    context.content.slice(0, context.sectionIndex) +
    updatedSection +
    context.content.slice(context.sectionIndex + context.sectionLength);

  await writeUtf8File(codexConfigPath, updatedContent);
}

export function normalizeIntArray(values, fallback = [516, 1034, 1552]) {
  const source = values === undefined || values === null ? fallback : values;
  const queue = Array.isArray(source) ? source.flat(Infinity) : [source];
  const normalized = queue
    .map((value) => (typeof value === "string" ? value.split(/[\s,]+/).filter(Boolean) : [value]))
    .flat()
    .map((value) => Number.parseInt(`${value}`, 10))
    .filter((value) => Number.isInteger(value));

  return normalized.length > 0 ? [...new Set(normalized)] : [...fallback];
}

export function normalizeStringArray(values, fallback = []) {
  const source = values === undefined || values === null ? fallback : values;
  const queue = Array.isArray(source) ? source.flat(Infinity) : [source];
  const normalized = queue
    .flatMap((value) => `${value ?? ""}`.split(/[\s,]+/))
    .map((value) => value.trim())
    .filter(Boolean);

  return normalized.length > 0 ? [...new Set(normalized)] : [...fallback];
}

function normalizeGuardRetryAttempts(value, fallback = DEFAULT_GUARD_RETRY_ATTEMPTS) {
  if (value === undefined || value === null || `${value}`.trim() === "") {
    return fallback;
  }
  const text = `${value}`.trim();
  const parsed = Number.parseInt(text, 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_GUARD_RETRY_ATTEMPTS && String(parsed) === text
    ? parsed
    : fallback;
}

export function isProcessAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitGatewayHealth({
  listenHost,
  listenPort,
  healthPath,
  timeoutSeconds = 10,
  expectedProcessId = null,
}) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const healthUrl = `${getGatewayBaseUrl(listenHost, listenPort)}${healthPath}`;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
      if (response.status === 200) {
        if (expectedProcessId === null) {
          return response;
        }
        const payload = await response.json();
        if (Number(payload?.process_id) === expectedProcessId) {
          return response;
        }
      }
    } catch {
      // ignore and retry
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Gateway health check timed out: ${healthUrl}`);
}

async function readTail(filePath, lineCount = 20) {
  if (!fs.existsSync(filePath)) {
    return "";
  }
  const raw = await readFile(filePath, "utf8");
  return raw.split(/\r?\n/).slice(-lineCount).join("\n").trim();
}

function openUrl(url) {
  let command;
  let args;
  if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

export async function stopGateway({
  stateRoot = DEFAULT_STATE_ROOT,
  quiet = false,
  gatewayConfig: expectedGatewayConfig = null,
}) {
  const paths = getGatewayStatePaths(stateRoot);
  if (!fs.existsSync(paths.pidPath)) {
    return quiet ? null : "No running gateway PID file was found.";
  }

  const pidRaw = (await readFile(paths.pidPath, "utf8")).trim();
  if (!pidRaw) {
    await rm(paths.pidPath, { force: true });
    return quiet ? null : "Gateway PID file was empty and has been removed.";
  }

  const gatewayPid = Number.parseInt(pidRaw, 10);
  if (Number.isInteger(gatewayPid) && isProcessAlive(gatewayPid)) {
    let gatewayConfig = expectedGatewayConfig || await readJsonFile(paths.configPath);
    if (!gatewayConfig) {
      const state = await readJsonFile(paths.statePath);
      gatewayConfig = await readGatewayRuntimeConfig(state?.gateway_base_url, gatewayPid);
    }
    const verifiedGatewayProcess =
      gatewayConfig && await isGatewayHealthy(gatewayConfig, gatewayPid);
    if (!verifiedGatewayProcess) {
      throw new Error(`Gateway PID could not be verified and was not stopped: ${gatewayPid}`);
    }
    try {
      process.kill(gatewayPid);
    } catch {
      // ignore first failure
    }

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && isProcessAlive(gatewayPid)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (isProcessAlive(gatewayPid)) {
      try {
        process.kill(gatewayPid, "SIGKILL");
      } catch {
        // ignore hard kill failure
      }
    }
  }

  await rm(paths.pidPath, { force: true });
  return quiet ? null : `Gateway stopped. PID=${gatewayPid}`;
}

export async function cleanupFailedGatewayStart({ processId, pidPath }) {
  if (Number.isInteger(processId) && isProcessAlive(processId)) {
    try {
      process.kill(processId);
    } catch {
      // 忽略第一次终止失败。
    }
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && isProcessAlive(processId)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (isProcessAlive(processId)) {
      try {
        process.kill(processId, "SIGKILL");
      } catch {
        // 忽略强制终止失败。
      }
      const hardKillDeadline = Date.now() + 1000;
      while (Date.now() < hardKillDeadline && isProcessAlive(processId)) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  if (!isProcessAlive(processId) && fs.existsSync(pidPath)) {
    try {
      const currentPid = Number.parseInt((await readFile(pidPath, "utf8")).trim(), 10);
      if (currentPid === processId) {
        await rm(pidPath, { force: true });
      }
    } catch {
      // 无法安全归属时保留 PID 文件。
    }
  }
}

export async function startGateway({
  stateRoot = DEFAULT_STATE_ROOT,
  configPath,
  logPath,
  restartIfRunning = false,
  writePidFile = writeUtf8File,
}) {
  const paths = getGatewayStatePaths(stateRoot);
  const effectiveConfigPath = configPath || paths.configPath;
  const effectiveLogPath = logPath || paths.logPath;

  if (!fs.existsSync(effectiveConfigPath)) {
    throw new Error(`Gateway config file was not found: ${effectiveConfigPath}`);
  }

  await ensureDirectory(path.dirname(effectiveLogPath));

  const gatewayConfig = await readJsonFile(effectiveConfigPath);
  if (!gatewayConfig) {
    throw new Error(`Gateway config file could not be read: ${effectiveConfigPath}`);
  }

  if (fs.existsSync(paths.pidPath)) {
    const existingPidRaw = (await readFile(paths.pidPath, "utf8")).trim();
    if (existingPidRaw) {
      const existingPid = Number.parseInt(existingPidRaw, 10);
      if (Number.isInteger(existingPid) && isProcessAlive(existingPid)) {
        if (await isGatewayHealthy(gatewayConfig, existingPid)) {
          if (restartIfRunning) {
            await stopGateway({ stateRoot, quiet: true });
          } else {
            return `Gateway is already running. PID=${existingPid}`;
          }
        } else {
          await rm(paths.pidPath, { force: true });
        }
      } else {
        await rm(paths.pidPath, { force: true });
      }
    }
  }

  const gatewayRoot = getGatewayRoot();
  const gatewayEntry = path.join(gatewayRoot, "gateway.mjs");
  if (!fs.existsSync(gatewayEntry)) {
    throw new Error(`Gateway entry file was not found: ${gatewayEntry}`);
  }

  const child = spawn(process.execPath, [gatewayEntry, "--config", effectiveConfigPath, "--log", effectiveLogPath], {
    cwd: gatewayRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  try {
    await writePidFile(paths.pidPath, `${child.pid}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!isProcessAlive(child.pid)) {
      const logTail = await readTail(effectiveLogPath, 20);
      throw new Error(`Gateway exited right after startup. PID=${child.pid}\n${logTail}`);
    }

    await waitGatewayHealth({
      listenHost: `${gatewayConfig.listen_host}`,
      listenPort: Number.parseInt(`${gatewayConfig.listen_port}`, 10),
      healthPath: `${gatewayConfig.health_path || DEFAULT_HEALTH_PATH}`,
      expectedProcessId: child.pid,
    });
  } catch (error) {
    try {
      await cleanupFailedGatewayStart({ processId: child.pid, pidPath: paths.pidPath });
    } catch {
      // 保留原始启动错误。
    }
    throw error;
  }

  return `Gateway started. PID=${child.pid}. Listen=${getGatewayBaseUrl(gatewayConfig.listen_host, gatewayConfig.listen_port)}`;
}

function buildGatewayInstallConfig({
  existingGatewayConfig,
  listenHost,
  listenPort,
  upstreamBaseUrl,
}) {
  const defaultEndpoints = ["/responses", "/chat/completions", "/v1/responses", "/v1/chat/completions"];
  const mergedEndpoints = [];
  for (const endpoint of [
    ...normalizeStringArray(existingGatewayConfig?.endpoints, []),
    ...defaultEndpoints,
  ]) {
    if (!mergedEndpoints.includes(endpoint)) {
      mergedEndpoints.push(endpoint);
    }
  }

  const legacyContinuationRuleMode = isLegacyContinuationRuleMode(
    existingGatewayConfig?.intercept_rule_mode,
  );
  const retryUpstreamCapacityErrors = existingGatewayConfig?.retry_upstream_capacity_errors !== false;
  const legacyCapacityAction = retryUpstreamCapacityErrors
    ? DEFAULT_CAPACITY_ERROR_ACTION
    : "pass_through";
  return {
    listen_host: listenHost,
    listen_port: listenPort,
    upstream_base_url: upstreamBaseUrl,
    request_body_limit_bytes: normalizeRequestBodyLimitBytes(existingGatewayConfig?.request_body_limit_bytes),
    endpoints: mergedEndpoints,
    intercept_rule_mode: legacyContinuationRuleMode
      ? DEFAULT_INTERCEPT_RULE_MODE
      : normalizeInterceptRuleMode(existingGatewayConfig?.intercept_rule_mode),
    reasoning_match_mode: normalizeReasoningMatchMode(existingGatewayConfig?.reasoning_match_mode),
    reasoning_equals: normalizeIntArray(existingGatewayConfig?.reasoning_equals, [516, 1034, 1552]),
    intercept_streaming:
      existingGatewayConfig?.intercept_streaming === undefined ? true : Boolean(existingGatewayConfig.intercept_streaming),
    intercept_non_streaming:
      existingGatewayConfig?.intercept_non_streaming === undefined
        ? true
        : Boolean(existingGatewayConfig.intercept_non_streaming),
    non_stream_status_code:
      existingGatewayConfig?.non_stream_status_code === undefined || existingGatewayConfig?.non_stream_status_code === null
        ? 502
        : Number.parseInt(`${existingGatewayConfig.non_stream_status_code}`, 10),
    guard_retry_attempts: normalizeGuardRetryAttempts(existingGatewayConfig?.guard_retry_attempts),
    retry_upstream_capacity_errors: retryUpstreamCapacityErrors,
    capacity_error_action: normalizeUpstreamErrorAction(
      existingGatewayConfig?.capacity_error_action,
      legacyCapacityAction,
    ),
    http_429_action: normalizeUpstreamErrorAction(
      existingGatewayConfig?.http_429_action,
      DEFAULT_HTTP_429_ACTION,
    ),
    transient_retry: normalizeTransientRetryConfig(existingGatewayConfig?.transient_retry),
    latency_guard: normalizeLatencyGuardConfig(existingGatewayConfig?.latency_guard),
    stream_action: legacyContinuationRuleMode
      ? CONTINUATION_RECOVERY_STREAM_ACTION
      : existingGatewayConfig?.stream_action || DEFAULT_STREAM_ACTION,
    continuation_marker_text: normalizeContinuationMarkerText(
      existingGatewayConfig?.continuation_marker_text,
    ),
    log_match: existingGatewayConfig?.log_match === undefined ? true : Boolean(existingGatewayConfig.log_match),
    health_path: existingGatewayConfig?.health_path || DEFAULT_HEALTH_PATH,
  };
}

function isRestorableTargetPath(filePath) {
  if (!filePath) {
    return true;
  }
  try {
    const fileStats = fs.lstatSync(filePath);
    return fileStats.isFile() && !fileStats.isSymbolicLink();
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

function buildClientRestoreRollbackRecords(records) {
  return records.map((record) => ({
    ...record,
    originalBaseUrl: record.gatewayBaseUrl,
    gatewayBaseUrl: record.originalBaseUrl,
  }));
}

function getClientConfigRecordKey(record) {
  return `${record.filePath || ""}\u0000${JSON.stringify(record.fieldPath || [])}`;
}

async function installManagedClientConfigs({
  clientConfigPaths,
  upstreamBaseUrl,
  gatewayBaseUrl,
  backupDir,
  existingClientConfigs,
}) {
  const result = await installClientConfigs({
    clientConfigPaths,
    upstreamBaseUrl,
    gatewayBaseUrl,
    backupDir,
  });
  const existingRecords = Array.isArray(existingClientConfigs?.records)
    ? existingClientConfigs.records
    : [];
  const records = [...existingRecords];
  const knownRecords = new Set(records.map(getClientConfigRecordKey));
  for (const record of result.records) {
    if (!knownRecords.has(getClientConfigRecordKey(record))) {
      records.push(record);
      knownRecords.add(getClientConfigRecordKey(record));
    }
  }
  if (result.records.length === 0) {
    return {
      newRecords: [],
      state: existingClientConfigs || null,
    };
  }
  return {
    newRecords: result.records,
    state: {
      records,
      skipped: result.skipped,
      updated_at: new Date().toISOString(),
    },
  };
}

async function applyInstallForCurrentProvider({
  codexConfigPath = DEFAULT_CODEX_CONFIG_PATH,
  clientConfigPaths = getDefaultClientConfigPaths(),
  stateRoot = DEFAULT_STATE_ROOT,
  listenHost = DEFAULT_LISTEN_HOST,
  listenPort = DEFAULT_LISTEN_PORT,
}) {
  const paths = getGatewayStatePaths(stateRoot);
  await ensureDirectory(paths.stateRoot);
  await ensureDirectory(paths.configDir);
  await ensureDirectory(paths.logDir);
  await ensureDirectory(paths.backupDir);

  if (!fs.existsSync(codexConfigPath)) {
    throw new Error(`Codex config file was not found: ${codexConfigPath}`);
  }

  const providerContext = await getCodexProviderContext(codexConfigPath);
  const localGatewayBaseUrl = getGatewayBaseUrl(listenHost, listenPort);
  const existingState = await readJsonFile(paths.statePath);
  const existingGatewayConfig = await readJsonFile(paths.configPath);
  const existingStateMatchesProvider = installStateMatchesProvider(
    existingState,
    providerContext.providerName,
    codexConfigPath,
  );

  let originalBaseUrl = providerContext.currentBaseUrl;
  if (providerContext.currentBaseUrl === localGatewayBaseUrl) {
    if (
      !existingState?.original_base_url ||
      !existingStateMatchesProvider
    ) {
      throw new Error(
        "Provider already points to the local gateway, but no matching install state can supply original_base_url.",
      );
    }
    originalBaseUrl = `${existingState.original_base_url}`;
  }

  if (originalBaseUrl === localGatewayBaseUrl) {
    throw new Error("A real upstream_base_url could not be determined.");
  }

  const existingBackupPath =
    existingStateMatchesProvider && existingState?.latest_backup_path
      ? `${existingState.latest_backup_path}`
      : "";
  let backupPath = isFilePath(existingBackupPath) ? existingBackupPath : "";
  if (!backupPath && providerContext.currentBaseUrl !== localGatewayBaseUrl) {
    backupPath = createUniqueBackupPath(paths.backupDir);
    await copyFile(codexConfigPath, backupPath);
  }

  const gatewayConfig = buildGatewayInstallConfig({
    existingGatewayConfig,
    listenHost,
    listenPort,
    upstreamBaseUrl: originalBaseUrl,
  });

  const previousConfigContent = await readFile(codexConfigPath, "utf8");
  const previousGatewayConfigContent = fs.existsSync(paths.configPath)
    ? await readFile(paths.configPath, "utf8")
    : null;
  let gatewayConfigWritten = false;
  let clientConfigInstall = null;

  try {
    await writeJsonFile(paths.configPath, gatewayConfig);
    gatewayConfigWritten = true;
    await setCodexProviderBaseUrl({
      codexConfigPath,
      providerName: providerContext.providerName,
      newBaseUrl: localGatewayBaseUrl,
    });
    clientConfigInstall = await installManagedClientConfigs({
      clientConfigPaths,
      upstreamBaseUrl: originalBaseUrl,
      gatewayBaseUrl: localGatewayBaseUrl,
      backupDir: paths.backupDir,
      existingClientConfigs: existingState?.client_configs,
    });

    await startGateway({
      stateRoot,
      configPath: paths.configPath,
      logPath: paths.logPath,
      restartIfRunning: true,
    });

    const installedAt = new Date().toISOString();
    const state = {
      installed_at: installedAt,
      last_started_at: installedAt,
      codex_config_path: codexConfigPath,
      provider_name: providerContext.providerName,
      original_base_url: originalBaseUrl,
      gateway_base_url: localGatewayBaseUrl,
      gateway_config_path: paths.configPath,
      gateway_log_path: paths.logPath,
      gateway_pid_path: paths.pidPath,
      latest_backup_path: backupPath,
      state_root: paths.stateRoot,
      ...(clientConfigInstall.state ? { client_configs: clientConfigInstall.state } : {}),
    };
    await writeJsonFile(paths.statePath, state);

    return {
      provider: providerContext.providerName,
      upstream: originalBaseUrl,
      gateway: localGatewayBaseUrl,
      configPath: paths.configPath,
      backupPath,
    };
  } catch (error) {
    const rollbackErrors = [];
    if (clientConfigInstall?.newRecords?.length > 0) {
      try {
        const clientRestore = await restoreClientConfigs({
          records: clientConfigInstall.newRecords,
          gatewayBaseUrl: localGatewayBaseUrl,
        });
        if (clientRestore.conflicts.length > 0) {
          rollbackErrors.push(new Error("Client config rollback reported conflicts."));
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    try {
      await writeUtf8File(codexConfigPath, previousConfigContent);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    try {
      if (gatewayConfigWritten) {
        if (previousGatewayConfigContent === null) {
          await rm(paths.configPath, { force: true });
        } else {
          await writeUtf8File(paths.configPath, previousGatewayConfigContent);
        }
      }
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    try {
      await stopGateway({ stateRoot, quiet: true });
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], "Gateway install failed and rollback was incomplete.");
    }
    throw error;
  }
}

async function applyInstallForClientConfigs({
  clientConfigPaths = getDefaultClientConfigPaths(),
  stateRoot = DEFAULT_STATE_ROOT,
  listenHost = DEFAULT_LISTEN_HOST,
  listenPort = DEFAULT_LISTEN_PORT,
}) {
  const paths = getGatewayStatePaths(stateRoot);
  await ensureDirectory(paths.stateRoot);
  await ensureDirectory(paths.configDir);
  await ensureDirectory(paths.logDir);
  await ensureDirectory(paths.backupDir);

  const source = await findCompatibleClientUpstream({ clientConfigPaths });
  if (!source.upstreamBaseUrl) {
    throw new Error("No compatible pi, OpenCode, or ZCode provider with a usable upstream URL was found.");
  }

  const localGatewayBaseUrl = getGatewayBaseUrl(listenHost, listenPort);
  const existingState = await readJsonFile(paths.statePath);
  const existingGatewayConfig = await readJsonFile(paths.configPath);
  const gatewayConfig = buildGatewayInstallConfig({
    existingGatewayConfig,
    listenHost,
    listenPort,
    upstreamBaseUrl: source.upstreamBaseUrl,
  });
  const previousGatewayConfigContent = fs.existsSync(paths.configPath)
    ? await readFile(paths.configPath, "utf8")
    : null;
  const previousStateContent = fs.existsSync(paths.statePath)
    ? await readFile(paths.statePath, "utf8")
    : null;
  let clientConfigInstall = null;

  try {
    await writeJsonFile(paths.configPath, gatewayConfig);
    clientConfigInstall = await installManagedClientConfigs({
      clientConfigPaths,
      upstreamBaseUrl: source.upstreamBaseUrl,
      gatewayBaseUrl: localGatewayBaseUrl,
      backupDir: paths.backupDir,
      existingClientConfigs: existingState?.client_configs,
    });
    if (clientConfigInstall.state.records.length === 0) {
      throw new Error("No compatible client configuration could be redirected to the local gateway.");
    }
    await startGateway({
      stateRoot,
      configPath: paths.configPath,
      logPath: paths.logPath,
      restartIfRunning: true,
    });

    const installedAt = new Date().toISOString();
    await writeJsonFile(paths.statePath, {
      installed_at: installedAt,
      last_started_at: installedAt,
      original_base_url: source.upstreamBaseUrl,
      gateway_base_url: localGatewayBaseUrl,
      gateway_config_path: paths.configPath,
      gateway_log_path: paths.logPath,
      gateway_pid_path: paths.pidPath,
      state_root: paths.stateRoot,
      client_source: {
        client: source.client,
        provider_id: source.providerId,
        file_path: source.filePath,
      },
      client_configs: clientConfigInstall.state,
    });
    return {
      provider: `${source.client}:${source.providerId}`,
      upstream: source.upstreamBaseUrl,
      gateway: localGatewayBaseUrl,
      configPath: paths.configPath,
      backupPath: "",
    };
  } catch (error) {
    const rollbackErrors = [];
    try {
      await stopGateway({ stateRoot, quiet: true });
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (clientConfigInstall?.newRecords?.length > 0) {
      try {
        const clientRestore = await restoreClientConfigs({
          records: clientConfigInstall.newRecords,
          gatewayBaseUrl: localGatewayBaseUrl,
        });
        if (clientRestore.conflicts.length > 0) {
          rollbackErrors.push(new Error("Client config rollback reported conflicts."));
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    try {
      if (previousGatewayConfigContent === null) {
        await rm(paths.configPath, { force: true });
      } else {
        await writeUtf8File(paths.configPath, previousGatewayConfigContent);
      }
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    try {
      if (previousStateContent === null) {
        await rm(paths.statePath, { force: true });
      } else {
        await writeUtf8File(paths.statePath, previousStateContent);
      }
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], "Client-only gateway install failed and rollback was incomplete.");
    }
    throw error;
  }
}

async function launchUiForClientConfigs({
  clientConfigPaths = getDefaultClientConfigPaths(),
  stateRoot = DEFAULT_STATE_ROOT,
  listenHost = DEFAULT_LISTEN_HOST,
  listenPort = DEFAULT_LISTEN_PORT,
}) {
  const paths = getGatewayStatePaths(stateRoot);
  const requestedGatewayBaseUrl = getGatewayBaseUrl(listenHost, listenPort);
  const existingState = await readJsonFile(paths.statePath);
  let existingGatewayConfig = await readJsonFile(paths.configPath);
  const previousGatewayConfigContent = fs.existsSync(paths.configPath)
    ? await readFile(paths.configPath, "utf8")
    : null;
  let recoveredGatewayConfigWritten = false;
  const existingRecords = Array.isArray(existingState?.client_configs?.records)
    ? existingState.client_configs.records
    : [];

  if (existingState?.codex_config_path) {
    throw new Error(`Codex config file was not found: ${existingState.codex_config_path}`);
  }
  if (
    !existingGatewayConfig &&
    existingState?.original_base_url &&
    existingRecords.length > 0
  ) {
    const gatewayProcessId = await readLiveGatewayPid(paths.pidPath);
    existingGatewayConfig = await readGatewayRuntimeConfig(
      existingState.gateway_base_url,
      gatewayProcessId,
    );
    if (!existingGatewayConfig) {
      throw new Error("Client-only install state exists, but the gateway runtime configuration could not be verified.");
    }
  }
  if (
    existingGatewayConfig &&
    existingState?.original_base_url &&
    existingRecords.length > 0
  ) {
    const existingGatewayBaseUrl = getGatewayBaseUrlFromConfig(existingGatewayConfig);
    if (existingGatewayBaseUrl !== requestedGatewayBaseUrl) {
      throw new Error("Changing the gateway listen address for a client-only install requires restore before reinstall.");
    }
    const previousState = existingState;
    let clientConfigInstall = null;
    const gatewayProcessId = await readLiveGatewayPid(paths.pidPath);
    const gatewayHealthy =
      gatewayProcessId !== null &&
      await isGatewayHealthy(existingGatewayConfig, gatewayProcessId);
    try {
      if (previousGatewayConfigContent === null) {
        await writeJsonFile(paths.configPath, existingGatewayConfig);
        recoveredGatewayConfigWritten = true;
      }
      clientConfigInstall = await installManagedClientConfigs({
        clientConfigPaths,
        upstreamBaseUrl: existingState.original_base_url,
        gatewayBaseUrl: requestedGatewayBaseUrl,
        backupDir: paths.backupDir,
        existingClientConfigs: existingState.client_configs,
      });
      if (!gatewayHealthy) {
        await startGateway({
          stateRoot,
          configPath: paths.configPath,
          logPath: paths.logPath,
          restartIfRunning: false,
        });
      }
      const nextState = {
        ...existingState,
        last_started_at: gatewayHealthy
          ? existingState.last_started_at
          : new Date().toISOString(),
        ...(clientConfigInstall.state ? { client_configs: clientConfigInstall.state } : {}),
      };
      if (!jsonValuesEqual(previousState, nextState)) {
        await writeJsonFile(paths.statePath, nextState);
      }
    } catch (error) {
      const rollbackErrors = [];
      if (!gatewayHealthy) {
        try {
          await stopGateway({ stateRoot, quiet: true });
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (clientConfigInstall?.newRecords?.length > 0) {
        try {
          const clientRestore = await restoreClientConfigs({
            records: clientConfigInstall.newRecords,
            gatewayBaseUrl: requestedGatewayBaseUrl,
          });
          if (clientRestore.conflicts.length > 0) {
            rollbackErrors.push(new Error("Client config rollback reported conflicts."));
          }
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (recoveredGatewayConfigWritten) {
        try {
          if (previousGatewayConfigContent === null) {
            await rm(paths.configPath, { force: true });
          } else {
            await writeUtf8File(paths.configPath, previousGatewayConfigContent);
          }
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError([error, ...rollbackErrors], "Client-only reuse failed and rollback was incomplete.");
      }
      throw error;
    }
    return {
      mode: "reuse",
      gatewayBaseUrl: requestedGatewayBaseUrl,
    };
  }

  const installed = await applyInstallForClientConfigs({
    clientConfigPaths,
    stateRoot,
    listenHost,
    listenPort,
  });
  return {
    mode: "install",
    gatewayBaseUrl: installed.gateway,
  };
}

export async function installForCurrentProvider({
  codexConfigPath = DEFAULT_CODEX_CONFIG_PATH,
  clientConfigPaths = getDefaultClientConfigPaths(),
  stateRoot = DEFAULT_STATE_ROOT,
  listenHost = DEFAULT_LISTEN_HOST,
  listenPort = DEFAULT_LISTEN_PORT,
}) {
  const launchResult = await launchUi({
    codexConfigPath,
    clientConfigPaths,
    stateRoot,
    listenHost,
    listenPort,
    noOpen: true,
  });
  const paths = getGatewayStatePaths(stateRoot);
  const state = await readJsonFile(paths.statePath);
  const gatewayConfig = await readJsonFile(paths.configPath);
  const providerContext = fs.existsSync(codexConfigPath)
    ? await getCodexProviderContext(codexConfigPath)
    : null;
  return {
    provider: state?.provider_name || state?.client_source?.client || providerContext?.providerName || "client",
    upstream: state?.original_base_url || gatewayConfig?.upstream_base_url || "",
    gateway: getGatewayBaseUrlFromConfig(gatewayConfig) || launchResult.gatewayBaseUrl,
    configPath: paths.configPath,
    backupPath: state?.latest_backup_path ? `${state.latest_backup_path}` : "",
    reused: launchResult.mode === "reuse",
  };
}

export async function restoreCodexConfig({
  stateRoot = DEFAULT_STATE_ROOT,
  codexConfigPath = DEFAULT_CODEX_CONFIG_PATH,
}) {
  const paths = getGatewayStatePaths(stateRoot);
  const state = await readJsonFile(paths.statePath);
  if (!state) {
    throw new Error(`Install state file was not found: ${paths.statePath}`);
  }

  const clientRecords = Array.isArray(state?.client_configs?.records)
    ? state.client_configs.records
    : [];
  const managedCodexConfigPath = state.codex_config_path || null;
  const backupPath = `${state.latest_backup_path || ""}`;
  if (managedCodexConfigPath && !isFilePath(backupPath)) {
    throw new Error(`A restorable backup file was not found: ${backupPath}`);
  }
  if (managedCodexConfigPath && !isRestorableTargetPath(managedCodexConfigPath)) {
    throw new Error(`The Codex config path is not a regular file: ${managedCodexConfigPath}`);
  }
  if (!managedCodexConfigPath && clientRecords.length === 0) {
    throw new Error("The install state has no restorable client configuration.");
  }

  const clientRestorePreview = await restoreClientConfigs({
    records: clientRecords,
    gatewayBaseUrl: state.gateway_base_url,
    dryRun: true,
  });
  if (clientRestorePreview.conflicts.length > 0) {
    throw new Error(`Client configuration restore conflicts: ${clientRestorePreview.conflicts.length}`);
  }

  await stopGateway({ stateRoot, quiet: true });
  const clientRestore = await restoreClientConfigs({
    records: clientRecords,
    gatewayBaseUrl: state.gateway_base_url,
  });
  if (clientRestore.conflicts.length > 0) {
    throw new Error(`Client configuration restore conflicts: ${clientRestore.conflicts.length}`);
  }
  try {
    if (managedCodexConfigPath) {
      await copyFile(backupPath, managedCodexConfigPath || codexConfigPath);
    }
  } catch (error) {
    if (clientRestore.restored.length > 0) {
      try {
        await restoreClientConfigs({
          records: buildClientRestoreRollbackRecords(clientRestore.restored),
          gatewayBaseUrl: state.original_base_url,
        });
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Codex restore failed and client config rollback was incomplete.");
      }
    }
    throw error;
  }
  await rm(paths.statePath, { force: true });

  return {
    configPath: managedCodexConfigPath || codexConfigPath,
    restoredFrom: managedCodexConfigPath ? backupPath : "",
    restoredClients: clientRestore.restored,
  };
}

export async function launchUi({
  codexConfigPath = DEFAULT_CODEX_CONFIG_PATH,
  clientConfigPaths = getDefaultClientConfigPaths(),
  stateRoot = DEFAULT_STATE_ROOT,
  listenHost = DEFAULT_LISTEN_HOST,
  listenPort = DEFAULT_LISTEN_PORT,
  noOpen = false,
}) {
  const paths = getGatewayStatePaths(stateRoot);
  await ensureDirectory(paths.stateRoot);
  await ensureDirectory(paths.configDir);
  await ensureDirectory(paths.logDir);
  await ensureDirectory(paths.backupDir);

  if (!fs.existsSync(codexConfigPath)) {
    const clientLaunch = await launchUiForClientConfigs({
      clientConfigPaths,
      stateRoot,
      listenHost,
      listenPort,
    });
    const uiUrl = `${clientLaunch.gatewayBaseUrl}/__codex_retry_gateway/ui`;
    if (!noOpen) {
      openUrl(uiUrl);
    }
    return {
      ...clientLaunch,
      uiUrl,
    };
  }

  const providerContext = await getCodexProviderContext(codexConfigPath);
  const currentBaseUrl = `${providerContext.currentBaseUrl}`;
  const requestedGatewayBaseUrl = getGatewayBaseUrl(listenHost, listenPort);
  const existingState = await readJsonFile(paths.statePath);
  let existingGatewayConfig = await readJsonFile(paths.configPath);
  if (
    !existingGatewayConfig &&
    installStateMatchesProvider(existingState, providerContext.providerName, codexConfigPath)
  ) {
    const gatewayProcessId = await readLiveGatewayPid(paths.pidPath);
    existingGatewayConfig = await readGatewayRuntimeConfig(
      existingState?.gateway_base_url,
      gatewayProcessId,
    );
  }
  const originalBaseUrl =
    existingState?.original_base_url
      ? `${existingState.original_base_url}`
      : existingGatewayConfig?.upstream_base_url
        ? `${existingGatewayConfig.upstream_base_url}`
        : null;

  const canReuseExistingInstall =
    existingGatewayConfig &&
    originalBaseUrl &&
    installStateMatchesProvider(existingState, providerContext.providerName, codexConfigPath);

  let mode = "install";
  if (!canReuseExistingInstall) {
    await applyInstallForCurrentProvider({
      codexConfigPath,
      clientConfigPaths,
      stateRoot,
      listenHost,
      listenPort,
    });
  } else {
    mode = "reuse";
    const previousCodexConfigContent = await readFile(codexConfigPath, "utf8");
    const previousGatewayConfigContent = fs.existsSync(paths.configPath)
      ? await readFile(paths.configPath, "utf8")
      : null;
    const previousGatewayRuntimeConfigContent = `${JSON.stringify(existingGatewayConfig, null, 2)}\n`;
    const previousStateContent = fs.existsSync(paths.statePath)
      ? await readFile(paths.statePath, "utf8")
      : null;
    let providerConfigWritten = false;
    let gatewayConfigWritten = false;
    let stateWritten = false;
    let gatewayLifecycleAttempted = false;
    let previousGatewayHealthy = false;
    let recoveryBackupPath = existingState?.latest_backup_path ? `${existingState.latest_backup_path}` : "";
    let recoveryBackupCreated = false;
    let clientConfigInstall = null;

    try {
      const reusableGatewayConfig = cloneJsonValue(existingGatewayConfig);
      reusableGatewayConfig.listen_host = listenHost;
      reusableGatewayConfig.listen_port = listenPort;
      if (!reusableGatewayConfig.health_path) {
        reusableGatewayConfig.health_path = DEFAULT_HEALTH_PATH;
      }
      const legacyContinuationRuleMode = isLegacyContinuationRuleMode(
        reusableGatewayConfig.intercept_rule_mode,
      );
      if (legacyContinuationRuleMode) {
        reusableGatewayConfig.stream_action = CONTINUATION_RECOVERY_STREAM_ACTION;
      } else if (!reusableGatewayConfig.stream_action) {
        reusableGatewayConfig.stream_action = DEFAULT_STREAM_ACTION;
      }
      reusableGatewayConfig.continuation_marker_text = normalizeContinuationMarkerText(
        reusableGatewayConfig.continuation_marker_text,
      );
      reusableGatewayConfig.intercept_rule_mode = normalizeInterceptRuleMode(
        reusableGatewayConfig.intercept_rule_mode,
      );
      reusableGatewayConfig.reasoning_match_mode = normalizeReasoningMatchMode(
        reusableGatewayConfig.reasoning_match_mode,
      );
      if (reusableGatewayConfig.intercept_streaming === undefined) {
        reusableGatewayConfig.intercept_streaming = true;
      }
      if (reusableGatewayConfig.intercept_non_streaming === undefined) {
        reusableGatewayConfig.intercept_non_streaming = true;
      }
      if (reusableGatewayConfig.guard_retry_attempts === undefined || reusableGatewayConfig.guard_retry_attempts === null) {
        reusableGatewayConfig.guard_retry_attempts = DEFAULT_GUARD_RETRY_ATTEMPTS;
      }
      if (
        reusableGatewayConfig.retry_upstream_capacity_errors === undefined ||
        reusableGatewayConfig.retry_upstream_capacity_errors === null
      ) {
        reusableGatewayConfig.retry_upstream_capacity_errors = true;
      } else {
        reusableGatewayConfig.retry_upstream_capacity_errors =
          reusableGatewayConfig.retry_upstream_capacity_errors !== false;
      }
      const legacyCapacityAction = reusableGatewayConfig.retry_upstream_capacity_errors
        ? DEFAULT_CAPACITY_ERROR_ACTION
        : "pass_through";
      reusableGatewayConfig.capacity_error_action = normalizeUpstreamErrorAction(
        reusableGatewayConfig.capacity_error_action,
        legacyCapacityAction,
      );
      reusableGatewayConfig.http_429_action = normalizeUpstreamErrorAction(
        reusableGatewayConfig.http_429_action,
        DEFAULT_HTTP_429_ACTION,
      );
      reusableGatewayConfig.transient_retry = normalizeTransientRetryConfig(
        reusableGatewayConfig.transient_retry,
      );
      reusableGatewayConfig.latency_guard = normalizeLatencyGuardConfig(
        reusableGatewayConfig.latency_guard,
      );
      reusableGatewayConfig.request_body_limit_bytes = normalizeRequestBodyLimitBytes(
        reusableGatewayConfig.request_body_limit_bytes,
      );
      if (
        reusableGatewayConfig.intercept_rule_mode !== NONE_INTERCEPT_RULE_MODE &&
        !reusableGatewayConfig.intercept_streaming &&
        !reusableGatewayConfig.intercept_non_streaming
      ) {
        reusableGatewayConfig.intercept_streaming = true;
        reusableGatewayConfig.intercept_non_streaming = true;
      }
      const gatewayConfigChanged = !jsonValuesEqual(existingGatewayConfig, reusableGatewayConfig);
      const gatewayConfigNeedsWrite =
        previousGatewayConfigContent === null || gatewayConfigChanged;
      const gatewayProcessId = await readLiveGatewayPid(paths.pidPath);
      const gatewayProcessAlive = gatewayProcessId !== null;
      previousGatewayHealthy =
        gatewayProcessId !== null &&
        await isGatewayHealthy(existingGatewayConfig, gatewayProcessId);
      if (gatewayProcessAlive && !previousGatewayHealthy) {
        await rm(paths.pidPath, { force: true });
      }

      const managedGatewayBaseUrls = new Set(
        [
          requestedGatewayBaseUrl,
          existingState?.gateway_base_url ? `${existingState.gateway_base_url}` : null,
          getGatewayBaseUrlFromConfig(existingGatewayConfig),
        ].filter(Boolean),
      );
      const recoveryBackupUsable = isFilePath(recoveryBackupPath);
      if (!recoveryBackupUsable && !managedGatewayBaseUrls.has(currentBaseUrl)) {
        recoveryBackupPath = createUniqueBackupPath(paths.backupDir);
        await copyFile(codexConfigPath, recoveryBackupPath);
        recoveryBackupCreated = true;
      }

      if (gatewayConfigChanged && previousGatewayHealthy) {
        gatewayLifecycleAttempted = true;
        await stopGateway({
          stateRoot,
          quiet: true,
          gatewayConfig: existingGatewayConfig,
        });
      }

      if (gatewayConfigNeedsWrite) {
        await writeJsonFile(paths.configPath, reusableGatewayConfig);
        gatewayConfigWritten = true;
      }

      if (currentBaseUrl !== requestedGatewayBaseUrl) {
        await setCodexProviderBaseUrl({
          codexConfigPath,
          providerName: providerContext.providerName,
          newBaseUrl: requestedGatewayBaseUrl,
        });
        providerConfigWritten = true;
      }

      clientConfigInstall = await installManagedClientConfigs({
        clientConfigPaths,
        upstreamBaseUrl: originalBaseUrl,
        gatewayBaseUrl: requestedGatewayBaseUrl,
        backupDir: paths.backupDir,
        existingClientConfigs: existingState?.client_configs,
      });

      const gatewayLifecycleChanged = !previousGatewayHealthy || gatewayConfigChanged;
      if (gatewayLifecycleChanged) {
        gatewayLifecycleAttempted = true;
        await startGateway({
          stateRoot,
          configPath: paths.configPath,
          logPath: paths.logPath,
          restartIfRunning: false,
        });
      }

      const statePayload = {
        installed_at: existingState?.installed_at ? `${existingState.installed_at}` : new Date().toISOString(),
        last_started_at: gatewayLifecycleChanged
          ? new Date().toISOString()
          : existingState?.last_started_at || existingState?.installed_at || new Date().toISOString(),
        codex_config_path: codexConfigPath,
        provider_name: providerContext.providerName,
        original_base_url: originalBaseUrl,
        gateway_base_url: requestedGatewayBaseUrl,
        gateway_config_path: paths.configPath,
        gateway_log_path: paths.logPath,
        gateway_pid_path: paths.pidPath,
        latest_backup_path: recoveryBackupPath,
        state_root: paths.stateRoot,
        ...(clientConfigInstall.state ? { client_configs: clientConfigInstall.state } : {}),
      };
      if (!jsonValuesEqual(existingState, statePayload)) {
        await writeJsonFile(paths.statePath, statePayload);
        stateWritten = true;
      }
    } catch (error) {
      const rollbackErrors = [];

      if (gatewayLifecycleAttempted) {
        try {
          await stopGateway({ stateRoot, quiet: true });
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }

      if (clientConfigInstall?.newRecords?.length > 0) {
        try {
          const clientRestore = await restoreClientConfigs({
            records: clientConfigInstall.newRecords,
            gatewayBaseUrl: requestedGatewayBaseUrl,
          });
          if (clientRestore.conflicts.length > 0) {
            rollbackErrors.push(new Error("Client config rollback reported conflicts."));
          }
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }

      if (providerConfigWritten) {
        try {
          await writeUtf8File(codexConfigPath, previousCodexConfigContent);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }

      if (gatewayConfigWritten) {
        try {
          if (previousGatewayConfigContent === null) {
            await rm(paths.configPath, { force: true });
          } else {
            await writeUtf8File(paths.configPath, previousGatewayConfigContent);
          }
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }

      if (stateWritten) {
        try {
          if (previousStateContent === null) {
            await rm(paths.statePath, { force: true });
          } else {
            await writeUtf8File(paths.statePath, previousStateContent);
          }
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }

      if (recoveryBackupCreated) {
        try {
          await rm(recoveryBackupPath, { force: true });
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }

      if (gatewayLifecycleAttempted && previousGatewayHealthy) {
        let temporaryRollbackConfigWritten = false;
        try {
          if (!fs.existsSync(paths.configPath)) {
            await writeUtf8File(paths.configPath, previousGatewayRuntimeConfigContent);
            temporaryRollbackConfigWritten = true;
          }
          await startGateway({
            stateRoot,
            configPath: paths.configPath,
            logPath: paths.logPath,
            restartIfRunning: true,
          });
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        } finally {
          if (temporaryRollbackConfigWritten) {
            try {
              await rm(paths.configPath, { force: true });
            } catch (rollbackError) {
              rollbackErrors.push(rollbackError);
            }
          }
        }
      }

      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "Gateway launch failed and rollback did not complete cleanly.",
        );
      }
      throw error;
    }
  }

  const effectiveGatewayConfig = await readJsonFile(paths.configPath);
  const effectiveGatewayBaseUrl = getGatewayBaseUrlFromConfig(effectiveGatewayConfig) || requestedGatewayBaseUrl;
  const uiUrl = `${effectiveGatewayBaseUrl}/__codex_retry_gateway/ui`;

  if (!noOpen) {
    openUrl(uiUrl);
  }

  return {
    mode,
    uiUrl,
    gatewayBaseUrl: effectiveGatewayBaseUrl,
  };
}
