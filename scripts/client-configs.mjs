#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const SUPPORTED_CLIENTS = ["pi", "opencode", "zcode"];

function createParseError(message, sourcePath) {
  const error = new Error(`${message}${sourcePath ? `: ${sourcePath}` : ""}`);
  error.code = "invalid_config";
  return error;
}

function parseJsonString(source, start, sourcePath) {
  let cursor = start + 1;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === "\\") {
      cursor += 2;
      continue;
    }
    if (character === '"') {
      const end = cursor + 1;
      const raw = source.slice(start, end);
      try {
        return {
          type: "string",
          start,
          end,
          value: JSON.parse(raw),
        };
      } catch {
        throw createParseError("Invalid JSON string", sourcePath);
      }
    }
    if (character === "\n" || character === "\r") {
      throw createParseError("Unterminated JSON string", sourcePath);
    }
    cursor += 1;
  }
  throw createParseError("Unterminated JSON string", sourcePath);
}

export function parseJsoncDocument(source, sourcePath = "") {
  let cursor = 0;

  function skipTrivia() {
    while (cursor < source.length) {
      const character = source[cursor];
      if (/\s/.test(character)) {
        cursor += 1;
        continue;
      }
      if (source.startsWith("//", cursor)) {
        const lineEnd = source.indexOf("\n", cursor + 2);
        cursor = lineEnd === -1 ? source.length : lineEnd + 1;
        continue;
      }
      if (source.startsWith("/*", cursor)) {
        const commentEnd = source.indexOf("*/", cursor + 2);
        if (commentEnd === -1) {
          throw createParseError("Unterminated JSONC comment", sourcePath);
        }
        cursor = commentEnd + 2;
        continue;
      }
      break;
    }
  }

  function expect(character) {
    skipTrivia();
    if (source[cursor] !== character) {
      throw createParseError(`Expected '${character}'`, sourcePath);
    }
    cursor += 1;
  }

  function parseLiteral() {
    const start = cursor;
    const literalMatch = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      source.slice(cursor),
    );
    if (!literalMatch) {
      throw createParseError("Unexpected JSON token", sourcePath);
    }
    cursor += literalMatch[0].length;
    let value;
    try {
      value = JSON.parse(literalMatch[0]);
    } catch {
      throw createParseError("Invalid JSON literal", sourcePath);
    }
    return {
      type: "literal",
      start,
      end: cursor,
      value,
    };
  }

  function parseArray() {
    const start = cursor;
    expect("[");
    const items = [];
    skipTrivia();
    if (source[cursor] === "]") {
      cursor += 1;
      return { type: "array", start, end: cursor, items };
    }
    while (true) {
      items.push(parseValue());
      skipTrivia();
      if (source[cursor] === "]") {
        cursor += 1;
        return { type: "array", start, end: cursor, items };
      }
      expect(",");
      skipTrivia();
      if (source[cursor] === "]") {
        cursor += 1;
        return { type: "array", start, end: cursor, items };
      }
    }
  }

  function parseObject() {
    const start = cursor;
    expect("{");
    const properties = [];
    skipTrivia();
    if (source[cursor] === "}") {
      cursor += 1;
      return { type: "object", start, end: cursor, properties };
    }
    while (true) {
      skipTrivia();
      if (source[cursor] !== '"') {
        throw createParseError("Expected object property name", sourcePath);
      }
      const key = parseJsonString(source, cursor, sourcePath);
      cursor = key.end;
      expect(":");
      const value = parseValue();
      properties.push({ key, value });
      skipTrivia();
      if (source[cursor] === "}") {
        cursor += 1;
        return { type: "object", start, end: cursor, properties };
      }
      expect(",");
      skipTrivia();
      if (source[cursor] === "}") {
        cursor += 1;
        return { type: "object", start, end: cursor, properties };
      }
    }
  }

  function parseValue() {
    skipTrivia();
    const character = source[cursor];
    if (character === "{") {
      return parseObject();
    }
    if (character === "[") {
      return parseArray();
    }
    if (character === '"') {
      const string = parseJsonString(source, cursor, sourcePath);
      cursor = string.end;
      return string;
    }
    return parseLiteral();
  }

  const root = parseValue();
  skipTrivia();
  if (cursor !== source.length) {
    throw createParseError("Unexpected trailing JSON token", sourcePath);
  }
  return root;
}

