const MAX_SAFE_WAIT_MS = 2_147_483_647;
const DEFAULT_MIN_DISPATCH_INTERVAL_MS = 10;
const DEFAULT_MAX_QUEUE_PER_KEY = 16;
const DEFAULT_MAX_QUEUE_TOTAL = 64;
const DEFAULT_MAX_COOLDOWN_BUCKETS = 256;

function normalizeKey(value) {
  const key = `${value ?? ""}`;
  return key || "(unknown)";
}

function createEntry() {
  return {
    busy: false,
    queue: [],
    ownerToken: null,
    availableAtMs: 0,
    wakeTimer: null,
  };
}

/**
 * 按协调键串行化后台 retry attempt；首发请求不经过此对象。
 * 不使用固定租约强制释放，避免慢流仍在执行时产生同键重叠。
 */
export class RetryDispatchCoordinator {
  constructor(options = {}) {
    const configuredInterval = Number(options?.minDispatchIntervalMs);
    this.minDispatchIntervalMs = Number.isFinite(configuredInterval)
      ? Math.max(0, Math.min(MAX_SAFE_WAIT_MS, configuredInterval))
      : DEFAULT_MIN_DISPATCH_INTERVAL_MS;
    const configuredPerKey = Number(options?.maxQueuePerKey);
    const configuredTotal = Number(options?.maxQueueTotal);
    const configuredCooldownBuckets = Number(options?.maxCooldownBuckets);
    this.maxQueuePerKey = Number.isSafeInteger(configuredPerKey) && configuredPerKey >= 0
      ? configuredPerKey
      : DEFAULT_MAX_QUEUE_PER_KEY;
    this.maxQueueTotal = Number.isSafeInteger(configuredTotal) && configuredTotal >= 0
      ? configuredTotal
      : DEFAULT_MAX_QUEUE_TOTAL;
    this.maxCooldownBuckets = Number.isSafeInteger(configuredCooldownBuckets) && configuredCooldownBuckets >= 0
      ? configuredCooldownBuckets
      : DEFAULT_MAX_COOLDOWN_BUCKETS;
    this.entries = new Map();
    this.queuedCount = 0;
    this.stats = {
      acquired_count: 0,
      enqueued_count: 0,
      cancelled_count: 0,
      deadline_count: 0,
      overloaded_count: 0,
      deferred_count: 0,
      cooldown_overflow_count: 0,
      max_wait_ms: 0,
      max_queue_depth: 0,
      max_defer_ms: 0,
    };
  }

  getOrCreateEntry(key) {
    const normalizedKey = normalizeKey(key);
    let entry = this.entries.get(normalizedKey);
    if (!entry) {
      entry = createEntry();
      this.entries.set(normalizedKey, entry);
    }
    return { normalizedKey, entry };
  }

