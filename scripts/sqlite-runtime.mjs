import { execFile } from "node:child_process";

const SQLITE_JSON_ROWS_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
let databaseSyncRuntimePromise;

async function loadDatabaseSyncRuntime() {
  if (!databaseSyncRuntimePromise) {
    databaseSyncRuntimePromise = import("node:sqlite")
      .then((module) =>
        typeof module.DatabaseSync === "function" ? module.DatabaseSync : null,
      )
      .catch(() => null);
  }
  return databaseSyncRuntimePromise;
}

function execFileText(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(`${stdout || ""}`);
    });
  });
}

function parseSqliteJsonRows(text) {
  const normalized = `${text || ""}`.trim();
  if (!normalized) {
    return [];
  }
  const parsed = JSON.parse(normalized);
  return Array.isArray(parsed) ? parsed : [];
}

function buildMissingRuntimeError(cause) {
  return new Error(
    "历史 SQLite 导入需要 Node.js 内置 node:sqlite（Node 22.5+）或 PATH 中可用的 sqlite3 CLI。",
    { cause },
  );
}

export async function sqliteJsonRows(databasePath, sql) {
  const DatabaseSync = await loadDatabaseSyncRuntime();
  if (DatabaseSync) {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      return database.prepare(sql).all();
    } finally {
      database.close();
    }
  }

  try {
    const stdout = await execFileText(process.env.SQLITE3_EXE || "sqlite3", ["-json", databasePath, sql], {
      maxBuffer: SQLITE_JSON_ROWS_MAX_BUFFER_BYTES,
      windowsHide: true,
    });
    return parseSqliteJsonRows(stdout);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw buildMissingRuntimeError(error);
    }
    throw error;
  }
}

export async function executeSqliteScript(databasePath, sql, options = {}) {
  const DatabaseSync = await loadDatabaseSyncRuntime();
  if (DatabaseSync) {
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(sql);
    } finally {
      database.close();
    }
    return;
  }

  try {
    await execFileText(options.sqlite3Path || process.env.SQLITE3_EXE || "sqlite3", [
      databasePath,
      sql,
    ], {
      cwd: options.cwd,
      windowsHide: true,
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw buildMissingRuntimeError(error);
    }
    throw error;
  }
}