function getObjectProperty(node, key) {
  if (!node || node.type !== "object") {
    return null;
  }
  for (let index = node.properties.length - 1; index >= 0; index -= 1) {
    const property = node.properties[index];
    if (property.key.value === key) {
      return property;
    }
  }
  return null;
}

function getObjectValue(node, key) {
  return getObjectProperty(node, key)?.value || null;
}

function getStringValue(node, key) {
  const value = getObjectValue(node, key);
  return value?.type === "string" ? value.value : null;
}

function getNodeAtPath(root, fieldPath) {
  let node = root;
  for (const segment of fieldPath) {
    const property = getObjectProperty(node, segment);
    if (!property) {
      return null;
    }
    node = property.value;
  }
  return node;
}

function normalizeUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    parsed.hash = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function areEquivalentUpstreamUrls(left, right) {
  const normalizedLeft = normalizeUrl(left);
  const normalizedRight = normalizeUrl(right);
  return normalizedLeft !== null && normalizedLeft === normalizedRight;
}

function providerSupportsOpenAi(provider) {
  if (!provider || provider.type !== "object") {
    return false;
  }
  const markers = [
    getStringValue(provider, "api"),
    getStringValue(provider, "package"),
    getStringValue(provider, "npm"),
    getStringValue(provider, "kind"),
  ]
    .filter(Boolean)
    .map((value) => value.toLowerCase().trim());
  return markers.some((value) =>
    value === "openai-completions" ||
    value === "openai-chat-completions" ||
    value.includes("openai-compatible"),
  );
}

function createCandidate({ client, filePath, providerId, fieldPath, urlNode, provider }) {
  return {
    client,
    filePath,
    providerId,
    fieldPath,
    originalBaseUrl: urlNode.value,
    start: urlNode.start,
    end: urlNode.end,
    compatible: providerSupportsOpenAi(provider),
  };
}

function collectPiCandidates(root, filePath) {
  const providers = getObjectValue(root, "providers");
  if (!providers || providers.type !== "object") {
    return [];
  }
  const candidates = [];
  for (const property of providers.properties) {
    const provider = property.value;
    const urlNode = getObjectValue(provider, "baseUrl");
    if (urlNode?.type !== "string") {
      continue;
    }
    candidates.push(
      createCandidate({
        client: "pi",
        filePath,
        providerId: property.key.value,
        fieldPath: ["providers", property.key.value, "baseUrl"],
        urlNode,
        provider,
      }),
    );
  }
  return candidates;
}

function collectOpenCodeCandidates(root, filePath) {
  const candidates = [];
  for (const [containerKey, optionsKey] of [
    ["providers", "settings"],
    ["provider", "options"],
  ]) {
    const providers = getObjectValue(root, containerKey);
    if (!providers || providers.type !== "object") {
      continue;
    }
    for (const property of providers.properties) {
      const provider = property.value;
      const options = getObjectValue(provider, optionsKey);
      const urlNode = getObjectValue(options, "baseURL");
      if (urlNode?.type !== "string") {
        continue;
      }
      candidates.push(
        createCandidate({
          client: "opencode",
          filePath,
          providerId: property.key.value,
          fieldPath: [containerKey, property.key.value, optionsKey, "baseURL"],
          urlNode,
          provider,
        }),
      );
    }
  }
  return candidates;
}

function collectZcodeCandidates(root, filePath) {
  const providers = getObjectValue(root, "provider");
  if (!providers || providers.type !== "object") {
    return [];
  }
  const candidates = [];
  for (const property of providers.properties) {
    const provider = property.value;
    const options = getObjectValue(provider, "options");
    const urlNode = getObjectValue(options, "baseURL");
    if (urlNode?.type !== "string") {
      continue;
    }
    candidates.push(
      createCandidate({
        client: "zcode",
        filePath,
        providerId: property.key.value,
        fieldPath: ["provider", property.key.value, "options", "baseURL"],
        urlNode,
        provider,
      }),
    );
  }
  return candidates;
}