  acquire(key, options = {}) {
    const { normalizedKey, entry } = this.getOrCreateEntry(key);
    const signal = options?.signal || null;
    const deadlineAtMs = Number.isFinite(options?.deadlineAtMs)
      ? Number(options.deadlineAtMs)
      : null;
    const startedAtMs = Date.now();

    if (signal?.aborted) {
      this.stats.cancelled_count += 1;
      this.cleanupEntry(normalizedKey, entry);
      return Promise.resolve({ acquired: false, reason: "aborted", waitedMs: 0 });
    }
    if (deadlineAtMs !== null && deadlineAtMs <= startedAtMs) {
      this.stats.deadline_count += 1;
      this.cleanupEntry(normalizedKey, entry);
      return Promise.resolve({ acquired: false, reason: "deadline", waitedMs: 0 });
    }
    if (
      !entry.busy &&
      entry.queue.length === 0 &&
      entry.availableAtMs <= startedAtMs
    ) {
      entry.busy = true;
      const token = {};
      entry.ownerToken = token;
      this.stats.acquired_count += 1;
      return Promise.resolve(this.buildLease(normalizedKey, entry, token, startedAtMs));
    }

    if (
      entry.queue.length >= this.maxQueuePerKey ||
      this.queuedCount >= this.maxQueueTotal
    ) {
      this.stats.overloaded_count += 1;
      this.cleanupEntry(normalizedKey, entry);
      return Promise.resolve({ acquired: false, reason: "overloaded", waitedMs: 0 });
    }

    this.stats.enqueued_count += 1;
    this.queuedCount += 1;
    return new Promise((resolve) => {
      const waiter = {
        resolve,
        signal,
        deadlineAtMs,
        startedAtMs,
        settled: false,
        timer: null,
        onAbort: null,
      };
      const settle = (result) => {
        if (waiter.settled) {
          return;
        }
        waiter.settled = true;
        if (waiter.timer) {
          clearTimeout(waiter.timer);
          waiter.timer = null;
        }
        waiter.signal?.removeEventListener("abort", waiter.onAbort);
        resolve(result);
      };
      waiter.settle = settle;
      waiter.onAbort = () => {
        if (waiter.settled) {
          return;
        }
        this.removeWaiter(normalizedKey, entry, waiter);
        this.stats.cancelled_count += 1;
        settle({ acquired: false, reason: "aborted", waitedMs: Date.now() - startedAtMs });
      };
      entry.queue.push(waiter);
      this.stats.max_queue_depth = Math.max(this.stats.max_queue_depth, entry.queue.length);
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      if (signal?.aborted) {
        waiter.onAbort();
        return;
      }
      if (deadlineAtMs !== null) {
        const delayMs = Math.min(
          MAX_SAFE_WAIT_MS,
          Math.max(0, deadlineAtMs - startedAtMs),
        );
        waiter.timer = setTimeout(() => {
          this.removeWaiter(normalizedKey, entry, waiter);
          this.stats.deadline_count += 1;
          settle({ acquired: false, reason: "deadline", waitedMs: Date.now() - startedAtMs });
          this.pump(normalizedKey, entry);
        }, delayMs);
      }
      this.pump(normalizedKey, entry);
    });
  }

  buildLease(key, entry, token, startedAtMs) {
    let released = false;
    const waitedMs = Math.max(0, Date.now() - startedAtMs);
    this.stats.max_wait_ms = Math.max(this.stats.max_wait_ms, waitedMs);
    const defer = (availableAtMs) => {
      if (released || entry.ownerToken !== token) {
        return false;
      }
      return this.deferEntry(key, entry, availableAtMs);
    };
    return {
      acquired: true,
      waitedMs,
      defer,
      release: () => {
        if (released || entry.ownerToken !== token) {
          return;
        }
        released = true;
        entry.ownerToken = null;
        entry.busy = false;
        const nowMs = Date.now();
        const nextWaiter = entry.queue[0];
        const deadlineHasRoom =
          nextWaiter?.deadlineAtMs === null ||
          nextWaiter?.deadlineAtMs === undefined ||
          nextWaiter.deadlineAtMs - nowMs > this.minDispatchIntervalMs;
        const queuedIntervalAtMs =
          entry.queue.length > 0 && deadlineHasRoom
            ? nowMs + this.minDispatchIntervalMs
            : 0;
        entry.availableAtMs = Math.max(
          entry.availableAtMs > nowMs ? entry.availableAtMs : 0,
          queuedIntervalAtMs,
        );
        this.pump(key, entry);
      },
    };
  }

  defer(key, availableAtMs) {
    const { normalizedKey, entry } = this.getOrCreateEntry(key);
    return this.deferEntry(normalizedKey, entry, availableAtMs);
  }

  deferEntry(key, entry, availableAtMs) {
    const parsed = Number(availableAtMs);
    if (!Number.isFinite(parsed)) {
      return false;
    }
    const nowMs = Date.now();
    const bounded = Math.max(nowMs, Math.min(MAX_SAFE_WAIT_MS + nowMs, parsed));
    if (bounded <= entry.availableAtMs) {
      return false;
    }
    if (
      entry.availableAtMs <= nowMs &&
      !entry.busy &&
      entry.queue.length === 0 &&
      this.cooldownBucketCount() >= this.maxCooldownBuckets
    ) {
      this.stats.cooldown_overflow_count += 1;
      this.cleanupEntry(key, entry);
      return false;
    }
    entry.availableAtMs = bounded;
    this.stats.deferred_count += 1;
    this.stats.max_defer_ms = Math.max(this.stats.max_defer_ms, bounded - nowMs);
    if (!entry.busy) {
      this.pump(key, entry);
    }
    return true;
  }