const CANDIDATE_COLLECTORS = {
  pi: collectPiCandidates,
  opencode: collectOpenCodeCandidates,
  zcode: collectZcodeCandidates,
};

function normalizeConfiguredPaths(clientConfigPaths, client) {
  const raw = clientConfigPaths?.[client];
  if (raw === undefined || raw === null) {
    return [];
  }
  const paths = Array.isArray(raw) ? raw : [raw];
  return [...new Set(paths.filter((value) => typeof value === "string" && value.trim()).map((value) => path.resolve(value)))];
}

function buildSkipped(client, filePath, reason, providerId = null) {
  return {
    client,
    filePath,
    reason,
    ...(providerId ? { providerId } : {}),
  };
}

function isManagedGatewayRecord(record, gatewayBaseUrl) {
  if (!record.gatewayBaseUrl || !gatewayBaseUrl) {
    return false;
  }
  return areEquivalentUpstreamUrls(record.gatewayBaseUrl, gatewayBaseUrl);
}

export function getDefaultClientConfigPaths(homeDir = os.homedir()) {
  return {
    pi: path.join(homeDir, ".pi", "agent", "models.json"),
    opencode: [
      path.join(homeDir, ".config", "opencode", "opencode.jsonc"),
      path.join(homeDir, ".config", "opencode", "opencode.json"),
    ],
    zcode: path.join(homeDir, ".zcode", "v2", "config.json"),
  };
}

export async function findCompatibleClientUpstream({
  clientConfigPaths = getDefaultClientConfigPaths(),
} = {}) {
  const skipped = [];
  for (const client of SUPPORTED_CLIENTS) {
    const filePaths = normalizeConfiguredPaths(clientConfigPaths, client);
    for (const filePath of filePaths) {
      if (!fs.existsSync(filePath)) {
        continue;
      }
      let fileStats;
      try {
        fileStats = await lstat(filePath);
      } catch {
        skipped.push(buildSkipped(client, filePath, "unreadable"));
        continue;
      }
      if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
        skipped.push(buildSkipped(client, filePath, "unsupported_path"));
        continue;
      }
      let root;
      try {
        root = parseJsoncDocument(await readFile(filePath, "utf8"), filePath);
      } catch {
        skipped.push(buildSkipped(client, filePath, "invalid_config"));
        continue;
      }
      for (const candidate of CANDIDATE_COLLECTORS[client](root, filePath)) {
        if (!candidate.compatible) {
          skipped.push(buildSkipped(client, filePath, "unsupported_api", candidate.providerId));
          continue;
        }
        if (!normalizeUrl(candidate.originalBaseUrl)) {
          skipped.push(buildSkipped(client, filePath, "invalid_base_url", candidate.providerId));
          continue;
        }
        return {
          client: candidate.client,
          filePath: candidate.filePath,
          providerId: candidate.providerId,
          upstreamBaseUrl: candidate.originalBaseUrl,
          skipped,
        };
      }
    }
  }
  return { client: null, filePath: null, providerId: null, upstreamBaseUrl: null, skipped };
}

export async function discoverClientConfigs({
  clientConfigPaths = getDefaultClientConfigPaths(),
  upstreamBaseUrl,
  gatewayBaseUrl,
} = {}) {
  const skipped = [];
  const targets = [];
  const discoveredFiles = [];
  const normalizedUpstream = normalizeUrl(upstreamBaseUrl);
  const normalizedGateway = normalizeUrl(gatewayBaseUrl);
  if (!normalizedUpstream) {
    throw new Error("A valid upstreamBaseUrl is required to discover client configs.");
  }
  if (!normalizedGateway) {
    throw new Error("A valid gatewayBaseUrl is required to discover client configs.");
  }

  for (const client of SUPPORTED_CLIENTS) {
    const filePaths = normalizeConfiguredPaths(clientConfigPaths, client);
    if (filePaths.length === 0) {
      continue;
    }
    let foundConfig = false;
    for (const filePath of filePaths) {
      if (!fs.existsSync(filePath)) {
        continue;
      }
      foundConfig = true;
      let fileStats;
      try {
        fileStats = await lstat(filePath);
      } catch {
        skipped.push(buildSkipped(client, filePath, "unreadable"));
        continue;
      }
      if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
        skipped.push(buildSkipped(client, filePath, "unsupported_path"));
        continue;
      }
      let source;
      let root;
      try {
        source = await readFile(filePath, "utf8");
        root = parseJsoncDocument(source, filePath);
      } catch {
        skipped.push(buildSkipped(client, filePath, "invalid_config"));
        continue;
      }
      const candidates = CANDIDATE_COLLECTORS[client](root, filePath);
      discoveredFiles.push({ client, filePath, source, root, candidates });
      for (const candidate of candidates) {
        if (!candidate.compatible) {
          skipped.push(buildSkipped(client, filePath, "unsupported_api", candidate.providerId));
          continue;
        }
        const normalizedCandidate = normalizeUrl(candidate.originalBaseUrl);
        if (!normalizedCandidate) {
          skipped.push(buildSkipped(client, filePath, "invalid_base_url", candidate.providerId));
          continue;
        }
        if (normalizedCandidate === normalizedGateway) {
          skipped.push(buildSkipped(client, filePath, "already_gateway", candidate.providerId));
          continue;
        }
        if (normalizedCandidate !== normalizedUpstream) {
          skipped.push(buildSkipped(client, filePath, "upstream_mismatch", candidate.providerId));
          continue;
        }
        targets.push(candidate);
      }
    }
    if (!foundConfig) {
      skipped.push(buildSkipped(client, filePaths[0], "not_found"));
    }
  }

  return { targets, skipped, discoveredFiles };
}

function applyPatches(source, patches) {
  const sorted = [...patches].sort((left, right) => right.start - left.start);
  let previousStart = source.length + 1;
  let output = source;
  for (const patch of sorted) {
    if (patch.end > previousStart || patch.start < 0 || patch.end < patch.start) {
      throw new Error("Client config patches overlap or are invalid.");
    }
    output = `${output.slice(0, patch.start)}${patch.replacement}${output.slice(patch.end)}`;
    previousStart = patch.start;
  }
  return output;
}

async function writeAtomically(filePath, content) {
  const fileStats = await stat(filePath);
  const directory = path.dirname(filePath);
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, content, "utf8");
    await chmod(tempPath, fileStats.mode);
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true });
  }
}

function createBackupPath(backupDir, client, filePath) {
  const safeBaseName = path.basename(filePath).replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(backupDir, `${client}-${safeBaseName}-${randomUUID()}.bak`);
}