  removeWaiter(key, entry, waiter) {
    if (waiter.settled) {
      return;
    }
    const index = entry.queue.indexOf(waiter);
    if (index >= 0) {
      entry.queue.splice(index, 1);
      this.queuedCount = Math.max(0, this.queuedCount - 1);
    }
    this.pump(key, entry);
  }

  pump(key, entry) {
    if (entry.busy) {
      return;
    }
    const nowMs = Date.now();
    if (entry.availableAtMs > nowMs) {
      this.scheduleWake(key, entry, entry.availableAtMs);
      return;
    }
    entry.availableAtMs = 0;
    while (entry.queue.length > 0) {
      const waiter = entry.queue.shift();
      this.queuedCount = Math.max(0, this.queuedCount - 1);
      if (!waiter || waiter.settled) {
        continue;
      }
      if (waiter.signal?.aborted) {
        this.stats.cancelled_count += 1;
        waiter.settle({ acquired: false, reason: "aborted", waitedMs: Date.now() - waiter.startedAtMs });
        continue;
      }
      if (waiter.deadlineAtMs !== null && waiter.deadlineAtMs <= Date.now()) {
        this.stats.deadline_count += 1;
        waiter.settle({ acquired: false, reason: "deadline", waitedMs: Date.now() - waiter.startedAtMs });
        continue;
      }
      entry.busy = true;
      const token = {};
      entry.ownerToken = token;
      this.stats.acquired_count += 1;
      waiter.settle(this.buildLease(key, entry, token, waiter.startedAtMs));
      return;
    }
    this.cleanupEntry(key, entry);
  }

  scheduleWake(key, entry, wakeAtMs) {
    if (entry.wakeTimer) {
      clearTimeout(entry.wakeTimer);
    }
    entry.wakeTimer = setTimeout(() => {
      entry.wakeTimer = null;
      this.pump(key, entry);
    }, Math.min(MAX_SAFE_WAIT_MS, Math.max(0, wakeAtMs - Date.now())));
    if (entry.queue.length === 0) {
      entry.wakeTimer.unref?.();
    } else {
      entry.wakeTimer.ref?.();
    }
  }

  cleanupEntry(key, entry) {
    if (
      !entry.busy &&
      entry.queue.length === 0 &&
      entry.availableAtMs <= Date.now() &&
      this.entries.get(key) === entry
    ) {
      if (entry.wakeTimer) {
        clearTimeout(entry.wakeTimer);
      }
      this.entries.delete(key);
    }
  }

  cooldownBucketCount() {
    let count = 0;
    const nowMs = Date.now();
    for (const entry of this.entries.values()) {
      if (entry.availableAtMs > nowMs) {
        count += 1;
      }
    }
    return count;
  }

  snapshot() {
    let queued = 0;
    let active = 0;
    let coolingDown = 0;
    let maxCooldownRemainingMs = 0;
    for (const entry of this.entries.values()) {
      queued += entry.queue.length;
      active += entry.busy ? 1 : 0;
      const cooldownRemainingMs = Math.max(0, entry.availableAtMs - Date.now());
      if (cooldownRemainingMs > 0) {
        coolingDown += 1;
        maxCooldownRemainingMs = Math.max(maxCooldownRemainingMs, cooldownRemainingMs);
      }
    }
    return {
      active,
      queued,
      bucket_count: this.entries.size,
      max_queue_per_key: this.maxQueuePerKey,
      max_queue_total: this.maxQueueTotal,
      max_cooldown_buckets: this.maxCooldownBuckets,
      queued_count: queued,
      enqueued_count: this.stats.enqueued_count,
      min_dispatch_interval_ms: this.minDispatchIntervalMs,
      cooling_down_bucket_count: coolingDown,
      max_cooldown_remaining_ms: maxCooldownRemainingMs,
      ...this.stats,
    };
  }
}