export async function installClientConfigs({
  clientConfigPaths = getDefaultClientConfigPaths(),
  upstreamBaseUrl,
  gatewayBaseUrl,
  backupDir,
} = {}) {
  if (!backupDir || typeof backupDir !== "string") {
    throw new Error("A backupDir is required to install client configs.");
  }
  const discovery = await discoverClientConfigs({ clientConfigPaths, upstreamBaseUrl, gatewayBaseUrl });
  const targetsByFile = new Map();
  for (const target of discovery.targets) {
    const group = targetsByFile.get(target.filePath) || [];
    group.push(target);
    targetsByFile.set(target.filePath, group);
  }

  await mkdir(backupDir, { recursive: true });
  const writtenFiles = [];
  const createdBackups = [];
  const records = [];
  try {
    for (const [filePath, targets] of targetsByFile) {
      const source = await readFile(filePath, "utf8");
      const client = targets[0].client;
      const backupPath = createBackupPath(backupDir, client, filePath);
      await copyFile(filePath, backupPath);
      createdBackups.push(backupPath);
      const updatedSource = applyPatches(
        source,
        targets.map((target) => ({
          start: target.start,
          end: target.end,
          replacement: JSON.stringify(gatewayBaseUrl),
        })),
      );
      await writeAtomically(filePath, updatedSource);
      writtenFiles.push({ filePath, source });
      for (const target of targets) {
        records.push({
          client: target.client,
          filePath,
          providerId: target.providerId,
          fieldPath: target.fieldPath,
          originalBaseUrl: target.originalBaseUrl,
          gatewayBaseUrl,
          backupPath,
        });
      }
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const writtenFile of [...writtenFiles].reverse()) {
      try {
        await writeAtomically(writtenFile.filePath, writtenFile.source);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    for (const backupPath of createdBackups) {
      try {
        await rm(backupPath, { force: true });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], "Client config install failed and rollback was incomplete.");
    }
    throw error;
  }

  return { records, skipped: discovery.skipped };
}

export async function restoreClientConfigs({ records, gatewayBaseUrl, dryRun = false } = {}) {
  const normalizedRecords = Array.isArray(records) ? records.filter(Boolean) : [];
  const restored = [];
  const conflicts = [];
  const skipped = [];
  const recordsByFile = new Map();
  for (const record of normalizedRecords) {
    if (!record.filePath || !Array.isArray(record.fieldPath) || !record.originalBaseUrl) {
      skipped.push({ ...record, reason: "invalid_record" });
      continue;
    }
    if (!isManagedGatewayRecord(record, gatewayBaseUrl)) {
      conflicts.push({ ...record, reason: "gateway_mismatch" });
      continue;
    }
    const group = recordsByFile.get(record.filePath) || [];
    group.push(record);
    recordsByFile.set(record.filePath, group);
  }

  const pendingWrites = [];
  for (const [filePath, fileRecords] of recordsByFile) {
    if (!fs.existsSync(filePath)) {
      for (const record of fileRecords) {
        conflicts.push({ ...record, reason: "file_missing" });
      }
      continue;
    }
    let fileStats;
    try {
      fileStats = await lstat(filePath);
    } catch {
      for (const record of fileRecords) {
        conflicts.push({ ...record, reason: "unreadable" });
      }
      continue;
    }
    if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
      for (const record of fileRecords) {
        conflicts.push({ ...record, reason: "unsupported_path" });
      }
      continue;
    }
    let source;
    let root;
    try {
      source = await readFile(filePath, "utf8");
      root = parseJsoncDocument(source, filePath);
    } catch {
      for (const record of fileRecords) {
        conflicts.push({ ...record, reason: "invalid_config" });
      }
      continue;
    }
    const patches = [];
    const fileRestored = [];
    for (const record of fileRecords) {
      const node = getNodeAtPath(root, record.fieldPath);
      const managedBaseUrl = record.gatewayBaseUrl || gatewayBaseUrl;
      if (!node || node.type !== "string") {
        conflicts.push({ ...record, reason: "field_missing" });
        continue;
      }
      if (node.value === record.originalBaseUrl) {
        skipped.push({ ...record, reason: "already_restored" });
        continue;
      }
      if (node.value !== managedBaseUrl) {
        conflicts.push({ ...record, reason: "external_change" });
        continue;
      }
      patches.push({
        start: node.start,
        end: node.end,
        replacement: JSON.stringify(record.originalBaseUrl),
      });
      fileRestored.push(record);
    }
    if (patches.length === 0) {
      continue;
    }
    try {
      pendingWrites.push({
        filePath,
        source,
        updatedSource: applyPatches(source, patches),
        records: fileRestored,
      });
    } catch {
      for (const record of fileRestored) {
        conflicts.push({ ...record, reason: "write_failed" });
      }
    }
  }

  const writtenFiles = [];
  if (dryRun) {
    return { restored: pendingWrites.flatMap((pendingWrite) => pendingWrite.records), conflicts, skipped };
  }
  try {
    for (const pendingWrite of pendingWrites) {
      await writeAtomically(pendingWrite.filePath, pendingWrite.updatedSource);
      writtenFiles.push(pendingWrite);
      restored.push(...pendingWrite.records);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const writtenFile of [...writtenFiles].reverse()) {
      try {
        await writeAtomically(writtenFile.filePath, writtenFile.source);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      for (const record of writtenFile.records) {
        const restoredIndex = restored.indexOf(record);
        if (restoredIndex !== -1) {
          restored.splice(restoredIndex, 1);
        }
        conflicts.push({ ...record, reason: "write_failed" });
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], "Client config restore failed and rollback was incomplete.");
    }
    for (const pendingWrite of pendingWrites.slice(writtenFiles.length)) {
      for (const record of pendingWrite.records) {
        conflicts.push({ ...record, reason: "write_failed" });
      }
    }
  }

  return { restored, conflicts, skipped };
}
