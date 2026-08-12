#!/usr/bin/env node

import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { execFile, spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

const gatewayRoot = path.resolve(import.meta.dirname, "..");
const gatewayEntry = path.join(gatewayRoot, "gateway.mjs");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function padDatePart(value) {
  return String(value).padStart(2, "0");
}

function formatLocalDateKey(date) {
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`;
}

function addLocalDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

async function getFreePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : null;
  server.close();
  await once(server, "close");
  if (!port) {
    throw new Error("无法分配空闲端口");
  }
  return port;
}

async function abortRequestDuringUpload(port, testKey) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (error = null) => {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    socket.once("error", (error) => {
      if (error?.code === "ECONNRESET") {
        finish();
        return;
      }
      finish(error);
    });
    socket.once("close", () => finish());
    socket.once("connect", () => {
      const partialBody = JSON.stringify({
        model: "gpt-5.5",
        test_sequence_key: testKey,
        partial: "upload-will-disconnect",
      });
      socket.write(
        [
          "POST /responses HTTP/1.1",
          `Host: 127.0.0.1:${port}`,
          "Content-Type: application/json",
          "Content-Length: 65536",
          `X-Test-Key: ${testKey}`,
          "Connection: close",
          "",
          partialBody,
        ].join("\r\n"),
      );
      setTimeout(() => socket.destroy(), 30);
    });
  });
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

function createJsonResponse(res, statusCode, body, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function createTextResponse(res, statusCode, body, contentType, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "content-type": contentType,
    ...extraHeaders,
  });
  res.end(`${body}`);
}

function createSseResponse(res, chunks, intervalMs = 20, extraHeaders = {}) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-upstream-test": "sse",
    ...extraHeaders,
  });

  let index = 0;
  const timer = setInterval(() => {
    if (index >= chunks.length) {
      clearInterval(timer);
      res.end();
      return;
    }
    res.write(chunks[index]);
    index += 1;
  }, intervalMs);

  res.on("close", () => {
    clearInterval(timer);
  });
}

function createSseResponseWithPauseAfterOutput(
  res,
  chunks,
  pauseMs,
  intervalMs = 20,
  marker = '\"type\":\"response.output_text.delta\"',
) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-upstream-test": "sse-paused-after-output",
  });

  let index = 0;
  let timer = null;
  let paused = false;
  const writeNext = () => {
    if (index >= chunks.length) {
      res.end();
      return;
    }
    const chunk = chunks[index];
    index += 1;
    res.write(chunk);
    const shouldPause = !paused && chunk.includes(marker);
    if (shouldPause) {
      paused = true;
    }
    timer = setTimeout(writeNext, shouldPause ? pauseMs : intervalMs);
  };
  timer = setTimeout(writeNext, intervalMs);
  res.on("close", () => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function createSseResponseWithPauseAfterFirstChunk(
  res,
  chunks,
  pauseMs,
  intervalMs = 20,
  extraHeaders = {},
) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-upstream-test": "sse-paused-after-first-chunk",
    ...extraHeaders,
  });
  let index = 0;
  let timer = null;
  const writeNext = () => {
    if (index >= chunks.length) {
      res.end();
      return;
    }
    res.write(chunks[index]);
    index += 1;
    timer = setTimeout(writeNext, index === 1 ? pauseMs : intervalMs);
  };
  timer = setTimeout(writeNext, intervalMs);
  res.on("close", () => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function createSseResponseWithInitialDelay(
  res,
  chunks,
  initialDelayMs,
  intervalMs = 20,
  onChunkSent = null,
) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-upstream-test": "sse-initial-delay",
  });
  let index = 0;
  let timer = null;
  const writeNext = () => {
    if (index >= chunks.length) {
      res.end();
      return;
    }
    res.write(chunks[index]);
    onChunkSent?.(Date.now(), index);
    index += 1;
    timer = setTimeout(writeNext, intervalMs);
  };
  timer = setTimeout(writeNext, initialDelayMs);
  res.on("close", () => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function createSseResponseWithPauseBeforeOutput(
  res,
  chunks,
  pauseMs,
  intervalMs = 20,
  extraHeaders = {},
) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-upstream-test": "sse-paused-before-output",
    ...extraHeaders,
  });
  let index = 0;
  let timer = null;
  let paused = false;
  const writeNext = () => {
    if (index >= chunks.length) {
      res.end();
      return;
    }
    const chunk = chunks[index];
    if (!paused && chunk.includes('\"type\":\"response.output_text.delta\"')) {
      paused = true;
      timer = setTimeout(writeNext, pauseMs);
      return;
    }
    res.write(chunk);
    index += 1;
    timer = setTimeout(writeNext, intervalMs);
  };
  timer = setTimeout(writeNext, intervalMs);
  res.on("close", () => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function createTerminatedSseResponse(res, chunks, destroyDelayMs = 20, extraHeaders = {}) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-upstream-test": "sse-terminated",
    ...extraHeaders,
  });

  for (const chunk of chunks) {
    res.write(chunk);
  }

  setTimeout(() => {
    res.socket?.destroy();
  }, destroyDelayMs);
}

function buildResponsePayload(
  parsed,
  reasoning,
  retryAttempt = 0,
  responseAttemptNumber = 1,
) {
  const payload = {
    id: parsed.test_response_id ?? "resp_test",
    model: parsed.test_response_model ?? parsed.model ?? "gpt-5.4",
    system_fingerprint: parsed.test_system_fingerprint ?? "fp_static",
    service_tier: parsed.test_service_tier ?? "priority",
    retry_attempt: retryAttempt,
    usage: {
      output_tokens_details: {
        reasoning_tokens: reasoning,
      },
    },
  };
  const responseOutputText = Array.isArray(parsed.test_response_output_text_sequence)
    ? parsed.test_response_output_text_sequence[
        Math.min(
          Math.max(0, responseAttemptNumber - 1),
          parsed.test_response_output_text_sequence.length - 1,
        )
      ]
    : parsed.test_response_output_text;
  if (typeof responseOutputText === "string") {
    payload.output_text = responseOutputText;
  }
  if (parsed.test_omit_reasoning_tokens) {
    delete payload.usage.output_tokens_details.reasoning_tokens;
  }
  if (parsed.test_include_reasoning_item) {
    payload.output = [
      { type: "reasoning", summary: [] },
      {
        type: "message",
        content: [{ type: "output_text", text: "visible final answer" }],
      },
    ];
  }
  if (parsed.test_include_json_encrypted_reasoning_item) {
    payload.output = [
      {
        id: parsed.test_json_reasoning_id ?? "rs_json_test_1",
        type: "reasoning",
        encrypted_content:
          parsed.test_json_reasoning_encrypted_content ?? "json-encrypted-test-content",
        summary: [],
      },
      {
        type: "message",
        content: [{ type: "output_text", text: "visible final answer" }],
      },
    ];
  }
  if (parsed.test_include_final_answer_only) {
    payload.output = [
      {
        type: "message",
        content: [{ type: "output_text", text: "visible final answer" }],
      },
    ];
  }
  if (parsed.test_response_fault_marker) {
    payload.test_response_fault_marker = parsed.test_response_fault_marker;
  }
  return payload;
}

function extractLongContextProbeUnits(serializedInput) {
  const match = `${serializedInput || ""}`.match(
    /__crg_long_context_probe__ phase=([a-z0-9_]+) units=(\d+)/i,
  );
  if (!match) {
    return null;
  }
  return {
    phase: match[1],
    units: Number.parseInt(match[2], 10),
  };
}

function buildLongContextProbeResponsePayload(
  parsed,
  inputTokens,
  outputText = "OK",
) {
  const safeInputTokens = Math.max(
    0,
    Number.parseInt(`${inputTokens}`, 10) || 0,
  );
  const outputTokens = 1;
  return {
    id: parsed.test_response_id ?? "resp_probe_long_context",
    model: parsed.test_response_model ?? parsed.model ?? "gpt-5.4",
    output_text: outputText,
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: outputText }],
      },
    ],
    usage: {
      input_tokens: safeInputTokens,
      input_tokens_details: {
        cached_tokens: Math.max(0, Math.min(5000, safeInputTokens)),
      },
      output_tokens: outputTokens,
      output_tokens_details: {
        reasoning_tokens: 0,
      },
      total_tokens: safeInputTokens + outputTokens,
    },
  };
}

function buildStreamModels(parsed, sequenceCount = 0) {
  const sequenceModels = selectStreamSequenceValue(
    parsed,
    "test_stream_models_sequence",
    sequenceCount,
  );
  if (Array.isArray(sequenceModels) && sequenceModels.length > 0) {
    return sequenceModels;
  }
  if (
    Array.isArray(parsed.test_stream_models) &&
    parsed.test_stream_models.length > 0
  ) {
    return parsed.test_stream_models;
  }
  return [parsed.test_response_model ?? parsed.model ?? "gpt-5.4"];
}

function buildStreamFingerprints(parsed, count) {
  if (
    Array.isArray(parsed.test_stream_fingerprints) &&
    parsed.test_stream_fingerprints.length > 0
  ) {
    return parsed.test_stream_fingerprints;
  }
  return Array.from({ length: count }, (_, index) => `fp_stream_${index + 1}`);
}

function buildResponseIds(parsed, count) {
  if (
    Array.isArray(parsed.test_response_ids) &&
    parsed.test_response_ids.length > 0
  ) {
    return parsed.test_response_ids;
  }
  return Array.from(
    { length: count },
    (_, index) => `resp_stream_${index + 1}`,
  );
}

function buildStreamEventIds(parsed, count) {
  if (
    Array.isArray(parsed.test_stream_event_ids) &&
    parsed.test_stream_event_ids.length > 0
  ) {
    return parsed.test_stream_event_ids;
  }
  return Array.from({ length: count }, () => null);
}

function selectStreamSequenceValue(parsed, key, sequenceCount = 0) {
  const value = parsed[key];
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const index = Math.min(sequenceCount, value.length - 1);
  return value[index];
}

function selectStreamOutputText(parsed, sequenceCount = 0) {
  if (Array.isArray(parsed.test_stream_text_sequence)) {
    const index = Math.min(sequenceCount, parsed.test_stream_text_sequence.length - 1);
    const value = parsed.test_stream_text_sequence[index];
    return value === null || value === undefined ? "" : `${value}`;
  }
  if (parsed.test_stream_text !== undefined) {
    return parsed.test_stream_text === null ? "" : `${parsed.test_stream_text}`;
  }
  return "hello";
}

function selectStreamFlag(parsed, key, sequenceCount = 0) {
  const value = parsed[key];
  if (Array.isArray(value)) {
    const index = Math.min(sequenceCount, value.length - 1);
    return Boolean(value[index]);
  }
  return Boolean(value);
}
function buildResponsesStreamChunks(parsed, reasoning, sequenceCount = 0) {
  const models = buildStreamModels(parsed, sequenceCount);
  const fingerprints = buildStreamFingerprints(parsed, models.length);
  const sequenceResponseId = selectStreamSequenceValue(parsed, "test_response_id_sequence", sequenceCount);
  const responseIds =
    sequenceResponseId === undefined
      ? buildResponseIds(parsed, models.length)
      : Array.from({ length: models.length }, () => sequenceResponseId);
  const eventIds = buildStreamEventIds(parsed, models.length);
  const finalModel =
    selectStreamSequenceValue(parsed, "test_stream_final_model_sequence", sequenceCount) ??
    parsed.test_stream_final_model ??
    models[models.length - 1];
  const finalFingerprint =
    fingerprints[fingerprints.length - 1] ?? fingerprints[0] ?? "fp_stream_1";
  const finalResponseId =
    sequenceResponseId ?? responseIds[responseIds.length - 1] ?? responseIds[0] ?? "resp_stream_1";
  const serviceTier = parsed.test_service_tier ?? "priority";
  const chunks = [];

  if (parsed.test_include_stream_lifecycle) {
    chunks.push(
      `data: ${JSON.stringify({
        type: "response.created",
        response: {
          id: finalResponseId,
          model: finalModel,
        },
      })}\n\n`,
    );
    chunks.push(
      `data: ${JSON.stringify({
        type: "response.in_progress",
        response: {
          id: finalResponseId,
          model: finalModel,
        },
      })}\n\n`,
    );
    const repeatedLifecycleCount = Number.isInteger(parsed.test_stream_lifecycle_repeat_count)
      ? Math.max(0, parsed.test_stream_lifecycle_repeat_count)
      : 0;
    for (let index = 0; index < repeatedLifecycleCount; index += 1) {
      chunks.push(
        `data: ${JSON.stringify({
          type: "response.in_progress",
          response: {
            id: finalResponseId,
            model: finalModel,
            test_sequence: index,
          },
        })}\n\n`,
      );
    }
  }

  if (Number.isInteger(parsed.test_stream_pre_progress_metadata_bytes)) {
    chunks.push(
      `data: ${JSON.stringify({
        type: "response.in_progress",
        response: {
          id: finalResponseId,
          model: finalModel,
          test_padding: "x".repeat(parsed.test_stream_pre_progress_metadata_bytes),
        },
      })}\n\n`,
    );
  }

  if (
    selectStreamFlag(parsed, "test_include_stream_reasoning_item", sequenceCount) ||
    (Array.isArray(parsed.include) && parsed.include.includes("reasoning.encrypted_content"))
  ) {
    const reasoningItem = {
      id: parsed.test_stream_reasoning_id ?? "rs_test_1",
      type: "reasoning",
      encrypted_content:
        parsed.test_stream_reasoning_encrypted_content ?? "encrypted-test-content",
      summary: [],
    };
    if (parsed.test_stream_reasoning_item_location === "response_output") {
      let snapshotOutputText = undefined;
      if (Array.isArray(parsed.test_stream_snapshot_output_text_sequence)) {
        const index = Math.min(sequenceCount, parsed.test_stream_snapshot_output_text_sequence.length - 1);
        snapshotOutputText = parsed.test_stream_snapshot_output_text_sequence[index];
      } else if (parsed.test_stream_snapshot_output_text !== undefined) {
        snapshotOutputText = parsed.test_stream_snapshot_output_text;
      }
      const snapshotPayload = {
        type: "response.output_snapshot",
        response: {
          output: [reasoningItem],
        },
      };
      if (snapshotOutputText !== undefined && snapshotOutputText !== null) {
        const snapshotText = `${snapshotOutputText}`;
        snapshotPayload.output_text = snapshotText;
        snapshotPayload.response.output_text = snapshotText;
        snapshotPayload.response.output.push({
          id: "msg_snapshot_tentative_1",
          type: "message",
          content: [{ type: "output_text", text: snapshotText }],
        });
      }
      chunks.push(
        `data: ${JSON.stringify(snapshotPayload)}\n\n`,
      );
    } else {
      chunks.push(
        `data: ${JSON.stringify({
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: reasoningItem.id,
            type: "reasoning",
            summary: [],
          },
        })}\n\n`,
      );
      chunks.push(
        `data: ${JSON.stringify({
          type: "response.output_item.done",
          output_index: 0,
          item: reasoningItem,
        })}\n\n`,
      );
    }
  }

  if (selectStreamFlag(parsed, "test_include_stream_compaction_item", sequenceCount)) {
    const compactionItem = {
      id: parsed.test_stream_compaction_id ?? "cmp_test_1",
      type: "compaction",
      encrypted_content:
        parsed.test_stream_compaction_encrypted_content ?? "encrypted-compaction-test-content",
    };
    chunks.push(
      `data: ${JSON.stringify({
        type: "response.output_item.added",
        output_index: 0,
        item: { id: compactionItem.id, type: compactionItem.type },
      })}\n\n`,
    );
    chunks.push(
      `data: ${JSON.stringify({
        type: "response.output_item.done",
        output_index: 0,
        item: compactionItem,
      })}\n\n`,
    );
  }

  if (parsed.test_include_stream_escaped_encrypted_content) {
    chunks.push(
      `data: {"type":"response.output_item.done","item":{"id":"rs_escaped_test_1","type":"reasoning","encrypted\\u005fcontent":"escaped-encrypted-test-content","summary":[]}}\n\n`,
    );
  }
  if (parsed.test_include_stream_malformed_encrypted_content) {
    chunks.push(
      `data: {"type":"response.output_item.done","item":{"id":"rs_malformed_test_1","type":"reasoning","encrypted_content":"malformed-encrypted-test-content"\n\n`,
    );
  }
  if (parsed.test_include_stream_sensitive_metadata_line) {
    chunks.push(
      `event: encrypted_content=${parsed.test_stream_metadata_secret ?? "metadata-line-encrypted-secret"}\ndata: {"type":"response.output_text.delta","delta":"metadata-clean"}\n\n`,
    );
  }
  if (parsed.test_include_empty_commentary_event) {
    chunks.push(
      `data: ${JSON.stringify({
        type: "response.commentary.delta",
        delta: "",
      })}\n\n`,
    );
  }

  const outputText = selectStreamOutputText(parsed, sequenceCount);
  if (outputText) {
    const outputDeltaPayload = {
      type: "response.output_text.delta",
      delta: outputText,
    };
    if (parsed.test_stream_reasoning_in_output_chunk) {
      outputDeltaPayload.usage = {
        output_tokens_details: {
          reasoning_tokens: reasoning,
        },
      };
    }
    chunks.push(`data: ${JSON.stringify(outputDeltaPayload)}\n\n`);
  }

  if (selectStreamFlag(parsed, "test_include_stream_message_item", sequenceCount)) {
    const messageId = parsed.test_stream_message_item_id ?? "msg_test_1";
    const messageText = parsed.test_stream_message_item_text ?? "tentative-message";
    chunks.push(
      `data: ${JSON.stringify({
        type: "response.output_item.added",
        output_index: 1,
        item: {
          id: messageId,
          type: "message",
          role: "assistant",
          content: [],
        },
      })}\n\n`,
    );
    chunks.push(
      `data: ${JSON.stringify({
        type: "response.content_part.added",
        output_index: 1,
        item_id: messageId,
        content_index: 0,
        part: { type: "output_text", text: "" },
      })}\n\n`,
    );
    chunks.push(
      `data: ${JSON.stringify({
        type: "response.output_text.delta",
        output_index: 1,
        item_id: messageId,
        content_index: 0,
        delta: messageText,
      })}\n\n`,
    );
    chunks.push(
      `data: ${JSON.stringify({
        type: "response.output_item.done",
        output_index: 1,
        item: {
          id: messageId,
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: messageText }],
        },
      })}\n\n`,
    );
  }
  if (selectStreamFlag(parsed, "test_include_stream_function_call", sequenceCount)) {
    const functionCallId = parsed.test_stream_function_call_id ?? "fc_test_1";
    const callId = parsed.test_stream_function_call_call_id ?? "call_test_1";
    const functionName = parsed.test_stream_function_call_name ?? "shell";
    const functionArguments =
      parsed.test_stream_function_call_arguments ?? "{\"cmd\":\"ls\"}";
    chunks.push(
      `data: ${JSON.stringify({
        type: "response.output_item.added",
        output_index: 1,
        item: {
          id: functionCallId,
          type: "function_call",
          name: functionName,
          call_id: callId,
        },
      })}\n\n`,
    );
    chunks.push(
      `data: ${JSON.stringify({
        type: "response.function_call_arguments.delta",
        output_index: 1,
        item_id: functionCallId,
        delta: functionArguments,
      })}\n\n`,
    );
    chunks.push(
      `data: ${JSON.stringify({
        type: "response.output_item.done",
        output_index: 1,
        item: {
          id: functionCallId,
          type: "function_call",
          name: functionName,
          call_id: callId,
          arguments: functionArguments,
        },
      })}\n\n`,
    );
  }
  models.forEach((model, index) => {
    const deltaPayload = {
      type: "response.model.delta",
      model,
      system_fingerprint: fingerprints[index] ?? finalFingerprint,
      service_tier: serviceTier,
      response: {
        model,
      },
    };
    if (!parsed.test_stream_delta_omit_response_id) {
      deltaPayload.response.id = responseIds[index] ?? finalResponseId;
    }
    if (eventIds[index]) {
      deltaPayload.id = eventIds[index];
    }
    chunks.push(`data: ${JSON.stringify(deltaPayload)}\n\n`);
  });

  const completedPayload = {
    type: "response.completed",
    system_fingerprint: finalFingerprint,
    service_tier: serviceTier,
    response: {
      id: finalResponseId,
      model: finalModel,
      usage: {
        output_tokens_details: {
          reasoning_tokens: reasoning,
        },
      },
    },
  };
  if (Number.isInteger(parsed.test_stream_completed_padding_bytes)) {
    completedPayload.response.test_padding = "x".repeat(parsed.test_stream_completed_padding_bytes);
  }
  if (parsed.test_response_fault_marker) {
    completedPayload.test_response_fault_marker = parsed.test_response_fault_marker;
  }
  if (parsed.test_include_final_answer_only) {
    completedPayload.response.output = [
      {
        type: "message",
        content: [{ type: "output_text", text: "visible final answer" }],
      },
    ];
  }
  const completedChunk = `data: ${JSON.stringify(completedPayload)}\n\n`;
  if (parsed.test_stream_only_completed_event) {
    return [completedChunk];
  }
  chunks.push(completedChunk);
  if (!parsed.test_stream_omit_done) {
    chunks.push("data: [DONE]\n\n");
  }
  return chunks;
}

function buildChatCompletionStreamChunks(parsed, reasoning) {
  const models = buildStreamModels(parsed);
  const fingerprints = buildStreamFingerprints(parsed, models.length);
  const finalModel =
    parsed.test_stream_final_model ?? models[models.length - 1];
  const finalFingerprint =
    fingerprints[fingerprints.length - 1] ?? fingerprints[0] ?? "fp_chat_1";
  const chunks = [
    `data: ${JSON.stringify({
      id: "chunk-1",
      model: models[0],
      system_fingerprint: fingerprints[0] ?? finalFingerprint,
      choices: [{ delta: { content: "hello" } }],
    })}\n\n`,
  ];

  for (let index = 1; index < models.length; index += 1) {
    chunks.push(
      `data: ${JSON.stringify({
        id: `chunk-${index + 1}`,
        model: models[index],
        system_fingerprint: fingerprints[index] ?? finalFingerprint,
        choices: [{ delta: { content: " world" } }],
      })}\n\n`,
    );
  }

  chunks.push(
    `data: ${JSON.stringify({
      model: finalModel,
      system_fingerprint: finalFingerprint,
      usage: {
        completion_tokens_details: {
          reasoning_tokens: reasoning,
        },
      },
    })}\n\n`,
  );
  chunks.push("data: [DONE]\n\n");
  return chunks;
}

function decodeHtmlEntities(value) {
  return String(value)
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function encodeHtmlAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll(">", "&gt;")
    .replaceAll("<", "&lt;");
}

function markEvidenceDetailsOpen(element, sampleKey) {
  const encodedKey = encodeHtmlAttribute(sampleKey);
  const closedTag = `<details class="evidence-details" data-sample-key="${encodedKey}">`;
  const openTag = `<details class="evidence-details" data-sample-key="${encodedKey}" open>`;
  element.innerHTML = element.innerHTML.replace(closedTag, openTag);
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = String(tagName).toUpperCase();
    this.textContent = "";
    this.innerHTML = "";
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.href = "";
    this.style = {};
    this.dataset = {};
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.listeners = new Map();
    const classNames = new Set();
    this.classList = {
      add: (...values) => {
        for (const value of values) {
          classNames.add(value);
        }
      },
      remove: (...values) => {
        for (const value of values) {
          classNames.delete(value);
        }
      },
      contains: (value) => classNames.has(value),
      toggle: (value, force) => {
        const shouldAdd = force === undefined ? !classNames.has(value) : Boolean(force);
        if (shouldAdd) {
          classNames.add(value);
        } else {
          classNames.delete(value);
        }
        return shouldAdd;
      },
    };
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type).push(handler);
  }

  emit(type, event) {
    const handlers = this.listeners.get(type) || [];
    for (const handler of handlers) {
      handler(event);
    }
  }

  querySelectorAll(selector) {
    if (selector !== ".evidence-details[data-sample-key][open]") {
      return [];
    }
    const regex =
      /<details class="evidence-details" data-sample-key="([^"]+)" open>/g;
    const results = [];
    let current;
    while ((current = regex.exec(this.innerHTML)) !== null) {
      const sampleKey = decodeHtmlEntities(current[1]);
      results.push({
        getAttribute(name) {
          return name === "data-sample-key" ? sampleKey : null;
        },
      });
    }
    return results;
  }

  setAttribute(name, value) {
    this[name] = value;
  }
}

async function verifyRenderedUiEvidenceDetailsBehavior(uiHtml) {
  const inlineScriptMatch = uiHtml.match(/<script>([\s\S]*)<\/script>/);
  assert(inlineScriptMatch, "管理页缺少内联脚本");

  const upstreamErrorPolicySelectors = [
    ["modelUnavailableErrorActionSelect", "model_unavailable_error_action"],
    ["http502503ErrorActionSelect", "http_502_503_error_action"],
    ["otherHttp4xxErrorActionSelect", "other_http_4xx_error_action"],
    ["otherHttp5xxErrorActionSelect", "other_http_5xx_error_action"],
    ["errorMessageFallbackActionSelect", "error_message_fallback_action"],
  ];
  const upstreamErrorActions = [
    "pass_through",
    "return_502",
    "retry_then_pass_through",
    "retry_then_502",
  ];
  for (const [id, name] of upstreamErrorPolicySelectors) {
    const selectorMatch = uiHtml.match(
      new RegExp(`<select id="${id}" name="${name}">([\\s\\S]*?)<\\/select>`),
    );
    assert(selectorMatch, `管理页缺少 ${name} 下拉策略`);
    for (const action of upstreamErrorActions) {
      assert(
        selectorMatch[1].includes(`value="${action}"`),
        `${name} 下拉策略缺少 ${action} 动作`,
      );
    }
  }
  assert(
    inlineScriptMatch[1].includes("prefers-color-scheme: dark") &&
      inlineScriptMatch[1].includes("matchMedia") &&
      inlineScriptMatch[1].includes("addEventListener('change'"),
    "管理页主题未监听系统深浅色偏好变化",
  );

  const ids = [
    "configForm",
    "reasoningInput",
    "reasoningEqualsField",
    "reasoningEqualsHint",
    "reasoningMatchModeSelect",
    "interceptRuleModeSelect",
    "interceptRuleModeReasoningTokensInput",
    "interceptRuleModeFinalOnlyInput",
    "interceptStreamingInput",
    "interceptNonStreamingInput",
    "interceptModeValue",
    "policySummaryValue",
    "streamActionStrict502Input",
    "streamActionDisconnectInput",
    "streamActionContinuationRecoveryInput",
    "endpointsInput",
    "statusCodeInput",
    "guardRetryAttemptsInput",
    "capacityErrorActionSelect",
    "http429ActionSelect",
    "modelUnavailableErrorActionSelect",
    "http502503ErrorActionSelect",
    "otherHttp4xxErrorActionSelect",
    "otherHttp5xxErrorActionSelect",
    "errorMessageFallbackActionSelect",
    "transientRetryEnabledInput",
    "transientRetryInitialDelayMsInput",
    "transientRetryMaxDelayMsInput",
    "latencyGuardEnabledInput",
    "firstProgressTimeoutMsInput",
    "firstProgressActionSelect",
    "totalTimeoutMsInput",
    "retryUpstreamCapacityErrorsInput",
    "logMatchInput",
    "probeTargetFamily54Input",
    "probeTargetFamily55Input",
    "probeTargetFamily56SolInput",
    "probeTargetFamily56TerraInput",
    "probeTargetFamily56LunaInput",
    "probeAutoEnabledInput",
    "probeIntervalMinutesInput",
    "saveButton",
    "reasoningExportJsonButton",
    "reasoningExportCsvButton",
    "reasoningRangeTodayButton",
    "reasoningRangeWeekButton",
    "reasoningRangeApplyButton",
    "reasoningDateFromInput",
    "reasoningDateToInput",
    "probeRunButton",
    "restoreButton",
    "messageBox",
    "listenValue",
    "upstreamValue",
    "providerValue",
    "codexBaseUrlValue",
    "configPathValue",
    "backupPathValue",
    "startedAtValue",
    "proxyRequestCountValue",
    "inspectedCountValue",
    "matchedCountValue",
    "blockedRatioValue",
    "matchedStreamingCountValue",
    "matchedNonStreamingCountValue",
    "blockedCountValue",
    "blockedStreamingCountValue",
    "blockedNonStreamingCountValue",
    "continuationRecoveryCountValue",
    "continuationRecoverySuccessRatioValue",
    "reasoningTotalSamplesValue",
    "reasoningFinalOnlyRatioValue",
    "reasoningCommentaryRatioValue",
    "reasoningAvgDurationValue",
    "reasoningAvgOutputTpsValue",
    "reasoningAvgAdjustedTpsValue",
    "reasoningExportMeta",
    "reasoningExportProgress",
    "reasoningExportProgressFill",
    "reasoningExportProgressText",
    "reasoningExportDownloadLink",
    "reasoningRangeChip",
    "reasoningTopTokensChart",
    "reasoningOutputTpsChart",
    "reasoningByModelFamilyBody",
    "reasoningByEffortBody",
    "reasoningByFamilyEffortBody",
    "reasoningTokenTableLimitSelect",
    "reasoningCandidatePatternLimitSelect",
    "reasoningRecentSamplesLimitSelect",
    "reasoningByTokenBody",
    "reasoningCandidatePatternsBody",
    "reasoningRecentSamplesBody",
    "reasoningAnalysisModelFamilyInput",
    "reasoningAnalysisEffortInput",
    "reasoningAnalysisTokenInput",
    "reasoningAnalysisFinalOnlySelect",
    "reasoningAnalysisCommentarySelect",
    "reasoningAnalysisStatusSelect",
    "reasoningAnalysisIncludeRetriesInput",
    "reasoningAnalysisIncludeBlockedInput",
    "reasoningAnalyzeButton",
    "reasoningAnalysisValue",
    "reasoningAnalysisConclusion",
    "reasoningAnalysisCoverageBody",
    "reasoningAnalysisCandidateSummaryValue",
    "reasoningAnalysisBaselineValue",
    "historicalImportRunButton",
    "historicalImportProgress",
    "historicalImportProgressFill",
    "historicalImportProgressText",
    "historicalImportSummaryValue",
    "historicalImportAnalysisValue",
    "historicalImportAnalysisConclusion",
    "historicalImportCoverageBody",
    "historicalImportCandidateSummaryValue",
    "historicalImportBaselineValue",
    "historicalImportSourcesBody",
    "historicalImportCcModelsBody",
    "historicalImportCodexLogsBody",
    "historicalImportSessionsBody",
    "modelMatchRatioValue",
    "modelMismatchCountValue",
    "lowContextFamilyCountValue",
    "modelDriftCountValue",
    "fingerprintDriftCountValue",
    "rebuildSuspectedCountValue",
    "probeEnabledValue",
    "probeTargetModelValue",
    "probeLastRunValue",
    "probePassCountValue",
    "probeWarningCountValue",
    "probeViolationCountValue",
    "probeTransportErrorCountValue",
    "probeSamplesBody",
    "suspiciousSamplesBody",
    "statsFootnote",
    "logsMeta",
    "logsOutput",
    "themeToggleButton",
    "themeToggleIcon",
    "themeToggleText",
  ];
  const elements = Object.fromEntries(
    ids.map((id) => [
      id,
      new FakeElement(id === "configForm" ? "form" : "div"),
    ]),
  );
  elements.statusCodeInput.value = "502";
  elements.guardRetryAttemptsInput.value = "3";
  elements.capacityErrorActionSelect.value = "retry_then_502";
  elements.http429ActionSelect.value = "return_502";
  elements.modelUnavailableErrorActionSelect.value = "return_502";
  elements.http502503ErrorActionSelect.value = "retry_then_502";
  elements.otherHttp4xxErrorActionSelect.value = "pass_through";
  elements.otherHttp5xxErrorActionSelect.value = "retry_then_pass_through";
  elements.errorMessageFallbackActionSelect.value = "return_502";
  elements.transientRetryEnabledInput.checked = true;
  elements.transientRetryInitialDelayMsInput.value = "1000";
  elements.transientRetryMaxDelayMsInput.value = "600000";
  elements.latencyGuardEnabledInput.checked = true;
  elements.firstProgressTimeoutMsInput.value = "1500";
  elements.firstProgressActionSelect.value = "retry_then_502";
  elements.totalTimeoutMsInput.value = "9000";
  elements.retryUpstreamCapacityErrorsInput.checked = true;
  elements.reasoningAnalysisTokenInput.value = "516";
  elements.reasoningAnalysisModelFamilyInput.value = "gpt-5.4,gpt-5.5";
  elements.reasoningAnalysisEffortInput.value = "high,medium";
  elements.reasoningAnalysisFinalOnlySelect.value = "true";
  elements.reasoningAnalysisCommentarySelect.value = "not_observed";
  elements.reasoningAnalysisStatusSelect.value = "any";
  elements.reasoningAnalysisIncludeRetriesInput.checked = true;
  elements.reasoningAnalysisIncludeBlockedInput.checked = true;

  const statusPayload = {
    listen: "http://127.0.0.1:4610",
    config: {
      upstream_base_url: "http://upstream.example",
      intercept_rule_mode: "reasoning_tokens",
      reasoning_match_mode: "manual",
      reasoning_equals: [516],
      intercept_streaming: true,
      intercept_non_streaming: true,
      endpoints: ["/responses"],
      non_stream_status_code: 502,
      guard_retry_attempts: 3,
      capacity_error_action: "retry_then_pass_through",
      http_429_action: "pass_through",
      model_unavailable_error_action: "retry_then_pass_through",
      http_502_503_error_action: "retry_then_pass_through",
      other_http_4xx_error_action: "retry_then_pass_through",
      other_http_5xx_error_action: "retry_then_pass_through",
      error_message_fallback_action: "retry_then_pass_through",
      transient_retry: {
        enabled: true,
        initial_delay_ms: 1000,
        max_delay_ms: 600000,
      },
      latency_guard: {
        enabled: false,
        first_progress_timeout_ms: 0,
        first_progress_action: "return_502",
        total_timeout_ms: 0,
      },
      retry_upstream_capacity_errors: true,
      log_match: true,
      active_probe: {
        enabled: true,
        interval_ms: 10 * 60 * 1000,
        target_families: [
          "gpt-5.4",
          "gpt-5.5",
          "gpt-5.6-sol",
          "gpt-5.6-terra",
          "gpt-5.6-luna",
        ],
      },
    },
    state: {
      provider_name: "test",
      codex_current_base_url: "http://127.0.0.1:4610",
      latest_backup_path: "backup.json",
    },
    paths: {
      config_path: "config.json",
    },
    metrics: {
      started_at: "2026-06-28T00:00:00.000Z",
      total_proxy_request_count: 15,
      inspected_response_count: 4,
      bypassed_proxy_request_count: 9,
      bypassed_proxy_path_counts: {
        "/v1/models": 2,
        "/assets/index-mL8x2mJx.js": 2,
        "/assets/vendor-misc-DB0Q8XAf.css": 2,
        "/login": 1,
        "/logo.png": 1,
        "/api/v1/settings/public": 1,
      },
      failed_proxy_request_count: 0,
      active_proxy_request_count: 2,
      active_proxy_path_counts: {
        "/responses": 2,
      },
      reasoning_516_count: 0,
      reasoning_516_ratio: 0,
      matched_response_count: 2,
      matched_streaming_count: 1,
      matched_non_streaming_count: 1,
      blocked_response_count: 1,
      blocked_streaming_count: 1,
      blocked_non_streaming_count: 0,
      continuation_recovery_count: 5,
      continuation_recovery_success_count: 4,
      continuation_recovery_success_ratio: 0.8,
    },
    model_insights: {
      consistency: { match_ratio: 0, mismatched: 0 },
      anomalies: { low_context_family_count: 0 },
      single_request_anomalies: {
        model_drift_count: 0,
        fingerprint_drift_count: 0,
        rebuild_suspected_count: 0,
      },
      suspicious_samples: [],
    },
    active_probe: {
      enabled: true,
      running: false,
      last_target_model: "gpt-5.5",
      last_finished_at: "2026-06-28T03:20:00.000Z",
      pass_count: 1,
      warning_count: 2,
      violation_count: 3,
      transport_error_count: 4,
      recent_samples: [
        {
          ts: "2026-06-28T03:21:00.000Z",
          probe_type: "identity_consistency",
          target_model: "gpt-5.5",
          endpoint_path: "/responses",
          result: "warning",
          result_type: "probe_identity_consistency_warning",
          confidence: "medium",
          http_status: 200,
          duration_ms: 42,
          upstream_model: "gpt-5.5",
          observed_fingerprints: ["fp_probe_1"],
          evidence_logs: [
            {
              at: "2026-06-28T03:21:00.000Z",
              message: "[probe] warning type=identity_consistency",
            },
          ],
        },
      ],
    },
  };
  const logsPayload = {
    total_entries: 1,
    latest_seq: 1,
    entries: [
      {
        seq: 1,
        at: "2026-06-28T03:18:23.000Z",
        message: "demo log",
      },
    ],
  };
  const reasoningBehaviorPayload = {
    summary: {
      total_samples: 4,
      final_answer_only_ratio: 0.5,
      commentary_present_ratio: 0.25,
      avg_duration_total_ms: 1200,
      avg_output_tps: 18.5,
      avg_reasoning_adjusted_tps: 42.25,
      wording:
        "统计结果只表示可观测结构信号，用于发现候选异常特征，不代表最终归因，也不证明模型内部没有思考。final answer only / commentary observed 不是互补关系，剩余样本可能是 tool call、reasoning item 或普通 output 组合。",
    },
    top_reasoning_tokens: [
      { value: 516, count: 2, ratio: 0.5 },
      { value: 128, count: 1, ratio: 0.25 },
    ],
    output_tps_buckets: [
      { label: "0-5", count: 0 },
      { label: "5-15", count: 1 },
      { label: "15-30", count: 3 },
    ],
    by_model_family: [
      {
        model_family: "gpt-5.5",
        count: 3,
        ratio: 0.75,
        final_answer_only_ratio: 2 / 3,
        commentary_present_ratio: 1 / 3,
        avg_duration_total_ms: 1050,
        avg_output_tps: 19,
        top_reasoning_tokens: [
          { value: 516, count: 2 },
          { value: 128, count: 1 },
        ],
      },
      {
        model_family: "gpt-5.4",
        count: 1,
        ratio: 0.25,
        final_answer_only_ratio: 0,
        commentary_present_ratio: 0,
        avg_duration_total_ms: 1650,
        avg_output_tps: 14,
        top_reasoning_tokens: [{ value: 128, count: 1 }],
      },
    ],
    by_reasoning_effort: [
      {
        reasoning_effort: "high",
        count: 2,
        ratio: 0.5,
        final_answer_only_ratio: 0.5,
        commentary_present_ratio: 0,
        avg_duration_total_ms: 980,
        avg_reasoning_adjusted_tps: 41,
        top_reasoning_tokens: [{ value: 516, count: 2 }],
      },
      {
        reasoning_effort: "medium",
        count: 2,
        ratio: 0.5,
        final_answer_only_ratio: 0.5,
        commentary_present_ratio: 0.5,
        avg_duration_total_ms: 1420,
        avg_reasoning_adjusted_tps: 33,
        top_reasoning_tokens: [{ value: 128, count: 2 }],
      },
    ],
    by_model_family_and_effort: [
      {
        group_key: "gpt-5.5|high",
        group_label: "gpt-5.5 / high",
        model_family: "gpt-5.5",
        reasoning_effort: "high",
        count: 2,
        ratio: 0.5,
        final_answer_only_ratio: 0.5,
        commentary_present_ratio: 0,
        avg_duration_total_ms: 980,
        avg_output_tps: 21,
        top_reasoning_tokens: [{ value: 516, count: 2 }],
      },
      {
        group_key: "gpt-5.4|medium",
        group_label: "gpt-5.4 / medium",
        model_family: "gpt-5.4",
        reasoning_effort: "medium",
        count: 1,
        ratio: 0.25,
        final_answer_only_ratio: 0,
        commentary_present_ratio: 0,
        avg_duration_total_ms: 1650,
        avg_output_tps: 14,
        top_reasoning_tokens: [{ value: 128, count: 1 }],
      },
    ],
    by_reasoning_token: [
      {
        value: 516,
        count: 2,
        final_answer_only_ratio: 1,
        commentary_present_ratio: 0,
        avg_duration_total_ms: 900,
        avg_output_tps: 21,
        last_seen_at: "2026-06-28T03:21:00.000Z",
      },
      ...Array.from({ length: 12 }, (_, index) => ({
        value: 7000 + index,
        count: 1,
        final_answer_only_ratio: 0,
        commentary_present_ratio: 0,
        avg_duration_total_ms: 1000 + index,
        avg_output_tps: 10 + index,
        last_seen_at: "2026-06-28T03:20:00.000Z",
      })),
    ],
    candidate_patterns: [
      {
        pattern_key: "reasoning=516|final_answer_only|commentary_not_observed",
        count: 2,
        ratio: 0.5,
        avg_duration_total_ms: 900,
        avg_output_tps: 21,
        last_seen_at: "2026-06-28T03:21:00.000Z",
        status: "observe_only",
      },
      ...Array.from({ length: 12 }, (_, index) => ({
        pattern_key: `candidate-extra-${index}`,
        count: 1,
        ratio: 0.01,
        avg_duration_total_ms: 1200 + index,
        avg_output_tps: 12 + index,
        avg_time_normalization_deviation: 0.1 + index / 100,
        last_seen_at: "2026-06-28T03:20:00.000Z",
        status: "observe_only",
      })),
    ],
    recent_samples: [
      {
        ts: "2026-06-28T03:21:00.000Z",
        path: "/responses",
        request_model: "gpt-5.5",
        effective_local_model_family: "gpt-5.5",
        request_reasoning_effort: "high",
        reasoning_tokens: 516,
        output_tokens: 128,
        duration_total_ms: 900,
        output_tps: 21,
        upstream_http_status: 200,
        client_http_status: 502,
        final_answer_only: true,
        has_commentary: false,
        commentary_observed: false,
        matched_current_rule: true,
        blocked_by_gateway: true,
        final_action: "blocked",
      },
      ...Array.from({ length: 12 }, (_, index) => ({
        ts: "2026-06-28T03:20:00.000Z",
        path: `/responses/recent-extra-${index}`,
        request_model: `recent-extra-${index}`,
        effective_local_model_family: "gpt-5.5",
        request_reasoning_effort: "medium",
        reasoning_tokens: 128 + index,
        output_tokens: 256 + index,
        duration_total_ms: 1400 + index,
        output_tps: 16 + index,
        upstream_http_status: 200,
        client_http_status: 200,
        final_answer_only: false,
        has_commentary: true,
        commentary_observed: true,
        matched_current_rule: false,
        blocked_by_gateway: false,
        final_action: "passed",
      })),
    ],
  };
  const reasoningAnalysisPayload = {
    ok: true,
    analysis_profile: "516_candidate_review_v1",
    analysis_value: "valuable",
    conclusion: "candidate",
    field_coverage: {
      reasoning_tokens: 1,
      final_answer_only: 1,
      commentary_observed: 1,
      duration_total_ms: 1,
      output_tokens: 1,
      model_family: 1,
      reasoning_effort: 1,
    },
    candidate_summary: {
      candidate_count: 2,
      candidate_ratio: 0.5,
      reasoning_516_count: 2,
      commentary_not_observed_count: 2,
      last_seen_at: "2026-06-28T03:21:00.000Z",
    },
    baseline_comparison: {
      baseline_count: 2,
      candidate_avg_time_normalization_deviation: 0.82,
      baseline_avg_time_normalization_deviation: 0.13,
    },
    samples_preview: [],
  };
  const fetchCalls = [];
  const fetchBodies = [];
  const exportJobs = new Map();
  const historicalImportJobs = new Map();
  let runProbeRequestCount = 0;
  let historicalImportRunCount = 0;
  let locationReloadCount = 0;
  const openedUrls = [];

  const fetchMock = async (url, options = {}) => {
    fetchCalls.push(String(url));
    if (options?.body) {
      fetchBodies.push({
        url: String(url),
        method: String(options?.method || "GET"),
        body: String(options.body),
      });
    }
    if (String(url).includes("/api/status")) {
      return {
        ok: true,
        async json() {
          return statusPayload;
        },
      };
    }
    if (String(url).includes("/api/analytics/reasoning/export/jobs/")) {
      const urlText = String(url);
      const jobId = decodeURIComponent(
        urlText.split("/api/analytics/reasoning/export/jobs/")[1]?.split("/")[0] || "",
      );
      const job = exportJobs.get(jobId) || {
        job_id: jobId,
        status: "completed",
        progress: { processed_days: 40, total_days: 40, percent: 1 },
        download_url: `/__codex_retry_gateway/api/analytics/reasoning/export/jobs/${encodeURIComponent(jobId)}/download`,
      };
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, export_job: job };
        },
      };
    }
    if (String(url).includes("/api/analytics/reasoning/export")) {
      const jobId = "ui-export-job-1";
      const job = {
        job_id: jobId,
        status: "running",
        format: String(url).includes("format=csv") ? "csv" : "json",
        progress: { processed_days: 0, total_days: 40, percent: 0 },
        download_url: null,
      };
      exportJobs.set(jobId, {
        ...job,
        status: "completed",
        progress: { processed_days: 40, total_days: 40, percent: 1 },
        download_url: `/__codex_retry_gateway/api/analytics/reasoning/export/jobs/${encodeURIComponent(jobId)}/download`,
      });
      return {
        ok: true,
        status: 202,
        async json() {
          return {
            ok: true,
            export_job: job,
            message: "已创建后台导出任务，可以继续正常使用 gateway。",
          };
        },
      };
    }
    if (String(url).includes("/api/analytics/reasoning/analyze")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return reasoningAnalysisPayload;
        },
      };
    }
    if (String(url).includes("/api/analytics/reasoning")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return reasoningBehaviorPayload;
        },
      };
    }
    if (String(url).includes("/api/analytics/imports/analyze")) {
      const job = historicalImportJobs.get("ui-import-job-1") || null;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            ...(job?.feature_analysis || {
              analysis_profile: "516_candidate_review_v1",
              analysis_value: "no_analysis_value",
              conclusion: "no_analysis_value",
              field_coverage: {},
              candidate_summary: { candidate_count: 0, candidate_ratio: 0 },
              baseline_comparison: { baseline_count: 0 },
              samples_preview: [],
            }),
          };
        },
      };
    }
    if (String(url).includes("/api/analytics/imports/jobs/")) {
      const urlText = String(url);
      const jobId = decodeURIComponent(
        urlText.split("/api/analytics/imports/jobs/")[1]?.split("/")[0] || "",
      );
      const job = historicalImportJobs.get(jobId) || {
        job_id: jobId,
        status: "completed",
        progress: {
          processed_sources: 3,
          total_sources: 3,
          percent: 1,
          current_step: "completed",
        },
        summary: {
          source_count: 3,
          total_requests: 165965,
          successful_requests: 150000,
          failed_requests: 15965,
          total_input_tokens: 1234567,
          total_output_tokens: 765432,
          avg_latency_ms: 1880,
          codex_log_rows: 276092,
          session_file_count: 2000,
          session_total_bytes: 987654321,
        },
        preflight: {
          analysis_value: "no_analysis_value",
          can_build_reasoning_features: false,
          can_build_candidate_patterns: false,
          missing_core_fields: [
            "reasoning_tokens",
            "final_answer_only",
            "commentary_observed",
          ],
          field_coverage: {
            reasoning_tokens: 0,
            final_answer_only: 0,
            commentary_observed: 0,
            duration_total_ms: 1,
            output_tokens: 1,
            model_family: 1,
            reasoning_effort: 0,
          },
          decision_reason:
            "缺少 reasoning 行为核心结构字段，历史数据无分析价值。",
        },
        feature_analysis: {
          ok: true,
          analysis_profile: "516_candidate_review_v1",
          analysis_value: "no_analysis_value",
          conclusion: "no_analysis_value",
          field_coverage: {
            reasoning_tokens: 0,
            final_answer_only: 0,
            commentary_observed: 0,
            duration_total_ms: 1,
            output_tokens: 1,
            model_family: 1,
            reasoning_effort: 0,
          },
          candidate_summary: { candidate_count: 0, candidate_ratio: 0 },
          baseline_comparison: { baseline_count: 0 },
          samples_preview: [],
        },
        sources: [
          {
            source_type: "cc_switch_sqlite",
            path: "C:/Users/dashuai/.cc-switch/cc-switch.db",
            status: "completed",
            row_count: 165965,
          },
          {
            source_type: "codex_logs_sqlite",
            path: "C:/Users/dashuai/.codex/sqlite/logs_2.sqlite",
            status: "completed",
            row_count: 276092,
          },
        ],
        cc_switch: {
          by_model: [
            {
              model: "gpt-5.5",
              count: 1000,
              success_count: 900,
              failure_count: 100,
              avg_duration_ms: 2100,
              input_tokens: 500000,
              output_tokens: 200000,
            },
          ],
        },
        codex_logs: {
          by_level: [{ level: "INFO", count: 200000 }],
          keyword_hits: [{ keyword: "reasoning_tokens", count: 128 }],
        },
        sessions: {
          file_count: 2000,
          total_bytes: 987654321,
          top_files: [
            {
              path: "C:/Users/dashuai/.codex/sessions/2026/06/demo.jsonl",
              bytes: 123456789,
              modified_at: "2026-06-30T12:00:00.000Z",
            },
          ],
        },
      };
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, import_job: job };
        },
      };
    }
    if (String(url).includes("/api/analytics/imports/run")) {
      historicalImportRunCount += 1;
      const jobId = "ui-import-job-1";
      const job = {
        job_id: jobId,
        status: "running",
        progress: {
          processed_sources: 0,
          total_sources: 3,
          percent: 0,
          current_step: "扫描历史数据源",
        },
        summary: null,
      };
      historicalImportJobs.set(jobId, {
        ...job,
        status: "completed",
        progress: {
          processed_sources: 3,
          total_sources: 3,
          percent: 1,
          current_step: "completed",
        },
        summary: {
          source_count: 3,
          total_requests: 165965,
          successful_requests: 150000,
          failed_requests: 15965,
          total_input_tokens: 1234567,
          total_output_tokens: 765432,
          avg_latency_ms: 1880,
          codex_log_rows: 276092,
          session_file_count: 2000,
          session_total_bytes: 987654321,
        },
        preflight: {
          analysis_value: "no_analysis_value",
          can_build_reasoning_features: false,
          can_build_candidate_patterns: false,
          missing_core_fields: [
            "reasoning_tokens",
            "final_answer_only",
            "commentary_observed",
          ],
          field_coverage: {
            reasoning_tokens: 0,
            final_answer_only: 0,
            commentary_observed: 0,
            duration_total_ms: 1,
            output_tokens: 1,
            model_family: 1,
            reasoning_effort: 0,
          },
          decision_reason:
            "缺少 reasoning 行为核心结构字段，历史数据无分析价值。",
        },
        feature_analysis: {
          ok: true,
          analysis_profile: "516_candidate_review_v1",
          analysis_value: "no_analysis_value",
          conclusion: "no_analysis_value",
          field_coverage: {
            reasoning_tokens: 0,
            final_answer_only: 0,
            commentary_observed: 0,
            duration_total_ms: 1,
            output_tokens: 1,
            model_family: 1,
            reasoning_effort: 0,
          },
          candidate_summary: { candidate_count: 0, candidate_ratio: 0 },
          baseline_comparison: { baseline_count: 0 },
          samples_preview: [],
        },
        sources: [
          {
            source_type: "cc_switch_sqlite",
            path: "C:/Users/dashuai/.cc-switch/cc-switch.db",
            status: "completed",
            row_count: 165965,
          },
        ],
        cc_switch: {
          by_model: [
            {
              model: "gpt-5.5",
              count: 1000,
              success_count: 900,
              failure_count: 100,
              avg_duration_ms: 2100,
              input_tokens: 500000,
              output_tokens: 200000,
            },
          ],
        },
        codex_logs: {
          by_level: [{ level: "INFO", count: 200000 }],
          keyword_hits: [{ keyword: "reasoning_tokens", count: 128 }],
        },
        sessions: {
          file_count: 2000,
          total_bytes: 987654321,
          top_files: [
            {
              path: "C:/Users/dashuai/.codex/sessions/2026/06/demo.jsonl",
              bytes: 123456789,
              modified_at: "2026-06-30T12:00:00.000Z",
            },
          ],
        },
      });
      return {
        ok: true,
        status: 202,
        async json() {
          return {
            ok: true,
            message: "历史导入分析已在后台开始，可以继续正常使用 gateway。",
            import_job: job,
          };
        },
      };
    }
    if (String(url).includes("/api/analytics/imports/latest")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            import_job: historicalImportJobs.get("ui-import-job-1") || null,
          };
        },
      };
    }
    if (String(url).includes("/api/logs")) {
      return {
        ok: true,
        async json() {
          return logsPayload;
        },
      };
    }
    if (String(url).includes("/api/config")) {
      const submitted = JSON.parse(String(options?.body || "{}"));
      statusPayload.config = {
        ...statusPayload.config,
        ...submitted,
        active_probe: {
          ...(statusPayload.config?.active_probe || {}),
          ...(submitted.active_probe || {}),
        },
      };
      statusPayload.active_probe = {
        ...statusPayload.active_probe,
        enabled: Boolean(submitted.active_probe?.enabled),
        interval_ms:
          submitted.active_probe?.interval_ms ??
          statusPayload.active_probe?.interval_ms,
        target_families: Array.isArray(submitted.active_probe?.target_families)
          ? [...submitted.active_probe.target_families]
          : statusPayload.active_probe?.target_families,
      };
      return {
        ok: true,
        async json() {
          return statusPayload;
        },
      };
    }
    if (String(url).includes("/api/probe/run")) {
      runProbeRequestCount += 1;
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            message: "probe started",
            active_probe: statusPayload.active_probe,
          };
        },
      };
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const sandbox = {
    console,
    URL,
    Date,
    Number,
    String,
    JSON,
    Promise,
    Set,
    Map,
    window: {
      location: {
        origin: "http://127.0.0.1:4610",
        reload() {
          locationReloadCount += 1;
        },
      },
      open(url) {
        openedUrls.push(String(url));
      },
      clearInterval() {},
      setInterval() {
        return 1;
      },
      setTimeout() {
        return 1;
      },
      confirm() {
        return true;
      },
    },
    document: {
      documentElement: { dataset: {} },
      getElementById(id) {
        return elements[id] || null;
      },
    },
    fetch: fetchMock,
  };
  const themeStorage = new Map([["codexRetryGatewayTheme", "system"]]);
  let systemThemeChangeListener = null;
  const systemThemeMediaQuery = {
    matches: true,
    addEventListener(eventName, listener) {
      if (eventName === "change") {
        systemThemeChangeListener = listener;
      }
    },
  };
  sandbox.window.localStorage = {
    getItem(key) {
      return themeStorage.get(key) || null;
    },
    setItem(key, value) {
      themeStorage.set(key, value);
    },
  };
  sandbox.window.matchMedia = (query) => {
    assert(query === "(prefers-color-scheme: dark)", "主题系统偏好查询不正确");
    return systemThemeMediaQuery;
  };
  sandbox.window.fetch = fetchMock;
  sandbox.window.document = sandbox.document;
  sandbox.window.window = sandbox.window;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(inlineScriptMatch[1]).runInContext(sandbox);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert(
    sandbox.document.documentElement.dataset.theme === "dark" &&
      elements.themeToggleText.textContent === "跟随系统" &&
      typeof systemThemeChangeListener === "function",
    "管理页未按 system 偏好解析深色主题或注册变化监听",
  );
  systemThemeMediaQuery.matches = false;
  systemThemeChangeListener({ matches: false });
  assert(
    sandbox.document.documentElement.dataset.theme === "light",
    "跟随系统时系统切换到浅色未立即更新页面主题",
  );
  elements.themeToggleButton.emit("click", {});
  assert(
    themeStorage.get("codexRetryGatewayTheme") === "light" &&
      sandbox.document.documentElement.dataset.theme === "light",
    "主题按钮在 system 后未切换到浅色偏好",
  );
  elements.themeToggleButton.emit("click", {});
  assert(
    themeStorage.get("codexRetryGatewayTheme") === "dark" &&
      sandbox.document.documentElement.dataset.theme === "dark",
    "主题按钮未从浅色切换到深色偏好",
  );
  elements.themeToggleButton.emit("click", {});
  assert(
    themeStorage.get("codexRetryGatewayTheme") === "system" &&
      sandbox.document.documentElement.dataset.theme === "light",
    "主题按钮未从深色切换回跟随系统偏好",
  );

  assert(
    typeof sandbox.renderSuspiciousSamples === "function",
    "管理页未暴露 renderSuspiciousSamples",
  );
  assert(
    typeof sandbox.buildSampleKey === "function",
    "管理页未暴露 buildSampleKey",
  );
  const expectedLogLine = `${new Date("2026-06-28T03:18:23.000Z").toLocaleString("zh-CN", { hour12: false })} demo log`;
  assert(
    elements.logsOutput.textContent.includes(expectedLogLine),
    "实时日志应显示与系统时间一致的本地时间",
  );
  assert(
    !elements.logsOutput.textContent.includes(
      "2026-06-28T03:18:23.000Z demo log",
    ),
    "实时日志不应直接显示原始 UTC 时间串",
  );
  assert(
    elements.statsFootnote.textContent.includes("/v1/models"),
    "运行状态脚注应提示未纳入检查的透传路径",
  );
  assert(
    elements.statsFootnote.textContent.includes("其余 3 项"),
    "运行状态脚注应对过多透传路径做摘要收敛",
  );
  assert(
    !elements.statsFootnote.textContent.includes("/api/v1/settings/public"),
    "运行状态脚注不应把所有透传路径完整展开",
  );
  assert(
    elements.statsFootnote.textContent.includes("/responses x2"),
    "运行状态脚注应继续提示进行中的代理请求路径",
  );
  assert(
    elements.probeEnabledValue.textContent.includes("已开启"),
    "主动探针状态未正确展示",
  );
  assert(
    elements.probeTargetModelValue.textContent === "gpt-5.5",
    "主动探针目标模型未正确展示",
  );
  assert(
    elements.probeWarningCountValue.textContent === "2",
    "主动探针 warning 次数未正确展示",
  );
  assert(
    elements.probeViolationCountValue.textContent === "3",
    "主动探针 violation 次数未正确展示",
  );
  assert(
    elements.probeTransportErrorCountValue.textContent === "4",
    "主动探针 transport_error 次数未正确展示",
  );
  assert(
    elements.probeTargetFamily54Input.checked === true,
    "主动探针未回填 gpt-5.4 复选框",
  );
  assert(
    elements.probeTargetFamily55Input.checked === true,
    "主动探针未回填 gpt-5.5 复选框",
  );
  for (const [elementId, model] of [
    ["probeTargetFamily56SolInput", "gpt-5.6-sol"],
    ["probeTargetFamily56TerraInput", "gpt-5.6-terra"],
    ["probeTargetFamily56LunaInput", "gpt-5.6-luna"],
  ]) {
    assert(elements[elementId].checked === true, `主动探针未回填 ${model} 复选框`);
  }
  assert(
    elements.probeAutoEnabledInput.checked === true,
    "主动探针未回填自动探测开关",
  );
  assert(
    elements.probeIntervalMinutesInput.value === "10",
    "主动探针未回填分钟频率",
  );
  assert(
    elements.interceptStreamingInput.checked === true,
    "管理页未回填流式拦截开关",
  );
  assert(
    elements.interceptNonStreamingInput.checked === true,
    "管理页未回填非流式拦截开关",
  );
  assert(
    elements.guardRetryAttemptsInput.value === "3",
    "管理页未回填网关内重试次数",
  );
  assert(
    elements.interceptRuleModeSelect.value === "reasoning_tokens",
    "管理页未回填 reasoning 规则模式",
  );
  assert(
    elements.capacityErrorActionSelect.value === "retry_then_pass_through",
    "管理页未回填 Capacity 动作",
  );
  assert(
    elements.http429ActionSelect.value === "pass_through",
    "管理页未回填 HTTP 429 动作",
  );
  for (const [id, name] of upstreamErrorPolicySelectors) {
    assert(
      elements[id].value === "retry_then_pass_through",
      `管理页未回填 ${name} 动作`,
    );
  }
  assert(
    elements.transientRetryEnabledInput.checked === true &&
      elements.transientRetryInitialDelayMsInput.value === "1000" &&
      elements.transientRetryMaxDelayMsInput.value === "600000",
    "管理页未回填临时故障自动恢复配置",
  );
  assert(
    elements.latencyGuardEnabledInput.checked === false &&
      elements.firstProgressTimeoutMsInput.value === "0" &&
      elements.firstProgressActionSelect.value === "return_502" &&
      elements.totalTimeoutMsInput.value === "0",
    "管理页未回填 latency_guard",
  );
  assert(
    elements.interceptModeValue.textContent.includes("流式+非流式"),
    "管理页未显示双开拦截模式",
  );
  assert(
    elements.reasoningMatchModeSelect.value === "manual",
    "管理页未回填 reasoning match 手动模式",
  );
  assert(
    elements.policySummaryValue.textContent.includes("516") &&
      elements.policySummaryValue.textContent.includes("最大内部尝试 3 次") &&
      elements.policySummaryValue.textContent.includes("仍命中返回 502"),
    `管理页未生成一眼可读的当前策略摘要: ${elements.policySummaryValue.textContent}`,
  );
  assert(
    elements.matchedCountValue.textContent === "2",
    "管理页未展示当前规则命中总数",
  );
  assert(
    elements.blockedCountValue.textContent === "1",
    "管理页未展示实际拦截总数",
  );
  assert(
    elements.blockedRatioValue.textContent === "25.00%",
    "管理页未展示实际拦截占比",
  );
  assert(
    elements.matchedStreamingCountValue.textContent === "1",
    "管理页未展示流式命中次数",
  );
  assert(
    elements.matchedNonStreamingCountValue.textContent === "1",
    "管理页未展示非流式命中次数",
  );
  assert(
    elements.blockedStreamingCountValue.textContent === "1",
    "管理页未展示流式拦截次数",
  );
  assert(
    elements.blockedNonStreamingCountValue.textContent === "0",
    "管理页未展示非流式拦截次数",
  );
  assert(
    elements.reasoningTotalSamplesValue.textContent === "4",
    "reasoning 行为统计未展示样本总数",
  );
  assert(
    elements.reasoningFinalOnlyRatioValue.textContent === "50.00%",
    "reasoning 行为统计未展示 final_answer only 占比",
  );
  assert(
    elements.reasoningCommentaryRatioValue.textContent === "25.00%",
    "reasoning 行为统计未展示 commentary observed 占比",
  );
  assert(
    elements.reasoningExportMeta.textContent.includes("候选异常特征"),
    "reasoning 行为统计未展示风险说明",
  );
  assert(
    uiHtml.includes("final answer only") && uiHtml.includes("commentary observed"),
    "reasoning 大盘 UI 应显示 final answer only / commentary observed 标准特征词",
  );
  assert(
    uiHtml.includes("运行特征分析") &&
      uiHtml.includes("analysis_value") &&
      uiHtml.includes("field_coverage") &&
      uiHtml.includes("conclusion"),
    "reasoning 大盘缺少特征分析入口或分析结果字段",
  );
  assert(
    uiHtml.includes('class="range-bar reasoning-range-toolbar"'),
    "reasoning 时间筛选和导出按钮应合并为同一行工具栏",
  );
  const reasoningToolbarMatch = uiHtml.match(
    /<div class="range-bar reasoning-range-toolbar">([\s\S]*?)<\/div>\s*<p class="reasoning-subtitle">特征分析条件<\/p>/,
  );
  assert(reasoningToolbarMatch, "reasoning 紧凑工具栏结构不正确");
  assert(
    [
      "reasoningDateFromInput",
      "reasoningDateToInput",
      "reasoningRangeTodayButton",
      "reasoningRangeWeekButton",
      "reasoningRangeApplyButton",
      "reasoningExportJsonButton",
      "reasoningExportCsvButton",
    ].every((id) => reasoningToolbarMatch[1].includes(id)),
    "reasoning 时间筛选和导出控件应在同一个工具栏内",
  );
  assert(
    uiHtml.includes(".reasoning-range-toolbar") &&
      uiHtml.includes("repeat(5, auto)") &&
      uiHtml.includes("font-size: 12px") &&
      uiHtml.includes(".reasoning-range-toolbar :is(input, button)") &&
      uiHtml.includes("min-height: 36px") &&
      uiHtml.includes("padding: 7px 12px"),
    "reasoning 时间筛选工具栏控件应使用紧凑尺寸",
  );
  assert(
    uiHtml.includes('id="sideNav"') &&
      uiHtml.includes('class="side-nav"') &&
      uiHtml.includes("快速导航"),
    "管理页缺少左侧快速导航",
  );
  assert(
    [
      'href="#topSection"',
      'href="#statusSection"',
      'href="#rulesSection"',
      'href="#reasoningBehaviorSection"',
      'href="#historicalImportSection"',
      'href="#modelSection"',
      'href="#probeSection"',
      'href="#logsSection"',
    ].every((anchor) => uiHtml.includes(anchor)),
    "侧边导航缺少关键功能区锚点",
  );
  assert(
    uiHtml.includes(".side-nav") &&
      uiHtml.includes("position: fixed") &&
      uiHtml.includes("top: 28px") &&
      uiHtml.includes("scroll-margin-top") &&
      uiHtml.includes("@media (max-width: 1339px)"),
    "侧边导航应固定在桌面侧边、对齐主内容顶部，并在窄屏退化",
  );
  assert(
    uiHtml.includes("width: 128px") &&
      uiHtml.includes("text-align: center") &&
      uiHtml.includes('html[data-theme="dark"] .side-nav-title') &&
      uiHtml.includes("color: #9fb2c8") &&
      uiHtml.includes("#0f1d2f") &&
      !uiHtml.includes("rgba(32, 230, 195, 0.1) 0, rgba(32, 230, 195, 0.1) 1px"),
    "侧边导航暗色配色应贴合页面，不应使用突兀亮青色斜纹或标题色",
  );
  assert(
    uiHtml.includes("max-width: 1080px") &&
      uiHtml.includes('<div class="shell">'),
    "新增导航不应改变原主体 shell 布局",
  );
  assert(
    uiHtml.includes("预检并分析"),
    "历史导入按钮应升级为预检并分析",
  );
  assert(
    uiHtml.includes("historical-import-control-stack") &&
      uiHtml.includes("historical-import-status") &&
      uiHtml.includes("historical-import-status-text") &&
      uiHtml.includes('id="historicalImportProgress" data-progress-active="false"'),
    "历史导入预检区应使用专用状态组件布局",
  );
  assert(
    uiHtml.includes(".historical-import-status") &&
      uiHtml.includes("justify-content: center") &&
      uiHtml.includes("text-align: center") &&
      uiHtml.includes('.historical-import-status[data-progress-active="false"] .bar-row') &&
      uiHtml.includes("display: none"),
    "历史导入状态组件应居中显示文字，并在未开始时隐藏空进度条",
  );
  assert(
    [
      "reasoningAnalysisModelFamilyInput",
      "reasoningAnalysisEffortInput",
      "reasoningAnalysisTokenInput",
      "reasoningAnalysisFinalOnlySelect",
      "reasoningAnalysisCommentarySelect",
      "reasoningAnalysisStatusSelect",
      "reasoningAnalyzeButton",
    ].every((id) => uiHtml.includes(id)),
    "reasoning 行为统计缺少分析条件控件",
  );
  assert(
    !uiHtml.includes("<label>commentary</label>") &&
      !uiHtml.includes("<th>commentary</th>"),
    "reasoning 大盘 UI 不应把 commentary observed 简写成 commentary",
  );
  assert(
    !uiHtml.includes("仅最终答案结构占比") &&
      !uiHtml.includes("可观测 commentary 阶段占比"),
    "reasoning 大盘 UI 不应把解释性中文长标签放进指标名",
  );
  assert(
    elements.reasoningExportMeta.textContent.includes("可观测结构信号") &&
      elements.reasoningExportMeta.textContent.includes("不证明模型内部没有思考"),
    "reasoning 大盘风险说明应解释 commentary/final only 口径",
  );
  assert(
    elements.reasoningExportMeta.textContent.includes("不是互补关系") &&
      elements.reasoningExportMeta.textContent.includes("tool call") &&
      elements.reasoningExportMeta.textContent.includes("reasoning item"),
    "reasoning 大盘风险说明应解释 final answer only/commentary observed 不是互补项",
  );
  assert(
    elements.reasoningRangeChip.textContent.includes("当前时间窗：默认最近窗口"),
    "reasoning 时间窗状态未明确展示默认范围",
  );
  assert(
    uiHtml.includes('class="range-chip range-status-chip" id="reasoningRangeChip"') &&
      /\.range-status-chip\s*\{\s*color:\s*var\(--muted\);\s*background:\s*rgba\(148,\s*163,\s*184,\s*0\.12\);\s*border:\s*1px solid rgba\(148,\s*163,\s*184,\s*0\.2\);\s*box-shadow:\s*none;\s*\}/.test(
        uiHtml,
      ) &&
      /html\[data-theme="dark"\]\s*\.range-status-chip\s*\{\s*color:\s*#cbd5e1;\s*background:\s*rgba\(148,\s*163,\s*184,\s*0\.12\);\s*border-color:\s*rgba\(148,\s*163,\s*184,\s*0\.22\);\s*\}/.test(
        uiHtml,
      ),
    "reasoning 时间窗状态应弱化为状态提示，避免像可点击按钮",
  );
  assert(
    /\.coverage-table-wrap\s*\{\s*width:\s*100%;\s*max-width:\s*none;\s*margin:\s*0;\s*overflow-x:\s*hidden;\s*\}/.test(
      uiHtml,
    ) &&
      uiHtml.includes(".coverage-table-wrap table") &&
      uiHtml.includes("min-width: 0") &&
      uiHtml.includes("width: 100%") &&
      uiHtml.includes("table-layout: fixed") &&
      uiHtml.includes(".coverage-table-wrap :is(th, td)") &&
      uiHtml.includes("text-align: center") &&
      uiHtml.includes("vertical-align: middle"),
    "reasoning field_coverage 表格应铺满所在内容区，避免太窄突兀",
  );
  assert(
    uiHtml.includes("range-chip-rail") &&
      uiHtml.includes("justify-content: center") &&
      uiHtml.includes("gap: 10px") &&
      uiHtml.includes(".range-chip-rail #reasoningExportProgress") &&
      uiHtml.includes("width: min(100%, 440px)") &&
      uiHtml.includes('<div class="range-chip-rail">'),
    "reasoning 状态 chip 应整体居中且宽度协调，避免组件挤在一起",
  );
  assert(
    elements.reasoningByTokenBody.innerHTML.includes("516"),
    "reasoning token 聚合表未渲染 516 行",
  );
  assert(
    uiHtml.includes('id="reasoningTokenTableLimitSelect"') &&
      uiHtml.includes('id="reasoningCandidatePatternLimitSelect"') &&
      uiHtml.includes('id="reasoningRecentSamplesLimitSelect"') &&
      uiHtml.includes("scroll-table-wrap"),
    "reasoning 行为统计表缺少显示数量选择或滚动容器",
  );
  assert(
    uiHtml.includes("white-space: nowrap") &&
      !uiHtml.includes(".scroll-table-wrap th") &&
      !uiHtml.includes("position: sticky"),
    "reasoning token 滚动表不应使用 sticky 表头，避免表头浮层覆盖第一行数据",
  );
  assert(
    uiHtml.includes(".scroll-table-wrap table") &&
      uiHtml.includes("width: max-content") &&
      uiHtml.includes(".scroll-table-wrap :is(th, td)"),
    "reasoning 滚动表应让内容撑出横向滚动，避免宽表被挤压换行",
  );
  assert(
    elements.reasoningByTokenBody.innerHTML.includes("7008") &&
      !elements.reasoningByTokenBody.innerHTML.includes("7009"),
    "reasoning token 聚合表默认应只显示 10 行，避免页面过长",
  );
  elements.reasoningTokenTableLimitSelect.value = "20";
  elements.reasoningTokenTableLimitSelect.emit("change", {});
  assert(
    elements.reasoningByTokenBody.innerHTML.includes("7011"),
    "reasoning token 聚合表选择 20 后应显示更多行",
  );
  assert(
    elements.reasoningByModelFamilyBody.innerHTML.includes("gpt-5.5"),
    "reasoning 模型家族聚合表未渲染 gpt-5.5 行",
  );
  assert(
    elements.reasoningByModelFamilyBody.innerHTML.includes("516 x2") &&
      !elements.reasoningByModelFamilyBody.innerHTML.includes("128 x1"),
    "reasoning 模型家族聚合表不应把 count=1 的低频 token 显示为高频 token",
  );
  assert(
    elements.reasoningByEffortBody.innerHTML.includes("high"),
    "reasoning 思考等级聚合表未渲染 high 行",
  );
  assert(
    elements.reasoningByEffortBody.innerHTML.includes("516 x2") &&
      !elements.reasoningByEffortBody.innerHTML.includes("128 x1"),
    "reasoning 思考等级聚合表不应把 count=1 的低频 token 显示为高频 token",
  );
  assert(
    elements.reasoningByFamilyEffortBody.innerHTML.includes("gpt-5.5 / high"),
    "reasoning 模型+思考等级聚合表未渲染组合行",
  );
  assert(
    elements.reasoningByFamilyEffortBody.innerHTML.includes("516 x2") &&
      !elements.reasoningByFamilyEffortBody.innerHTML.includes("128 x1"),
    "reasoning 模型+思考等级聚合表不应把 count=1 的低频 token 显示为高频 token",
  );
  assert(
    elements.reasoningCandidatePatternsBody.innerHTML.includes("observe_only"),
    "候选特征组合表未渲染 observe_only 状态",
  );
  assert(
    elements.reasoningCandidatePatternsBody.innerHTML.includes("candidate-extra-8") &&
      !elements.reasoningCandidatePatternsBody.innerHTML.includes("candidate-extra-9"),
    "候选特征组合表默认应只显示 10 行，避免页面过长",
  );
  elements.reasoningCandidatePatternLimitSelect.value = "20";
  elements.reasoningCandidatePatternLimitSelect.emit("change", {});
  assert(
    elements.reasoningCandidatePatternsBody.innerHTML.includes("candidate-extra-11"),
    "候选特征组合表选择 20 后应显示更多行",
  );
  assert(
    elements.reasoningRecentSamplesBody.innerHTML.includes("blocked"),
    "reasoning 最近样本表未渲染最终动作",
  );
  assert(
    elements.reasoningRecentSamplesBody.innerHTML.includes("high"),
    "reasoning 最近样本表未渲染思考等级",
  );
  assert(
    elements.reasoningRecentSamplesBody.innerHTML.includes("502"),
    "reasoning 最近样本表未渲染客户端状态",
  );
  assert(
    elements.reasoningRecentSamplesBody.innerHTML.includes("recent-extra-8") &&
      !elements.reasoningRecentSamplesBody.innerHTML.includes("recent-extra-9"),
    "reasoning 最近样本表默认应只显示 10 行，避免页面过长",
  );
  elements.reasoningRecentSamplesLimitSelect.value = "20";
  elements.reasoningRecentSamplesLimitSelect.emit("change", {});
  assert(
    elements.reasoningRecentSamplesBody.innerHTML.includes("recent-extra-11"),
    "reasoning 最近样本表选择 20 后应显示更多行",
  );
  assert(
    elements.reasoningTopTokensChart.innerHTML.includes("token 516"),
    "reasoning 高频 token 图表未渲染",
  );
  assert(
    typeof sandbox.runReasoningFeatureAnalysis === "function",
    "管理页未暴露 reasoning 特征分析函数",
  );
  await sandbox.runReasoningFeatureAnalysis();
  assert(
    elements.reasoningAnalysisValue.textContent.includes("valuable"),
    "reasoning 特征分析未展示 analysis_value",
  );
  assert(
    elements.reasoningAnalysisConclusion.textContent.includes("candidate"),
    "reasoning 特征分析未展示 conclusion",
  );
  assert(
    elements.reasoningAnalysisCoverageBody.innerHTML.includes("reasoning_tokens") &&
      elements.reasoningAnalysisCoverageBody.innerHTML.includes("commentary_observed"),
    "reasoning 特征分析未展示 field_coverage",
  );
  assert(
    elements.reasoningAnalysisCandidateSummaryValue.textContent.includes("2"),
    "reasoning 特征分析未展示候选命中摘要",
  );
  assert(
    elements.historicalImportSummaryValue.textContent.includes("历史导入"),
    "历史导入分析摘要未渲染初始状态",
  );
  assert(
    typeof sandbox.runHistoricalImportAnalysis === "function",
    "管理页未暴露历史导入分析函数",
  );
  await sandbox.runHistoricalImportAnalysis();
  await new Promise((resolve) => setImmediate(resolve));
  assert(historicalImportRunCount === 1, "历史导入分析按钮未触发后台任务");
  assert(
    elements.historicalImportProgressText.textContent.includes("完成"),
    "历史导入分析未显示完成进度",
  );
  assert(
    elements.historicalImportProgress.dataset.progressActive === "true",
    "历史导入完成后应显示进度条状态",
  );
  assert(
    elements.historicalImportAnalysisValue.textContent.includes("no_analysis_value") ||
      elements.historicalImportAnalysisValue.textContent.includes("无分析价值"),
    "历史导入预检未展示无分析价值结论",
  );
  assert(
    elements.historicalImportCoverageBody.innerHTML.includes("reasoning_tokens") &&
      elements.historicalImportCoverageBody.innerHTML.includes("final_answer_only"),
    "历史导入预检未展示字段覆盖率",
  );
  assert(
    elements.historicalImportSummaryValue.textContent.includes("165965"),
    "历史导入分析未展示历史请求总量",
  );
  assert(
    elements.historicalImportSourcesBody.innerHTML.includes("cc_switch_sqlite"),
    "历史导入分析未展示数据源表",
  );
  assert(
    elements.historicalImportCcModelsBody.innerHTML.includes("gpt-5.5"),
    "历史导入分析未展示 CC Switch 模型聚合",
  );
  assert(
    elements.historicalImportCodexLogsBody.innerHTML.includes("reasoning_tokens"),
    "历史导入分析未展示 Codex 日志关键词命中",
  );
  assert(
    elements.historicalImportSessionsBody.innerHTML.includes("demo.jsonl"),
    "历史导入分析未展示 session 大文件索引",
  );
  assert(
    elements.probeSamplesBody.innerHTML.includes(
      "probe_identity_consistency_warning",
    ),
    "主动探针样本表未渲染 warning 样本",
  );
  assert(typeof sandbox.runProbeNow === "function", "管理页未暴露 runProbeNow");
  assert(
    typeof sandbox.collectActiveProbeFormPayload === "function",
    "管理页未暴露 collectActiveProbeFormPayload",
  );
  assert(
    typeof sandbox.persistActiveProbeConfigFromControls === "function",
    "管理页未暴露 persistActiveProbeConfigFromControls",
  );
  assert(
    typeof sandbox.setReasoningBehaviorDateRange === "function",
    "管理页未暴露 setReasoningBehaviorDateRange",
  );
  assert(
    typeof sandbox.openReasoningBehaviorExport === "function",
    "管理页未暴露 reasoning 导出函数",
  );
  sandbox.setReasoningBehaviorDateRange("2026-06-27", "2026-06-28");
  const rangedReasoningRequestUrl = sandbox
    .getReasoningBehaviorRequestUrl(
      "http://127.0.0.1:4610/__codex_retry_gateway/api/analytics/reasoning",
    )
    .toString();
  assert(
    rangedReasoningRequestUrl.includes("date_from=2026-06-27") &&
      rangedReasoningRequestUrl.includes("date_to=2026-06-28"),
    "reasoning 状态接口构造器未携带选中时间段",
  );
  assert(
    sandbox
      .formatReasoningBehaviorDateRangeLabel("2026-06-27", "2026-06-28")
      .includes("2026-06-27"),
    "reasoning 时间窗标签未展示选中范围",
  );
  assert(
    typeof sandbox.shouldUseBackgroundReasoningExport === "function",
    "管理页未暴露后台导出判断函数",
  );
  assert(
    sandbox.shouldUseBackgroundReasoningExport() === false,
    "2 天 reasoning 导出不应走后台任务",
  );
  const openedUrlsBeforeRangeExport = openedUrls.length;
  await sandbox.openReasoningBehaviorExport("json");
  await sandbox.openReasoningBehaviorExport("csv");
  const exportedRangeUrls = openedUrls.slice(openedUrlsBeforeRangeExport);
  assert(
    exportedRangeUrls.some(
      (url) =>
        url.includes("/api/analytics/reasoning/export") &&
        url.includes("format=json") &&
        url.includes("date_from=2026-06-27") &&
        url.includes("date_to=2026-06-28"),
    ),
    "短范围 reasoning JSON 导出未直接打开下载链接",
  );
  assert(
    exportedRangeUrls.some(
      (url) =>
        url.includes("/api/analytics/reasoning/export") &&
        url.includes("format=csv") &&
        url.includes("date_from=2026-06-27") &&
        url.includes("date_to=2026-06-28"),
    ),
    "短范围 reasoning CSV 导出未直接打开下载链接",
  );
  const fetchCallsBeforeBackgroundExport = fetchCalls.length;
  sandbox.setReasoningBehaviorDateRange("2026-01-01", "2026-03-15");
  assert(
    sandbox.shouldUseBackgroundReasoningExport() === true,
    "大范围 reasoning 导出应走后台任务",
  );
  await sandbox.openReasoningBehaviorExport("json");
  await new Promise((resolve) => setTimeout(resolve, 150));
  const backgroundExportFetchCalls = fetchCalls.slice(fetchCallsBeforeBackgroundExport);
  assert(
    backgroundExportFetchCalls.some(
      (url) =>
        url.includes("/api/analytics/reasoning/export") &&
        url.includes("format=json") &&
        url.includes("date_from=2026-01-01") &&
        url.includes("date_to=2026-03-15"),
    ),
    "reasoning JSON 后台导出请求未携带大范围时间段",
  );
  assert(
    backgroundExportFetchCalls.some(
      (url) =>
        url.includes("/api/analytics/reasoning/export/jobs/ui-export-job-1"),
    ),
    "reasoning 后台导出未轮询任务进度",
  );
  assert(
    elements.reasoningExportProgressText.textContent.includes("后台导出"),
    "reasoning 后台导出未显示进度提示",
  );
  assert(
    elements.reasoningExportDownloadLink.href.includes("/download"),
    "reasoning 后台导出完成后未显示下载链接",
  );
  sandbox.setReasoningBehaviorDateRange("2026-06-27", "2026-06-28");
  const openedUrlsBeforeDirectButtonExport = openedUrls.length;
  await sandbox.openReasoningBehaviorExport("json");
  await sandbox.openReasoningBehaviorExport("csv");
  const directButtonExportUrls = openedUrls.slice(openedUrlsBeforeDirectButtonExport);
  assert(
    directButtonExportUrls.some((url) => url.includes("format=json")),
    "reasoning JSON 导出按钮未打开下载链接",
  );
  assert(
    directButtonExportUrls.some((url) => url.includes("format=csv")),
    "reasoning CSV 导出按钮未打开下载链接",
  );
  elements.probeTargetFamily54Input.checked = false;
  elements.probeTargetFamily55Input.checked = false;
  elements.probeTargetFamily56SolInput.checked = false;
  elements.probeTargetFamily56TerraInput.checked = false;
  elements.probeTargetFamily56LunaInput.checked = false;
  elements.probeAutoEnabledInput.checked = true;
  elements.probeAutoEnabledInput.emit("change", {
    target: elements.probeAutoEnabledInput,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert(
    elements.probeEnabledValue.textContent.includes("未开启"),
    "未选中任何模型时，不应允许开启自动探测",
  );
  assert(
    elements.probeAutoEnabledInput.checked === false,
    "未选中任何模型时，自动探测开关应回退为未勾选",
  );
  assert(
    elements.messageBox.textContent.includes("至少选择一个"),
    "未选中任何模型时，应提示至少选择一个目标模型",
  );
  elements.probeTargetFamily54Input.checked = true;
  elements.probeTargetFamily55Input.checked = false;
  elements.probeTargetFamily56SolInput.checked = true;
  elements.probeTargetFamily56TerraInput.checked = false;
  elements.probeTargetFamily56LunaInput.checked = true;
  elements.probeAutoEnabledInput.checked = false;
  elements.probeIntervalMinutesInput.value = "7";
  const probeConfigPayload = sandbox.collectActiveProbeFormPayload();
  assert(
    probeConfigPayload.enabled === false,
    "主动探针表单未正确收集 enabled",
  );
  assert(
    probeConfigPayload.interval_ms === 7 * 60 * 1000,
    "主动探针表单未正确把分钟频率转换为 interval_ms",
  );
  assert(
    JSON.stringify(probeConfigPayload.target_families) ===
      JSON.stringify(["gpt-5.4", "gpt-5.6-sol", "gpt-5.6-luna"]),
    "主动探针表单未正确收集 target_families",
  );
  const configSaveCountBeforeInvalidIntercept = fetchBodies.filter((entry) =>
    entry.url.includes("/api/config"),
  ).length;
  elements.interceptStreamingInput.checked = false;
  elements.interceptNonStreamingInput.checked = false;
  await sandbox.saveConfig({ preventDefault() {} });
  const configSaveCountAfterInvalidIntercept = fetchBodies.filter((entry) =>
    entry.url.includes("/api/config"),
  ).length;
  assert(
    configSaveCountAfterInvalidIntercept ===
      configSaveCountBeforeInvalidIntercept,
    "流式与非流式都关闭时，管理页不应提交 /api/config",
  );
  assert(
    elements.messageBox.textContent.includes("流式与非流式至少选择一个"),
    "流式与非流式都关闭时，管理页应提示至少选择一个拦截目标",
  );
  elements.interceptStreamingInput.checked = true;
  elements.interceptNonStreamingInput.checked = false;
  elements.interceptRuleModeSelect.value = "none";
  elements.capacityErrorActionSelect.value = "retry_then_502";
  elements.http429ActionSelect.value = "return_502";
  elements.modelUnavailableErrorActionSelect.value = "return_502";
  elements.http502503ErrorActionSelect.value = "retry_then_502";
  elements.otherHttp4xxErrorActionSelect.value = "pass_through";
  elements.otherHttp5xxErrorActionSelect.value = "retry_then_pass_through";
  elements.errorMessageFallbackActionSelect.value = "return_502";
  elements.transientRetryEnabledInput.checked = true;
  elements.transientRetryInitialDelayMsInput.value = "250";
  elements.transientRetryMaxDelayMsInput.value = "600000";
  elements.latencyGuardEnabledInput.checked = true;
  elements.firstProgressTimeoutMsInput.value = "1500";
  elements.firstProgressActionSelect.value = "retry_then_502";
  elements.totalTimeoutMsInput.value = "9000";
  elements.interceptRuleModeSelect.emit("change", {});
  assert(
    elements.reasoningMatchModeSelect.disabled === true &&
      elements.reasoningInput.disabled === true &&
      elements.streamActionStrict502Input.disabled === true &&
      elements.interceptStreamingInput.disabled === true,
    "选择 none 后，管理页未禁用 reasoning 专属控件",
  );
  await sandbox.saveConfig({ preventDefault() {} });
  const saveConfigCall = fetchBodies
    .filter((entry) => entry.url.includes("/api/config"))
    .at(-1);
  assert(saveConfigCall, "saveConfig 未请求 /api/config");
  const savedPayload = JSON.parse(saveConfigCall.body);
  assert(
    savedPayload.intercept_streaming === true,
    "saveConfig 未提交 intercept_streaming",
  );
  assert(
    savedPayload.intercept_non_streaming === false,
    "saveConfig 未提交 intercept_non_streaming",
  );
  assert(
    savedPayload.intercept_rule_mode === "none",
    "saveConfig 未提交 none 拦截模式",
  );
  assert(
    savedPayload.reasoning_match_mode === "manual",
    "saveConfig 未提交 reasoning_match_mode",
  );
  assert(
    savedPayload.guard_retry_attempts === 3,
    "saveConfig 未提交 guard_retry_attempts",
  );
  assert(
    savedPayload.capacity_error_action === "retry_then_502",
    "saveConfig 未提交 Capacity 动作",
  );
  assert(
    savedPayload.http_429_action === "return_502",
    "saveConfig 未提交 HTTP 429 动作",
  );
  assert(
    savedPayload.model_unavailable_error_action === "return_502" &&
      savedPayload.http_502_503_error_action === "retry_then_502" &&
      savedPayload.other_http_4xx_error_action === "pass_through" &&
      savedPayload.other_http_5xx_error_action === "retry_then_pass_through" &&
      savedPayload.error_message_fallback_action === "return_502",
    "saveConfig 未提交完整新增上游错误策略",
  );
  assert(
    savedPayload.transient_retry?.enabled === true &&
      savedPayload.transient_retry?.initial_delay_ms === 250 &&
      savedPayload.transient_retry?.max_delay_ms === 600000,
    "saveConfig 未提交完整临时故障自动恢复配置",
  );
  assert(
    savedPayload.latency_guard?.enabled === true &&
      savedPayload.latency_guard?.first_progress_timeout_ms === 1500 &&
      savedPayload.latency_guard?.first_progress_action === "retry_then_502" &&
      savedPayload.latency_guard?.total_timeout_ms === 9000,
    "saveConfig 未提交完整 latency_guard",
  );
  assert(savedPayload.active_probe, "saveConfig 未提交 active_probe");
  assert(
    savedPayload.active_probe.enabled === false,
    "saveConfig 未提交 active_probe.enabled",
  );
  assert(
    savedPayload.active_probe.interval_ms === 7 * 60 * 1000,
    "saveConfig 未提交 active_probe.interval_ms",
  );
  assert(
    JSON.stringify(savedPayload.active_probe.target_families) ===
      JSON.stringify(["gpt-5.4", "gpt-5.6-sol", "gpt-5.6-luna"]),
    "saveConfig 未提交 active_probe.target_families",
  );
  elements.interceptRuleModeSelect.value = "reasoning_tokens";
  elements.interceptRuleModeSelect.emit("change", {});
  elements.streamActionStrict502Input.checked = false;
  elements.streamActionContinuationRecoveryInput.checked = true;
  await sandbox.saveConfig({ preventDefault() {} });
  const continuationSaveConfigCall = fetchBodies
    .filter((entry) => entry.url.includes("/api/config"))
    .at(-1);
  assert(continuationSaveConfigCall, "saveConfig 未请求续写恢复配置");
  const continuationSavedPayload = JSON.parse(continuationSaveConfigCall.body);
  assert(
    continuationSavedPayload.intercept_rule_mode === "reasoning_tokens" &&
      continuationSavedPayload.stream_action === "continuation_recovery",
    "saveConfig 未提交 reasoning_tokens 规则 + 续写恢复流式动作",
  );
  assert(
    elements.continuationRecoveryCountValue.textContent === "5" &&
      elements.continuationRecoverySuccessRatioValue.textContent === "80.00%",
    "运行状态未正确展示续写次数和续写成功率",
  );
  sandbox.fillForm({
    intercept_rule_mode: "reasoning_tokens",
    reasoning_match_mode: "formula_518n_minus_2",
    reasoning_equals: [516],
    stream_action: "continuation_recovery",
    active_probe: {
      enabled: false,
      interval_ms: 7 * 60 * 1000,
      target_families: ["gpt-5.4"],
    },
  });
  assert(
    elements.interceptRuleModeSelect.value === "reasoning_tokens" &&
      elements.streamActionContinuationRecoveryInput.checked === true &&
      elements.streamActionStrict502Input.checked === false,
    "fillForm 未正确回填 reasoning_tokens 规则 + 续写恢复流式动作状态",
  );
  assert(
    elements.reasoningMatchModeSelect.value === "formula_518n_minus_2" &&
      elements.policySummaryValue.textContent.includes("518*n - 2 规则"),
    "fillForm 未正确回填 518*n - 2 规则模式",
  );
  assert(
    elements.reasoningInput.disabled === true &&
      elements.reasoningEqualsField.classList.contains("is-formula-locked") &&
      elements.reasoningEqualsHint.textContent.includes("公式模式已接管"),
    "518*n - 2 规则模式下 reasoning_equals 应显示为公式锁定的不可编辑参考态",
  );
  elements.reasoningMatchModeSelect.value = "manual";
  sandbox.syncReasoningMatchModeFromForm();
  assert(
    elements.reasoningInput.disabled === false &&
      !elements.reasoningEqualsField.classList.contains("is-formula-locked") &&
      elements.reasoningEqualsHint.textContent.includes("手动模式下"),
    "切回手动模式后 reasoning_equals 应恢复可编辑状态和手动提示",
  );
  elements.streamActionContinuationRecoveryInput.checked = false;
  elements.streamActionStrict502Input.checked = true;
  elements.interceptRuleModeSelect.value = "reasoning_tokens";
  assert(
    elements.probeEnabledValue.textContent.includes("未开启"),
    "保存为关闭自动探测后，主动探针状态应显示未开启",
  );
  elements.probeAutoEnabledInput.checked = true;
  elements.probeAutoEnabledInput.emit("change", {
    target: elements.probeAutoEnabledInput,
  });
  assert(
    elements.probeEnabledValue.textContent.includes("已开启"),
    "勾选开启自动探测后，主动探针状态应立即显示已开启",
  );
  await sandbox.persistActiveProbeConfigFromControls();
  const autoProbeSaveCall = fetchBodies
    .filter((entry) => entry.url.includes("/api/config"))
    .at(-1);
  assert(autoProbeSaveCall, "勾选开启自动探测后未自动保存 /api/config");
  const autoProbeSavedPayload = JSON.parse(autoProbeSaveCall.body);
  assert(
    autoProbeSavedPayload.active_probe?.enabled === true,
    "勾选开启自动探测后自动保存未写入 active_probe.enabled=true",
  );
  await sandbox.refreshLiveData();
  assert(
    elements.probeEnabledValue.textContent.includes("已开启"),
    "勾选开启自动探测后，主动探针状态不应被页面自动刷新打回未开启",
  );
  await sandbox.runProbeNow();
  assert(runProbeRequestCount === 1, "runProbeNow 未请求 /api/probe/run");
  assert(
    fetchCalls.some((url) => url.includes("/api/probe/run")),
    "管理页未调用手动探测接口",
  );
  const runProbeCall = fetchBodies.find((entry) =>
    entry.url.includes("/api/probe/run"),
  );
  assert(runProbeCall, "runProbeNow 未提交请求体");
  const runProbePayload = JSON.parse(runProbeCall.body);
  assert(runProbePayload.active_probe, "runProbeNow 未提交 active_probe");
  assert(
    runProbePayload.active_probe.enabled === true,
    "runProbeNow 未提交当前 active_probe.enabled",
  );
  assert(
    runProbePayload.active_probe.interval_ms === 7 * 60 * 1000,
    "runProbeNow 未提交当前 active_probe.interval_ms",
  );
  assert(
    JSON.stringify(runProbePayload.active_probe.target_families) ===
      JSON.stringify(["gpt-5.4"]),
    "runProbeNow 未提交当前 active_probe.target_families",
  );
  elements.probeTargetFamily54Input.checked = false;
  elements.probeTargetFamily55Input.checked = false;
  elements.probeTargetFamily56SolInput.checked = false;
  elements.probeTargetFamily56TerraInput.checked = false;
  elements.probeTargetFamily56LunaInput.checked = false;
  elements.probeAutoEnabledInput.checked = true;
  await sandbox.persistActiveProbeConfigFromControls().then(
    () => {
      throw new Error(
        "未选中任何模型时，persistActiveProbeConfigFromControls 不应成功",
      );
    },
    (error) => {
      assert(
        String(error?.message || error).includes("至少选择一个"),
        "未选中任何模型时，persistActiveProbeConfigFromControls 应返回目标模型校验错误",
      );
    },
  );
  new vm.Script(`
    lastLogSeq = 999;
    document.getElementById("logsOutput").textContent = "2026-06-28T00:00:00.000Z stale old log";
  `).runInContext(sandbox);
  statusPayload.metrics.started_at = "2026-06-28T04:18:23.000Z";
  logsPayload.total_entries = 1;
  logsPayload.latest_seq = 1;
  logsPayload.entries = [
    {
      seq: 1,
      at: "2026-06-28T04:18:23.000Z",
      message: "fresh restarted log",
    },
  ];
  fetchCalls.length = 0;
  await sandbox.refreshLiveData();
  assert(
    locationReloadCount === 1,
    "检测到网关重启后，管理页应自动刷新以加载新的内联脚本",
  );

  const sample = {
    ts: "2026-06-28T03:18:23.000Z",
    path: "/responses",
    effective_local_model: "gpt-5.4",
    upstream_model: "-",
    stream_model: "gpt-5.4",
    first_observed_model: "gpt-5.4",
    last_observed_model: "gpt-5.4",
    observed_models: ["gpt-5.4"],
    observed_fingerprints: ["fp_demo"],
    anomaly_type: "single_request_rebuild_suspected",
    confidence: "high",
    evidence_logs: [
      {
        seq: 1,
        at: "2026-06-28T03:18:23.000Z",
        message:
          "[match] stream path=/responses reasoning_tokens=516 action=strict_502",
      },
      {
        seq: 2,
        at: "2026-06-28T03:18:23.100Z",
        message:
          "[sample] path=/responses anomaly=single_request_rebuild_suspected confidence=high",
      },
    ],
  };

  sandbox.renderSuspiciousSamples([sample]);
  const sampleKey = sandbox.buildSampleKey(sample);
  elements.suspiciousSamplesBody.emit("toggle", {
    target: {
      tagName: "DETAILS",
      classList: {
        contains(value) {
          return value === "evidence-details";
        },
      },
      getAttribute(name) {
        return name === "data-sample-key" ? sampleKey : null;
      },
      open: true,
    },
  });

  const before = elements.suspiciousSamplesBody.innerHTML;
  sandbox.renderSuspiciousSamples([sample]);
  const afterSame = elements.suspiciousSamplesBody.innerHTML;
  assert(before === afterSame, "最近可疑样本未变化时不应重绘日志证据 DOM");

  const changedSample = {
    ...sample,
    evidence_logs: [
      ...sample.evidence_logs,
      {
        seq: 3,
        at: "2026-06-28T03:18:23.200Z",
        message: "#3 appended",
      },
    ],
  };
  sandbox.renderSuspiciousSamples([changedSample]);
  const afterChanged = elements.suspiciousSamplesBody.innerHTML;
  assert(
    /<details class="evidence-details" data-sample-key="[^"]+" open>/.test(
      afterChanged,
    ),
    "最近可疑样本刷新后已展开的日志证据不应自动收起",
  );

  const probeSample = {
    ts: "2026-06-28T03:21:00.000Z",
    probe_type: "identity_consistency",
    target_model: "gpt-5.5",
    endpoint_path: "/responses",
    result: "warning",
    result_type: "probe_identity_consistency_warning",
    confidence: "medium",
    http_status: 200,
    duration_ms: 42,
    upstream_model: "gpt-5.5",
    observed_fingerprints: ["fp_probe_1"],
    evidence_logs: [
      {
        at: "2026-06-28T03:21:00.000Z",
        message: "[probe] warning type=identity_consistency",
      },
    ],
  };
  sandbox.renderProbeSamples([probeSample]);
  const probeSampleKey = sandbox.buildProbeSampleKey(probeSample);
  elements.probeSamplesBody.emit("toggle", {
    target: {
      tagName: "DETAILS",
      classList: {
        contains(value) {
          return value === "evidence-details";
        },
      },
      getAttribute(name) {
        return name === "data-sample-key" ? probeSampleKey : null;
      },
      open: true,
    },
  });
  markEvidenceDetailsOpen(elements.probeSamplesBody, probeSampleKey);
  const probeBefore = elements.probeSamplesBody.innerHTML;
  sandbox.renderProbeSamples([probeSample]);
  const probeAfterSame = elements.probeSamplesBody.innerHTML;
  assert(
    probeBefore === probeAfterSame,
    "主动探针样本未变化时不应重绘日志证据 DOM",
  );
  const changedProbeSample = {
    ...probeSample,
    evidence_logs: [
      ...probeSample.evidence_logs,
      {
        at: "2026-06-28T03:21:00.500Z",
        message: "[probe] second line",
      },
    ],
  };
  sandbox.renderProbeSamples([changedProbeSample]);
  const probeAfterChanged = elements.probeSamplesBody.innerHTML;
  assert(
    /<details class="evidence-details" data-sample-key="[^"]+" open>/.test(
      probeAfterChanged,
    ),
    "主动探针样本刷新后已展开的日志证据不应自动收起",
  );
  const silentProbeSample = {
    ts: "2026-06-28T03:22:00.000Z",
    probe_type: "image_input",
    target_model: "gpt-5.4",
    endpoint_path: "/responses",
    result: "warning",
    result_type: "probe_image_input_violation",
    confidence: "high",
    http_status: 400,
    duration_ms: 22,
    upstream_model: "gpt-5.4-mini",
    observed_fingerprints: ["fp_probe_silent"],
    evidence_logs: [
      {
        at: "2026-06-28T03:22:00.000Z",
        message: "[probe] silent open preservation",
      },
    ],
  };
  sandbox.renderProbeSamples([silentProbeSample]);
  const silentProbeKey = sandbox.buildProbeSampleKey(silentProbeSample);
  markEvidenceDetailsOpen(elements.probeSamplesBody, silentProbeKey);
  const silentChangedProbeSample = {
    ...silentProbeSample,
    evidence_logs: [
      ...silentProbeSample.evidence_logs,
      {
        at: "2026-06-28T03:22:00.100Z",
        message: "[probe] changed while open",
      },
    ],
  };
  sandbox.renderProbeSamples([silentChangedProbeSample]);
  const silentChangedProbeKey = sandbox.buildProbeSampleKey(
    silentChangedProbeSample,
  );
  assert(
    /<details class="evidence-details" data-sample-key="[^"]+" open>/.test(
      elements.probeSamplesBody.innerHTML,
    ),
    "主动探针样本即使未显式触发 toggle 事件，也不应在刷新后自动收起",
  );
  const changedAgainSample = {
    ...changedSample,
    evidence_logs: [
      ...changedSample.evidence_logs,
      {
        seq: 4,
        at: "2026-06-28T03:18:23.300Z",
        message: "#4 suspicious changed again",
      },
    ],
  };
  sandbox.renderSuspiciousSamples([changedAgainSample]);
  const probeAfterSuspiciousRefresh = elements.probeSamplesBody.innerHTML;
  assert(
    probeAfterSuspiciousRefresh.includes(
      `data-sample-key=\"${encodeHtmlAttribute(silentChangedProbeKey)}\" open`,
    ),
    "最近可疑样本刷新后，不应把主动探针样本已展开的日志证据一起收起",
  );
  const prependedProbeSample = {
    ts: "2026-06-28T03:20:30.000Z",
    probe_type: "long_context",
    target_model: "gpt-5.5",
    endpoint_path: "/responses",
    result: "violation",
    result_type: "probe_low_context_family_violation",
    confidence: "high",
    http_status: 400,
    duration_ms: 31,
    upstream_model: "gpt-5.4-mini",
    observed_fingerprints: ["fp_probe_0"],
    evidence_logs: [
      {
        at: "2026-06-28T03:20:30.000Z",
        message: "[probe] violation type=long_context",
      },
    ],
  };
  sandbox.renderProbeSamples([prependedProbeSample, silentChangedProbeSample]);
  const openProbeKeysAfterPrepend = elements.probeSamplesBody
    .querySelectorAll(".evidence-details[data-sample-key][open]")
    .map((node) => node.getAttribute("data-sample-key"));
  assert(
    openProbeKeysAfterPrepend.includes(silentChangedProbeKey),
    "主动探针样本前面插入新记录后，已展开的日志证据不应自动收起",
  );
}

async function createHistoricalImportFixtures(tempRoot) {
  const sqlite3Path = process.env.SQLITE3_EXE || "sqlite3";
  const fixtureRoot = path.join(tempRoot, "historical-import-fixtures");
  const ccSwitchDbPath = path.join(fixtureRoot, "cc-switch.db");
  const codexLogsDbPath = path.join(fixtureRoot, "logs_2.sqlite");
  const sessionsRoot = path.join(fixtureRoot, "sessions");
  await mkdir(sessionsRoot, { recursive: true });
  await execFileText(
    sqlite3Path,
    [
      ccSwitchDbPath,
      [
        "CREATE TABLE proxy_request_logs (",
        "request_id TEXT, provider_id TEXT, app_type TEXT, model TEXT, request_model TEXT,",
        "input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER,",
        "input_cost_usd REAL, output_cost_usd REAL, total_cost_usd REAL,",
        "latency_ms INTEGER, first_token_ms INTEGER, duration_ms INTEGER, status_code INTEGER,",
        "error_message TEXT, session_id TEXT, provider_type TEXT, is_streaming INTEGER,",
        "created_at TEXT, data_source TEXT, pricing_model TEXT",
        ");",
        "INSERT INTO proxy_request_logs VALUES ('r1','p1','codex','gpt-5.5','gpt-5.5',100,20,5,0,0.01,0.02,0.03,300,120,800,200,NULL,'s1','openai',1,'2026-06-30T10:00:00.000Z','cc-switch','standard');",
        "INSERT INTO proxy_request_logs VALUES ('r2','p1','codex','gpt-5.4','gpt-5.4',200,10,0,2,0.02,0.01,0.03,900,300,1800,502,'bad upstream','s2','openai',0,'2026-06-30T11:00:00.000Z','cc-switch','standard');",
      ].join(" "),
    ],
    { cwd: fixtureRoot },
  );
  await execFileText(
    sqlite3Path,
    [
      codexLogsDbPath,
      [
        "CREATE TABLE logs (",
        "id INTEGER, ts TEXT, ts_nanos INTEGER, level TEXT, target TEXT, feedback_log_body TEXT,",
        "module_path TEXT, file TEXT, line INTEGER, thread_id TEXT, process_uuid TEXT, estimated_bytes INTEGER",
        ");",
        "INSERT INTO logs VALUES (1,'2026-06-30T10:00:00.000Z',0,'INFO','codex_core','reasoning_tokens=516 final_answer','m','f',1,'t1','p1',128);",
        "INSERT INTO logs VALUES (2,'2026-06-30T11:00:00.000Z',0,'ERROR','codex_core','upstream 502','m','f',2,'t1','p1',64);",
      ].join(" "),
    ],
    { cwd: fixtureRoot },
  );
  await writeFile(
    path.join(sessionsRoot, "large-session.jsonl"),
    `${JSON.stringify({ ts: "2026-06-30T10:00:00.000Z", type: "demo" })}\n`,
    "utf8",
  );
  return {
    ccSwitchDbPath,
    codexLogsDbPath,
    sessionsRoot,
  };
}

function startFakeUpstream(port) {
  const failBeforeResponseCounts = new Map();
  const modelsRequestCounts = new Map();
  const responseAttemptCounts = new Map();
  const reasoningSequenceCounts = new Map();
  const capacityErrorCounts = new Map();
  const http429Counts = new Map();
  const transientErrorCounts = new Map();
  const streamTransientErrorCounts = new Map();
  const identityProbeCounts = new Map();
  const probeRequests = [];
  const responseRequests = [];
  const modelRequests = [];
  const chatCompletionRequests = [];
  const server = http.createServer((req, res) => {
    const responsePaths = new Set(["/responses", "/v1/responses"]);
    const chatCompletionPaths = new Set([
      "/chat/completions",
      "/v1/chat/completions",
    ]);

    if (req.method === "GET" && req.url.startsWith("/v1/models")) {
      const modelsUrl = new URL(req.url, "http://127.0.0.1");
      const modelsRequestKey = modelsUrl.searchParams.get("test_sequence_key") || req.url;
      const modelsRequestCount = (modelsRequestCounts.get(modelsRequestKey) || 0) + 1;
      modelsRequestCounts.set(modelsRequestKey, modelsRequestCount);
      modelRequests.push({
        path: req.url,
        attempt_number: modelsRequestCount,
        sequence_key: modelsRequestKey,
      });
      if (req.url.includes("test_fail_before_response=1")) {
        res.socket?.destroy();
        return;
      }
      const failBeforeResponseAttempts = Number.parseInt(
        modelsUrl.searchParams.get("test_fail_before_response_attempts") || "0",
        10,
      );
      if (
        Number.isInteger(failBeforeResponseAttempts) &&
        modelsRequestCount <= failBeforeResponseAttempts
      ) {
        res.socket?.destroy();
        return;
      }
      const sendModelsResponse = () => {
        createJsonResponse(
          res,
          200,
          {
            object: "list",
            data: [{ id: "fake-model" }],
          },
          { "x-upstream-test": "models-ok" },
        );
      };
      const delayMs = Number.parseInt(modelsUrl.searchParams.get("test_delay_ms") || "0", 10);
      if (Number.isInteger(delayMs) && delayMs > 0) {
        setTimeout(sendModelsResponse, delayMs);
      } else {
        sendModelsResponse();
      }
      return;
    }

    if (req.method === "POST" && responsePaths.has(req.url)) {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(body || "{}");
        } catch {
          createJsonResponse(
            res,
            400,
            { error: { code: "invalid_json", message: "invalid JSON request body" } },
            { "x-upstream-test": "invalid-json" },
          );
          return;
        }
        const authorization = req.headers.authorization || "";
        const probeBlockedByUpstream =
          authorization === "Bearer sk-probe-blocked";
        const sequenceKey = Array.isArray(parsed.test_reasoning_sequence)
          ? `${req.url}:${parsed.test_sequence_key || JSON.stringify(parsed.test_reasoning_sequence)}`
          : null;
        const sequenceCount = sequenceKey
          ? reasoningSequenceCounts.get(sequenceKey) || 0
          : 0;
        if (sequenceKey) {
          reasoningSequenceCounts.set(sequenceKey, sequenceCount + 1);
        }
        const reasoning = sequenceKey
          ? parsed.test_reasoning_sequence[
              Math.min(sequenceCount, parsed.test_reasoning_sequence.length - 1)
            ]
          : (parsed.test_reasoning_tokens ?? 128);
        const serializedInput = JSON.stringify(parsed.input || "");
        const requestSnapshot = {
          path: req.url,
          received_at_ms: Date.now(),
          headers: {
            authorization,
            userAgent: req.headers["user-agent"] || null,
            openaiBeta: req.headers["openai-beta"] || null,
            xStainlessLang: req.headers["x-stainless-lang"] || null,
          },
          body: parsed,
          probeType: null,
          phase: null,
          units: null,
        };
        const responseAttemptKey = `${req.url}:${parsed.test_sequence_key || "default"}`;
        const responseAttemptNumber = (responseAttemptCounts.get(responseAttemptKey) || 0) + 1;
        responseAttemptCounts.set(responseAttemptKey, responseAttemptNumber);
        requestSnapshot.attempt_number = responseAttemptNumber;
        responseRequests.push(requestSnapshot);
        if (
          Number.isInteger(parsed.test_fail_before_response_from_attempt) &&
          responseAttemptNumber >= parsed.test_fail_before_response_from_attempt
        ) {
          res.socket?.destroy();
          return;
        }
        if (parsed.test_fail_before_response_once) {
          const failKey = `${req.url}:fail-before-response-once`;
          const failCount = (failBeforeResponseCounts.get(failKey) || 0) + 1;
          failBeforeResponseCounts.set(failKey, failCount);
          if (failCount === 1) {
            res.socket?.destroy();
            return;
          }
        }
        if (parsed.test_fail_before_response_always) {
          res.socket?.destroy();
          return;
        }
        if (
          Number.isInteger(parsed.test_fail_before_response_attempts) &&
          responseAttemptNumber <= parsed.test_fail_before_response_attempts
        ) {
          res.socket?.destroy();
          return;
        }
        const capacityErrorAttempts = parsed.test_capacity_error_attempts ??
          (parsed.test_capacity_error_once ? 1 : 0);
        if (capacityErrorAttempts > 0) {
          const capacityKey = `${req.url}:capacity:${parsed.test_sequence_key || "default"}`;
          const capacityCount = (capacityErrorCounts.get(capacityKey) || 0) + 1;
          capacityErrorCounts.set(capacityKey, capacityCount);
          if (capacityCount <= capacityErrorAttempts) {
            const capacityHeaders = { "x-upstream-test": "responses-capacity-error" };
            if (parsed.test_retry_after !== undefined) {
              capacityHeaders["retry-after"] = `${parsed.test_retry_after}`;
            }
            if (parsed.test_capacity_error_content_type) {
              createTextResponse(
                res,
                parsed.test_capacity_error_status ?? 429,
                parsed.test_capacity_error_raw_body ??
                  "Selected model is at capacity. Please try a different model.",
                parsed.test_capacity_error_content_type,
                capacityHeaders,
              );
            } else {
              createJsonResponse(
                res,
                parsed.test_capacity_error_status ?? 429,
                parsed.test_capacity_error_payload ?? {
                  error: {
                    type: "rate_limit_error",
                    code: "model_at_capacity",
                    message:
                      "Selected model is at capacity. Please try a different model.",
                  },
                },
                capacityHeaders,
              );
            }
            return;
          }
        }
        const longContextProbe = extractLongContextProbeUnits(serializedInput);
        if (longContextProbe) {
          requestSnapshot.probeType = "long_context";
          requestSnapshot.phase = longContextProbe.phase;
          requestSnapshot.units = longContextProbe.units;
          probeRequests.push(requestSnapshot);
          if (!authorization.startsWith("Bearer ")) {
            createJsonResponse(
              res,
              401,
              {
                error: {
                  code: "missing_authorization",
                  message: "authorization header required",
                },
              },
              {
                "x-upstream-test": "responses-probe-long-context-unauthorized",
              },
            );
            return;
          }
          if (probeBlockedByUpstream) {
            createJsonResponse(
              res,
              502,
              {
                error: {
                  type: "upstream_error",
                  message: "Upstream service temporarily unavailable",
                },
              },
              {
                "x-upstream-test":
                  "responses-probe-long-context-upstream-blocked",
              },
            );
            return;
          }
          const simulatedInputTokens = 6000 + longContextProbe.units;
          if (simulatedInputTokens < 400000) {
            createJsonResponse(
              res,
              200,
              buildLongContextProbeResponsePayload(
                parsed,
                simulatedInputTokens,
              ),
              {
                "x-upstream-test": `responses-probe-long-context-${longContextProbe.phase}-ok`,
              },
            );
            return;
          }
          createJsonResponse(
            res,
            400,
            {
              error: {
                code: "context_length_exceeded",
                message: "request too large for 400000 context window",
              },
            },
            { "x-upstream-test": "responses-probe-long-context" },
          );
          return;
        }
        if (serializedInput.includes("__crg_image_input_probe__")) {
          requestSnapshot.probeType = "image_input";
          probeRequests.push(requestSnapshot);
          if (!authorization.startsWith("Bearer ")) {
            createJsonResponse(
              res,
              401,
              {
                error: {
                  code: "missing_authorization",
                  message: "authorization header required",
                },
              },
              { "x-upstream-test": "responses-probe-image-input-unauthorized" },
            );
            return;
          }
          if (probeBlockedByUpstream) {
            createJsonResponse(
              res,
              502,
              {
                error: {
                  type: "upstream_error",
                  message:
                    "Upstream access forbidden, please contact administrator",
                },
              },
              {
                "x-upstream-test":
                  "responses-probe-image-input-upstream-blocked",
              },
            );
            return;
          }
          if (serializedInput.includes("data:image/svg+xml")) {
            createJsonResponse(
              res,
              502,
              {
                error: {
                  type: "upstream_error",
                  message: "unsupported image mime type: svg",
                },
              },
              { "x-upstream-test": "responses-probe-image-input-svg-blocked" },
            );
            return;
          }
          createJsonResponse(
            res,
            400,
            {
              error: {
                code: "unsupported_image_input",
                message: "model does not support image input",
              },
            },
            { "x-upstream-test": "responses-probe-image-input" },
          );
          return;
        }
        if (serializedInput.includes("__crg_response_structure_probe__")) {
          requestSnapshot.probeType = "response_structure";
          probeRequests.push(requestSnapshot);
          if (!authorization.startsWith("Bearer ")) {
            createJsonResponse(
              res,
              401,
              {
                error: {
                  code: "missing_authorization",
                  message: "authorization header required",
                },
              },
              {
                "x-upstream-test":
                  "responses-probe-response-structure-unauthorized",
              },
            );
            return;
          }
          createJsonResponse(
            res,
            200,
            {
              output_text:
                '当然可以，下面是结果：\n{"items":[{"key":"a","value":1},{"key":"b","value":2},{"key":"c","value":3}]}',
            },
            { "x-upstream-test": "responses-probe-response-structure" },
          );
          return;
        }
        if (serializedInput.includes("__crg_identity_probe__")) {
          requestSnapshot.probeType = "identity_consistency";
          probeRequests.push(requestSnapshot);
          if (!authorization.startsWith("Bearer ")) {
            createJsonResponse(
              res,
              401,
              {
                error: {
                  code: "missing_authorization",
                  message: "authorization header required",
                },
              },
              { "x-upstream-test": "responses-probe-identity-unauthorized" },
            );
            return;
          }
          const identityKey = `${req.url}:identity-probe`;
          const identityCount = (identityProbeCounts.get(identityKey) || 0) + 1;
          identityProbeCounts.set(identityKey, identityCount);
          const outputText =
            identityCount % 2 === 1
              ? '{"self_reported_model":"gpt-5.5","self_reported_family":"gpt-5.5","claims_image_input":true,"claims_cutoff":"2025-01-01"}'
              : '{"self_reported_model":"gpt-5.3","self_reported_family":"gpt-5.3","claims_image_input":false,"claims_cutoff":"2024-01-01"}';
          createJsonResponse(
            res,
            200,
            { output_text: outputText },
            { "x-upstream-test": "responses-probe-identity" },
          );
          return;
        }
        if (
          serializedInput.includes("__crg_knowledge_cutoff_probe__:self_cutoff")
        ) {
          requestSnapshot.probeType = "knowledge_cutoff";
          probeRequests.push(requestSnapshot);
          if (!authorization.startsWith("Bearer ")) {
            createJsonResponse(
              res,
              401,
              {
                error: {
                  code: "missing_authorization",
                  message: "authorization header required",
                },
              },
              {
                "x-upstream-test":
                  "responses-probe-knowledge-self-cutoff-unauthorized",
              },
            );
            return;
          }
          createJsonResponse(
            res,
            200,
            { output_text: '{"claims_cutoff":"2024-01-01"}' },
            { "x-upstream-test": "responses-probe-knowledge-self-cutoff" },
          );
          return;
        }
        if (
          serializedInput.includes("__crg_knowledge_cutoff_probe__:anchor_1")
        ) {
          requestSnapshot.probeType = "knowledge_cutoff";
          probeRequests.push(requestSnapshot);
          if (!authorization.startsWith("Bearer ")) {
            createJsonResponse(
              res,
              401,
              {
                error: {
                  code: "missing_authorization",
                  message: "authorization header required",
                },
              },
              {
                "x-upstream-test":
                  "responses-probe-knowledge-anchor-1-unauthorized",
              },
            );
            return;
          }
          createJsonResponse(
            res,
            200,
            { output_text: "乔·拜登" },
            { "x-upstream-test": "responses-probe-knowledge-anchor-1" },
          );
          return;
        }
        if (
          serializedInput.includes("__crg_knowledge_cutoff_probe__:anchor_2")
        ) {
          requestSnapshot.probeType = "knowledge_cutoff";
          probeRequests.push(requestSnapshot);
          if (!authorization.startsWith("Bearer ")) {
            createJsonResponse(
              res,
              401,
              {
                error: {
                  code: "missing_authorization",
                  message: "authorization header required",
                },
              },
              {
                "x-upstream-test":
                  "responses-probe-knowledge-anchor-2-unauthorized",
              },
            );
            return;
          }
          createJsonResponse(
            res,
            200,
            { output_text: "2024" },
            { "x-upstream-test": "responses-probe-knowledge-anchor-2" },
          );
          return;
        }
        if (parsed.test_http_429_attempts > 0) {
          const rateLimitKey = `${req.url}:http-429:${parsed.test_sequence_key || "default"}`;
          const rateLimitCount = (http429Counts.get(rateLimitKey) || 0) + 1;
          http429Counts.set(rateLimitKey, rateLimitCount);
          if (rateLimitCount <= parsed.test_http_429_attempts) {
            const rateLimitHeaders = { "x-upstream-test": "responses-http-429" };
            if (parsed.test_retry_after !== undefined) {
              rateLimitHeaders["retry-after"] = `${parsed.test_retry_after}`;
            }
            if (parsed.test_http_429_content_type) {
              createTextResponse(
                res,
                429,
                parsed.test_http_429_raw_body ?? "Too Many Requests",
                parsed.test_http_429_content_type,
                rateLimitHeaders,
              );
            } else {
              createJsonResponse(
                res,
                429,
                parsed.test_http_429_payload ?? {
                  error: {
                    type: "rate_limit_error",
                    code: "rate_limit_exceeded",
                    message: "Too Many Requests",
                  },
                },
                rateLimitHeaders,
              );
            }
            return;
          }
        }
        if (parsed.test_transient_error_attempts > 0) {
          const transientErrorKey = `${req.url}:transient-error:${parsed.test_sequence_key || "default"}`;
          const transientErrorCount = (transientErrorCounts.get(transientErrorKey) || 0) + 1;
          transientErrorCounts.set(transientErrorKey, transientErrorCount);
          if (transientErrorCount <= parsed.test_transient_error_attempts) {
            if (parsed.test_transient_error_content_type) {
              createTextResponse(
                res,
                parsed.test_transient_error_status ?? 503,
                parsed.test_transient_error_raw_body ?? "Upstream service temporarily unavailable",
                parsed.test_transient_error_content_type,
                { "x-upstream-test": "responses-transient-error" },
              );
              return;
            }
            createJsonResponse(
              res,
              parsed.test_transient_error_status ?? 503,
              parsed.test_transient_error_payload ?? {
                error: {
                  type: "upstream_error",
                  code: "temporarily_unavailable",
                  message: "Upstream service temporarily unavailable",
                },
              },
              { "x-upstream-test": "responses-transient-error" },
            );
            return;
          }
        }
        if (parsed.test_error_payload) {
          createJsonResponse(
            res,
            parsed.test_error_status ?? 400,
            parsed.test_error_payload,
            { "x-upstream-test": "responses-error" },
          );
          return;
        }
        const finishJsonResponse = () => {
          const retryAttempt = parsed.test_fail_before_response_once
            ? failBeforeResponseCounts.get(
                `${req.url}:fail-before-response-once`,
              ) || 0
            : 0;
          createJsonResponse(
            res,
            200,
            buildResponsePayload(
              parsed,
              reasoning,
              retryAttempt,
              responseAttemptNumber,
            ),
            { "x-upstream-test": `responses-${reasoning}` },
          );
        };
        if (
          parsed.test_force_terminate_before_progress ||
          (
            Number.isInteger(parsed.test_force_terminate_before_progress_attempts) &&
            responseAttemptNumber <= parsed.test_force_terminate_before_progress_attempts
          )
        ) {
          createTerminatedSseResponse(res, [
            'data: {"type":"response.created","response":{"id":"resp_terminated","model":"gpt-5.4"}}\n\n',
          ], parsed.test_terminate_delay_ms ?? 20, parsed.test_termination_header_copy_stall
            ? { "x-test-termination-header-copy-stall": "1" }
            : {});
          return;
        }
        if (parsed.test_force_terminate) {
          createTerminatedSseResponse(res, [
            'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
          ]);
          return;
        }
        if (parsed.stream) {
          if (parsed.test_stream_transient_error_attempts > 0) {
            const streamTransientErrorKey =
              `${req.url}:stream-transient-error:${parsed.test_sequence_key || "default"}`;
            const streamTransientErrorCount =
              (streamTransientErrorCounts.get(streamTransientErrorKey) || 0) + 1;
            streamTransientErrorCounts.set(streamTransientErrorKey, streamTransientErrorCount);
            if (streamTransientErrorCount <= parsed.test_stream_transient_error_attempts) {
              res.writeHead(200, {
                "content-type": "text/event-stream; charset=utf-8",
                "x-upstream-test": "responses-stream-transient-error",
              });
              res.end(
                `data: ${JSON.stringify({
                  type: "response.failed",
                  response: {
                    id: "resp_stream_transient_error",
                    error: parsed.test_stream_transient_error_payload ?? {
                      type: "insufficient_quota",
                      code: "billing_hard_limit_reached",
                      message: "You exceeded your current quota and token budget.",
                    },
                  },
                })}\n\ndata: [DONE]\n\n`,
              );
              return;
            }
          }
          if (parsed.test_stream_completed_error_payload) {
            res.writeHead(200, {
              "content-type": "text/event-stream; charset=utf-8",
              "x-upstream-test": "responses-stream-completed-error-payload",
            });
            res.end(
              `data: ${JSON.stringify({
                type: "response.completed",
                response: {
                  id: "resp_stream_completed",
                  model: "gpt-5.4",
                  error: parsed.test_stream_completed_error_payload,
                },
              })}\n\ndata: [DONE]\n\n`,
            );
            return;
          }
          if (parsed.test_force_malformed_json_for_stream) {
            res.writeHead(200, {
              "content-type": "application/json; charset=utf-8",
              "x-upstream-test": "responses-malformed-json",
            });
            res.end('{"output":[{"type":"reasoning","encrypted_content":"malformed-json-encrypted-secret"}');
            return;
          }
          if (parsed.test_force_text_for_stream) {
            res.writeHead(200, {
              "content-type": "text/plain; charset=utf-8",
              "x-upstream-test": "responses-text-fallback",
            });
            res.end(
              `plain fallback encrypted_content:${parsed.test_plain_text_secret ?? "plain-text-encrypted-secret"}`,
            );
            return;
          }
          if (parsed.test_force_slow_text_for_stream) {
            res.writeHead(200, {
              "content-type": "text/plain; charset=utf-8",
              "x-upstream-test": "responses-slow-text-fallback",
            });
            res.write(parsed.test_slow_text_first_chunk ?? "plain-first-chunk");
            setTimeout(
              () => res.end(parsed.test_slow_text_final_chunk ?? "plain-final-chunk"),
              parsed.test_slow_text_pause_ms ?? 200,
            );
            return;
          }
          if (parsed.test_force_json_for_stream) {
            finishJsonResponse();
            return;
          }
          let streamChunks = buildResponsesStreamChunks(parsed, reasoning, sequenceCount);
          if (typeof parsed.test_stream_first_event_field === "string" && streamChunks.length > 0) {
            streamChunks[0] = `${parsed.test_stream_first_event_field}\n${streamChunks[0]}`;
          }
          if (parsed.test_stream_prepend_bom && streamChunks.length > 0) {
            streamChunks[0] = `\uFEFF${streamChunks[0]}`;
          }
          if (typeof parsed.test_stream_event_separator === "string") {
            streamChunks = streamChunks.map((chunk) =>
              chunk.replaceAll("\n\n", parsed.test_stream_event_separator),
            );
          }
          if (Number.isInteger(parsed.test_stream_split_first_chunk_at)) {
            const firstChunk = streamChunks.shift() ?? "";
            streamChunks.unshift(
              firstChunk.slice(0, parsed.test_stream_split_first_chunk_at),
              firstChunk.slice(parsed.test_stream_split_first_chunk_at),
            );
          }
          if (Number.isInteger(parsed.test_stream_split_first_chunk_bytes_at)) {
            const firstChunk = Buffer.from(streamChunks.shift() ?? "", "utf8");
            streamChunks.unshift(
              firstChunk.subarray(0, parsed.test_stream_split_first_chunk_bytes_at),
              firstChunk.subarray(parsed.test_stream_split_first_chunk_bytes_at),
            );
          }
          const initialDelayMs = selectStreamSequenceValue(
            parsed,
            "test_stream_initial_delay_ms_sequence",
            sequenceCount,
          ) ?? parsed.test_stream_initial_delay_ms;
          if (parsed.test_stream_pause_after_first_chunk_ms) {
            createSseResponseWithPauseAfterFirstChunk(
              res,
              streamChunks,
              parsed.test_stream_pause_after_first_chunk_ms,
              parsed.test_stream_chunk_delay_ms ?? 20,
              parsed.test_stream_response_content_type
                ? { "content-type": parsed.test_stream_response_content_type }
                : {},
            );
          } else if (initialDelayMs !== undefined) {
            const streamChunkSentAtMs = [];
            if (parsed.test_record_stream_chunk_sent_at_ms) {
              requestSnapshot.stream_chunk_sent_at_ms = streamChunkSentAtMs;
            }
            createSseResponseWithInitialDelay(
              res,
              streamChunks,
              initialDelayMs,
              parsed.test_stream_chunk_delay_ms ?? 20,
              parsed.test_record_stream_chunk_sent_at_ms
                ? (sentAtMs) => streamChunkSentAtMs.push(sentAtMs)
                : null,
            );
          } else if (parsed.test_stream_pause_before_output_ms) {
            createSseResponseWithPauseBeforeOutput(
              res,
              streamChunks,
              parsed.test_stream_pause_before_output_ms,
              parsed.test_stream_chunk_delay_ms ?? 20,
              parsed.test_stream_response_content_type
                ? { "content-type": parsed.test_stream_response_content_type }
                : {},
            );
          } else if (parsed.test_stream_pause_after_empty_commentary_ms) {
            createSseResponseWithPauseAfterOutput(
              res,
              streamChunks,
              parsed.test_stream_pause_after_empty_commentary_ms,
              parsed.test_stream_chunk_delay_ms ?? 20,
              '"type":"response.commentary.delta"',
            );
          } else if (parsed.test_stream_pause_after_function_call_ms) {
            createSseResponseWithPauseAfterOutput(
              res,
              streamChunks,
              parsed.test_stream_pause_after_function_call_ms,
              parsed.test_stream_chunk_delay_ms ?? 20,
              '\"type\":\"function_call\"',
            );
          } else if (parsed.test_stream_pause_after_output_ms) {
            createSseResponseWithPauseAfterOutput(
              res,
              streamChunks,
              parsed.test_stream_pause_after_output_ms,
              parsed.test_stream_chunk_delay_ms ?? 20,
            );
          } else {
            createSseResponse(
              res,
              streamChunks,
              parsed.test_stream_chunk_delay_ms ?? 20,
              parsed.test_stream_response_content_type
                ? { "content-type": parsed.test_stream_response_content_type }
                : {},
            );
          }
          return;
        }
        if (parsed.test_json_body_delay_ms) {
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "x-upstream-test": "responses-json-body-delay",
          });
          setTimeout(() => {
            res.end(JSON.stringify(buildResponsePayload(parsed, reasoning)));
          }, parsed.test_json_body_delay_ms);
          return;
        }
        if (parsed.test_response_delay_ms) {
          setTimeout(finishJsonResponse, parsed.test_response_delay_ms);
          return;
        }
        finishJsonResponse();
      });
      return;
    }

    if (req.method === "POST" && chatCompletionPaths.has(req.url)) {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(body || "{}");
        } catch {
          createJsonResponse(
            res,
            400,
            { error: { code: "invalid_json", message: "invalid JSON request body" } },
            { "x-upstream-test": "invalid-json" },
          );
          return;
        }
        chatCompletionRequests.push({
          path: req.url,
          headers: {
            authorization: req.headers.authorization || "",
            userAgent: req.headers["user-agent"] || null,
          },
          body: parsed,
        });
        const sequenceKey = Array.isArray(parsed.test_reasoning_sequence)
          ? `${req.url}:${parsed.test_sequence_key || JSON.stringify(parsed.test_reasoning_sequence)}`
          : null;
        const sequenceCount = sequenceKey
          ? reasoningSequenceCounts.get(sequenceKey) || 0
          : 0;
        if (sequenceKey) {
          reasoningSequenceCounts.set(sequenceKey, sequenceCount + 1);
        }
        const reasoning = sequenceKey
          ? parsed.test_reasoning_sequence[
              Math.min(sequenceCount, parsed.test_reasoning_sequence.length - 1)
            ]
          : (parsed.test_reasoning_tokens ?? 128);
        if (reasoning === 516) {
          createSseResponse(
            res,
            buildChatCompletionStreamChunks(parsed, 516),
            parsed.test_stream_chunk_delay_ms ?? 20,
          );
          return;
        }

        createSseResponse(
          res,
          buildChatCompletionStreamChunks(parsed, 128),
          parsed.test_stream_chunk_delay_ms ?? 20,
        );
      });
      return;
    }

    createJsonResponse(res, 404, { error: "not found" });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.probeRequests = probeRequests;
      server.modelRequests = modelRequests;
      server.responseRequests = responseRequests;
      server.chatCompletionRequests = chatCompletionRequests;
      resolve(server);
    });
  });
}

function tailText(value, maxLength = 2000) {
  const text = `${value || ""}`;
  return text.length <= maxLength ? text : text.slice(-maxLength);
}

function escapeRegExp(value) {
  return `${value}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactDiagnosticText(value) {
  let text = `${value || ""}`;
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+\-/=]+/gi, "Bearer [REDACTED]");
  text = text.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[REDACTED]");
  text = text.replace(
    /((?:["'])?(?:authorization|api[_-]?key|openai_api_key|cookie|set[-_]?cookie)(?:["'])?\s*[:=]\s*)(["'])(?:\\.|(?!\2).)*\2/gi,
    "$1$2[REDACTED]$2",
  );
  text = text.replace(
    /\b(authorization|api[_-]?key|openai_api_key|cookie|set[-_]?cookie)\b\s*[:=]\s*[^\r\n|]+/gi,
    (_match, key) => `${key}: [REDACTED]`,
  );
  const home = os.homedir();
  if (home) {
    const variants = new Set([
      home,
      home.replaceAll("\\", "/"),
      home.replaceAll("\\", "\\\\"),
    ]);
    for (const variant of variants) {
      if (variant) {
        text = text.replace(new RegExp(escapeRegExp(variant), "gi"), "~");
      }
    }
  }
  return text;
}

function diagnosticTail(value, maxLength = 2000) {
  return tailText(redactDiagnosticText(value), maxLength);
}

async function buildGatewayHealthDiagnostics({ gateway = null, logPath = null } = {}) {
  const details = [];
  if (gateway?.child) {
    details.push(
      `child pid=${gateway.child.pid ?? "unknown"} exitCode=${gateway.child.exitCode ?? "null"} signalCode=${gateway.child.signalCode ?? "null"} killed=${gateway.child.killed}`,
    );
  }
  if (gateway?.getOutput) {
    const output = gateway.getOutput();
    if (output.stdout) {
      details.push(`stdout_tail=${JSON.stringify(diagnosticTail(output.stdout))}`);
    }
    if (output.stderr) {
      details.push(`stderr_tail=${JSON.stringify(diagnosticTail(output.stderr))}`);
    }
  }
  if (logPath) {
    try {
      const logText = await readFile(logPath, "utf8");
      if (logText) {
        details.push(`log_tail=${JSON.stringify(diagnosticTail(logText))}`);
      }
    } catch (error) {
      details.push(`log_read_error=${error?.message || error}`);
    }
  }
  return details.length > 0 ? ` diagnostics=${details.join(" | ")}` : "";
}

async function waitForHealth(url, options = {}) {
  const normalizedOptions = typeof options === "number" ? { timeoutMs: options } : options;
  const timeoutMs = normalizedOptions.timeoutMs ?? 15000;
  const startedAt = Date.now();
  let lastStatus = null;
  let lastBody = "";
  let lastError = "";
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      lastStatus = response.status;
      const bodyText = await response.text();
      lastBody = diagnosticTail(bodyText, 500);
      if (response.ok) {
        try {
          const payload = JSON.parse(bodyText);
          if (payload?.ok === true) {
            return;
          }
          lastError = "health JSON missing ok=true";
        } catch (error) {
          lastError = `health response is not JSON: ${error?.message || error}`;
        }
      } else {
        lastError = `health status ${response.status}`;
      }
    } catch (error) {
      lastError = `${error?.message || error}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const diagnostics = await buildGatewayHealthDiagnostics(normalizedOptions);
  const statusText = lastStatus === null ? "null" : String(lastStatus);
  throw new Error(
    `等待网关健康检查超时: ${url} timeoutMs=${timeoutMs} lastStatus=${statusText} lastError=${lastError || "none"} lastBody=${JSON.stringify(lastBody)}${diagnostics}`,
  );
}

async function assertWaitForHealthRejectsInvalidOk() {
  const port = await getFreePort();
  const server = http.createServer((req, res) => {
    createJsonResponse(res, 200, {
      ok: false,
      OPENAI_API_KEY: "sk-health-test-secret",
      authorization: "Basic health-basic-secret",
      cookie: "session=health-cookie-secret; theme=dark",
      set_cookie: "token=health-set-cookie-secret",
      home_path: path.join(os.homedir(), "health-secret"),
      escaped_home_path: JSON.stringify(path.join(os.homedir(), "health-secret")).slice(1, -1),
    });
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  try {
    let failed = false;
    try {
      await waitForHealth(`http://127.0.0.1:${port}/health`, { timeoutMs: 500 });
    } catch (error) {
      failed = true;
      const message = `${error?.message || error}`;
      assert(message.includes("lastStatus=200"), `health 失败诊断应包含最后状态码: ${message}`);
      assert(message.includes("lastBody="), `health 失败诊断应包含 lastBody 字段: ${message}`);
      assert(
        message.includes("lastError=health JSON missing ok=true"),
        `health 失败诊断应包含 ok=false 根因: ${message}`,
      );
      assert(!message.includes("sk-health-test-secret"), `health 失败诊断不应泄露 key: ${message}`);
      assert(!message.includes("health-basic-secret"), `health 失败诊断不应泄露 Basic auth: ${message}`);
      assert(!message.includes("health-cookie-secret"), `health 失败诊断不应泄露 Cookie: ${message}`);
      assert(!message.includes("health-set-cookie-secret"), `health 失败诊断不应泄露 Set-Cookie: ${message}`);
      assert(!message.includes(os.homedir()), `health 失败诊断不应泄露 home 路径: ${message}`);
      assert(
        !message.includes(os.homedir().replaceAll("\\", "/")),
        `health 失败诊断不应泄露 slash 归一化 home 路径: ${message}`,
      );
      assert(message.includes("[REDACTED]"), `health 失败诊断应脱敏 key: ${message}`);
    }
    assert(failed, "waitForHealth 不应把 ok=false 的 200 响应视为健康");
  } finally {
    server.close();
    await once(server, "close");
  }
}
async function waitForStatusCondition(url, predicate, timeoutMs = 5000) {
  const startedAt = Date.now();
  let lastPayload = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      lastPayload = await fetch(url).then((response) => response.json());
      if (predicate(lastPayload)) {
        return lastPayload;
      }
    } catch {
      // ignore startup race
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `等待状态条件超时: ${url} last=${JSON.stringify(lastPayload)}`,
  );
}

function startGateway(configPath, logPath, options = {}) {
  const nodeArgs = Array.isArray(options.nodeArgs) ? options.nodeArgs : [];
  const child = spawn(
    process.execPath,
    [...nodeArgs, gatewayEntry, "--config", configPath, "--log", logPath],
    {
      cwd: gatewayRoot,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  let closed = false;
  child.__codexRetryGatewayClosePromise = new Promise((resolve) => {
    const markClosed = () => {
      closed = true;
      resolve(true);
    };
    child.once("close", markClosed);
    child.once("error", markClosed);
  });
  child.__codexRetryGatewayIsClosed = () => closed;

  return {
    child,
    getOutput() {
      return { stdout, stderr };
    },
  };
}

function waitForChildClose(child, timeoutMs = 5000) {
  if (!child) {
    return Promise.resolve(true);
  }
  if (typeof child.__codexRetryGatewayIsClosed === "function" && child.__codexRetryGatewayIsClosed()) {
    return Promise.resolve(true);
  }
  if (child.__codexRetryGatewayClosePromise) {
    return Promise.race([
      child.__codexRetryGatewayClosePromise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (closed) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.off("close", onClose);
      child.off("error", onError);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const onError = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("close", onClose);
    child.once("error", onError);
  });
}

async function stopGateway(gateway) {
  const child = gateway?.child;
  if (!child) {
    return;
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
  }
  let closed = await waitForChildClose(child, 5000);
  if (!closed && process.platform === "win32" && child.pid) {
    try {
      await execFileText("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
      });
    } catch {
      // 进程可能已经退出；后续再等待一次 close。
    }
    closed = await waitForChildClose(child, 3000);
  }
  if (!closed) {
    process.stderr.write(
      `[cleanup-warning] gateway child did not close pid=${child.pid ?? "unknown"}\n`,
    );
  }
}

async function readSseUntilClose(url, requestBody, options = {}) {
  const startedAtMs = Date.now();
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    body: JSON.stringify(requestBody),
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf8");
  let text = "";
  let closedByError = false;
  let firstChunkAtMs = null;

  while (true) {
    try {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (firstChunkAtMs === null) {
        firstChunkAtMs = Date.now();
      }
      text += decoder.decode(value, { stream: true });
    } catch (error) {
      closedByError = true;
      text += `\n[[reader-error:${error?.name || "unknown"}]]`;
      break;
    }
  }

  text += decoder.decode();
  const completedAtMs = Date.now();
  return {
    status: response.status,
    headers: response.headers,
    text,
    closedByError,
    startedAtMs,
    firstChunkAtMs,
    completedAtMs,
  };
}

function objectHasKeyDeep(value, key) {
  if (Array.isArray(value)) {
    return value.some((item) => objectHasKeyDeep(item, key));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Object.hasOwn(value, key)) {
    return true;
  }
  return Object.values(value).some((entry) => objectHasKeyDeep(entry, key));
}

function assertContinuationRequestShape(
  requests,
  label,
  { expectedOriginalText = null, expectFirstEncryptedInclude = false } = {},
) {
  assert(requests.length === 2, `${label} 应向上游请求 2 次: ${requests.length}`);
  const firstIncludesEncryptedReasoning =
    Array.isArray(requests[0].body?.include) &&
    requests[0].body.include.includes("reasoning.encrypted_content");
  assert(
    firstIncludesEncryptedReasoning === expectFirstEncryptedInclude,
    expectFirstEncryptedInclude
      ? `${label} 第一轮显式 include 应保留 reasoning.encrypted_content: ${JSON.stringify(requests[0].body?.include)}`
      : `${label} 第一轮不应自动补 reasoning.encrypted_content: ${JSON.stringify(requests[0].body?.include)}`,
  );
  const followupInput = requests[1]?.body?.input || [];
  assert(Array.isArray(followupInput), `${label} 第二轮 input 应为数组: ${JSON.stringify(followupInput)}`);
  const followupSerialized = JSON.stringify(followupInput);
  assert(
    !followupInput.some((item) => item?.type === "reasoning") &&
      !objectHasKeyDeep(followupInput, "encrypted_content") &&
      !followupSerialized.includes("encrypted-test-content") &&
      !followupSerialized.includes("client-origin-encrypted-secret"),
    `${label} 第二轮安全续写不应 replay 命中轮 encrypted reasoning: ${JSON.stringify(followupInput)}`,
  );
  assert(
    !(
      Array.isArray(requests[1]?.body?.include) &&
      requests[1].body.include.includes("reasoning.encrypted_content")
    ),
    `${label} 第二轮安全续写不应继续请求 encrypted reasoning: ${JSON.stringify(requests[1]?.body?.include)}`,
  );
  assert(
    countContinuationMarkers(followupInput) === 1,
    `${label} 第二轮请求应且只应追加 1 个 phase=commentary 标记: ${JSON.stringify(followupInput)}`,
  );
  assert(
    requests[1]?.body?.previous_response_id === undefined,
    `${label} 第二轮请求应删除 previous_response_id: ${JSON.stringify(requests[1]?.body)}`,
  );
  if (expectedOriginalText) {
    assert(
      followupInput.every((item) => typeof item !== "string"),
      `${label} 第二轮 input 数组不应包含裸字符串: ${JSON.stringify(followupInput)}`,
    );
    assert(
      followupInput.some(
        (item) =>
          item?.type === "message" &&
          item?.role === "user" &&
          `${item?.content || ""}`.includes(expectedOriginalText),
      ),
      `${label} 第二轮请求应保留原始用户输入: ${JSON.stringify(followupInput)}`,
    );
  }
}

function countSsePayloadText(text, pattern) {
  return (text.match(pattern) || []).length;
}

function assertSingleFinalSseEnvelope(text, label) {
  assert(
    countSsePayloadText(text, /"type":"response\.created"/g) === 1,
    `${label} 应只透出一个 response.created: ${text}`,
  );
  assert(
    countSsePayloadText(text, /"type":"response\.in_progress"/g) === 1,
    `${label} 应只透出一个 response.in_progress: ${text}`,
  );
  assert(
    countSsePayloadText(text, /"type":"response\.completed"/g) === 1,
    `${label} 应只透出一个 response.completed: ${text}`,
  );
  assert(
    countSsePayloadText(text, /^data: \[DONE\]$/gm) === 1,
    `${label} 应只透出一个 [DONE]: ${text}`,
  );
  const completedIndex = text.indexOf('"type":"response.completed"');
  const doneIndex = text.indexOf("data: [DONE]");
  assert(
    completedIndex >= 0 && doneIndex > completedIndex,
    `${label} response.completed 应出现在 [DONE] 之前: ${text}`,
  );
}

function parseSseJsonPayloads(text) {
  const payloads = [];
  for (const block of `${text || ""}`.split(/\r?\n\r?\n/)) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.replace(/^data:\s?/, ""));
    if (dataLines.length === 0) {
      continue;
    }
    const payloadText = dataLines.join("\n");
    if (payloadText === "[DONE]") {
      continue;
    }
    try {
      payloads.push(JSON.parse(payloadText));
    } catch {
      // 非 JSON SSE 数据不参与结构断言。
    }
  }
  return payloads;
}

function countContinuationMarkers(input) {
  if (!Array.isArray(input)) {
    return 0;
  }
  return input.filter((item) => item?.type === "message" && item?.phase === "commentary").length;
}

function inputContainsText(input, expectedText) {
  return JSON.stringify(input || "").includes(expectedText);
}

function assertTextDoesNotLeakEncryptedContent(text, label, secrets = []) {
  assert(!text.includes("encrypted_content"), `${label} 不应包含 encrypted_content 字段名: ${text}`);
  assert(!text.includes("\\u0065ncrypted_content"), `${label} 不应包含 escaped encrypted_content 字段名: ${text}`);
  for (const secret of secrets) {
    assert(!text.includes(secret), `${label} 不应包含敏感值 ${secret}: ${text}`);
  }
}

function assertTextContainsAll(text, label, values) {
  for (const value of values) {
    assert(text.includes(value), `${label} 应包含样本定位 key ${value}: ${text}`);
  }
}

function assertSseEnvelopeIdentity(text, label, { expectedId, expectedModel }) {
  assertSingleFinalSseEnvelope(text, label);
  const payloads = parseSseJsonPayloads(text);
  const lifecyclePayloads = payloads.filter((payload) =>
    ["response.created", "response.in_progress", "response.completed"].includes(payload?.type),
  );
  assert(
    lifecyclePayloads.length === 3,
    `${label} 应只包含 created/in_progress/completed 三个 lifecycle payload: ${text}`,
  );
  for (const payload of lifecyclePayloads) {
    assert(
      payload?.response?.id === expectedId && payload?.response?.model === expectedModel,
      `${label} lifecycle 身份应全部来自最终干净轮 ${expectedId}/${expectedModel}: ${JSON.stringify(payload)}; body=${text}`,
    );
  }
  for (const payload of payloads) {
    if (payload?.response && Object.hasOwn(payload.response, "id")) {
      assert(
        payload.response.id === expectedId,
        `${label} 所有带 response.id 的 payload 都应来自最终干净轮 ${expectedId}: ${JSON.stringify(payload)}; body=${text}`,
      );
    }
    if (payload?.response && Object.hasOwn(payload.response, "model")) {
      assert(
        payload.response.model === expectedModel,
        `${label} 所有带 response.model 的 payload 都应来自最终干净轮 ${expectedModel}: ${JSON.stringify(payload)}; body=${text}`,
      );
    }
    if (Object.hasOwn(payload, "model")) {
      assert(
        payload.model === expectedModel,
        `${label} 所有顶层 model 都应来自最终干净轮 ${expectedModel}: ${JSON.stringify(payload)}; body=${text}`,
      );
    }
  }
}
async function run() {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "codex-retry-gateway-"),
  );
  const upstreamPort = await getFreePort();
  const gatewayPort = await getFreePort();
  const probeGatewayPort = await getFreePort();
  const warningProbeGatewayPort = await getFreePort();
  const limitGatewayPort = await getFreePort();
  const configPath = path.join(tempRoot, "config.json");
  const logPath = path.join(tempRoot, "gateway.log");
  const limitConfigPath = path.join(tempRoot, "limit-config.json");
  const limitLogPath = path.join(tempRoot, "limit-gateway.log");
  const probeConfigDir = path.join(tempRoot, "probe-runtime");
  const probeConfigPath = path.join(probeConfigDir, "config.json");
  const probeLogPath = path.join(tempRoot, "probe-gateway.log");
  const probeCodexConfigPath = path.join(tempRoot, "probe-codex-config.toml");
  const probeStatePath = path.join(tempRoot, "state.json");
  const warningProbeRoot = path.join(tempRoot, "warning-probe");
  const warningProbeConfigDir = path.join(warningProbeRoot, "config");
  const warningProbeConfigPath = path.join(
    warningProbeConfigDir,
    "config.json",
  );
  const warningProbeLogPath = path.join(warningProbeRoot, "gateway.log");
  const warningProbeCodexConfigPath = path.join(
    warningProbeRoot,
    "codex-config.toml",
  );
  const warningProbeStatePath = path.join(warningProbeRoot, "state.json");

  const config = {
    listen_host: "127.0.0.1",
    listen_port: gatewayPort,
    upstream_base_url: `http://127.0.0.1:${upstreamPort}`,
    request_body_limit_bytes: 10 * 1024 * 1024,
    endpoints: [
      "/responses",
      "/chat/completions",
      "/v1/responses",
      "/v1/chat/completions",
    ],
    reasoning_equals: [516],
    non_stream_status_code: 502,
    stream_action: "strict_502",
    transient_retry: {
      enabled: false,
      initial_delay_ms: 0,
      max_delay_ms: 0,
    },
    log_match: true,
    health_path: "/__codex_retry_gateway/health",
  };

  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
  const limitConfig = {
    ...config,
    listen_port: limitGatewayPort,
    request_body_limit_bytes: 1024,
  };
  await writeFile(
    limitConfigPath,
    JSON.stringify(limitConfig, null, 2),
    "utf8",
  );

  await assertWaitForHealthRejectsInvalidOk();

  const upstream = await startFakeUpstream(upstreamPort);
  const gateway = startGateway(configPath, logPath);
  const limitGateway = startGateway(limitConfigPath, limitLogPath);
  let probeGateway = null;
  let warningProbeGateway = null;

  try {
    await waitForHealth(`http://127.0.0.1:${gatewayPort}${config.health_path}`, { gateway, logPath });
    await waitForHealth(
      `http://127.0.0.1:${limitGatewayPort}${config.health_path}`,
      { gateway: limitGateway, logPath: limitLogPath },
    );

    const modelsResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/v1/models`,
    );
    assert(
      modelsResponse.status === 200,
      `/v1/models 透传状态异常: ${modelsResponse.status}`,
    );
    assert(
      modelsResponse.headers.get("x-upstream-test") === "models-ok",
      "/v1/models 未保留上游头",
    );

    const statusBeforeUiRefresh = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      statusBeforeUiRefresh.config?.intercept_streaming === true,
      "intercept_streaming 默认应开启",
    );
    assert(
      statusBeforeUiRefresh.config?.intercept_non_streaming === true,
      "intercept_non_streaming 默认应开启",
    );
    assert(
      statusBeforeUiRefresh.config?.guard_retry_attempts === 5,
      "guard_retry_attempts 默认应为 5",
    );
    for (const field of [
      "model_unavailable_error_action",
      "http_502_503_error_action",
      "other_http_4xx_error_action",
      "other_http_5xx_error_action",
      "error_message_fallback_action",
    ]) {
      assert(
        statusBeforeUiRefresh.config?.[field] === "retry_then_pass_through",
        `${field} 默认应为 retry_then_pass_through`,
      );
    }
    const isolateNewUpstreamPoliciesResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model_unavailable_error_action: "pass_through",
          http_502_503_error_action: "pass_through",
          other_http_4xx_error_action: "pass_through",
          other_http_5xx_error_action: "pass_through",
          error_message_fallback_action: "pass_through",
        }),
      },
    );
    const isolatedNewUpstreamPolicies = await isolateNewUpstreamPoliciesResponse.json();
    assert(
      isolateNewUpstreamPoliciesResponse.status === 200 &&
        [
          "model_unavailable_error_action",
          "http_502_503_error_action",
          "other_http_4xx_error_action",
          "other_http_5xx_error_action",
          "error_message_fallback_action",
        ].every((field) => isolatedNewUpstreamPolicies.config?.[field] === "pass_through"),
      "新增上游错误策略保存后应立即在状态接口回读",
    );
    assert(
      statusBeforeUiRefresh.config?.retry_upstream_capacity_errors === true,
      "retry_upstream_capacity_errors 默认应为 true",
    );
    assert(
      statusBeforeUiRefresh.config?.intercept_rule_mode === "reasoning_tokens",
      "intercept_rule_mode 默认应为 reasoning_tokens",
    );
    assert(
      statusBeforeUiRefresh.config?.reasoning_match_mode === "formula_518n_minus_2",
      "reasoning_match_mode 默认应为 formula_518n_minus_2",
    );
    assert(
      statusBeforeUiRefresh.config?.stream_action === "strict_502",
      "stream_action 显式配置为 strict_502 时应保留",
    );
    assert(
      statusBeforeUiRefresh.config?.continuation_marker_text === "Continue thinking...",
      "continuation_marker_text 默认值应暴露在状态接口",
    );
    assert(statusBeforeUiRefresh.active_probe, "status 缺少 active_probe");
    assert(
      statusBeforeUiRefresh.active_probe.enabled === false,
      "active_probe 默认应关闭",
    );
    assert(
      statusBeforeUiRefresh.active_probe.running === false,
      "active_probe 初始不应处于运行中",
    );
    assert(
      statusBeforeUiRefresh.active_probe.total_runs === 0,
      "active_probe 初始 total_runs 应为 0",
    );
    assert(
      statusBeforeUiRefresh.active_probe.warning_count === 0,
      "active_probe 初始 warning_count 应为 0",
    );
    assert(
      statusBeforeUiRefresh.active_probe.violation_count === 0,
      "active_probe 初始 violation_count 应为 0",
    );
    assert(
      Array.isArray(statusBeforeUiRefresh.active_probe.recent_samples),
      "active_probe.recent_samples 应为数组",
    );
    assert(
      typeof statusBeforeUiRefresh.active_probe.warning_type_counts ===
        "object" &&
        statusBeforeUiRefresh.active_probe.warning_type_counts !== null,
      "active_probe.warning_type_counts 应存在",
    );
    assert(
      typeof statusBeforeUiRefresh.active_probe.violation_type_counts ===
        "object" &&
        statusBeforeUiRefresh.active_probe.violation_type_counts !== null,
      "active_probe.violation_type_counts 应存在",
    );
    const uiHtml = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/ui`,
    ).then((response) => response.text());
    const inlineScriptMatch = uiHtml.match(/<script>([\s\S]*)<\/script>/);
    assert(inlineScriptMatch, "管理页缺少内联脚本");
    try {
      new vm.Script(inlineScriptMatch[1]);
    } catch (error) {
      throw new Error(`管理页内联脚本语法无效: ${error?.message || error}`);
    }
    assert(
      uiHtml.includes('id="statsFootnote"'),
      "管理页运行状态脚注缺少 statsFootnote 挂点",
    );
    assert(!uiHtml.includes("家族声明分布"), "管理页不应再显示家族声明分布");
    assert(
      !uiHtml.includes('id="family54Stats"'),
      "管理页不应再渲染 family54Stats",
    );
    assert(
      !uiHtml.includes('id="family55Stats"'),
      "管理页不应再渲染 family55Stats",
    );
    assert(
      !uiHtml.includes("<h3>gpt-5.4</h3>"),
      "管理页不应再显示 gpt-5.4 分列标题",
    );
    assert(
      !uiHtml.includes("<h3>gpt-5.5</h3>"),
      "管理页不应再显示 gpt-5.5 分列标题",
    );
    assert(
      !uiHtml.includes('id="family54Summary"'),
      "管理页不应再渲染 family54Summary",
    );
    assert(
      !uiHtml.includes('id="family55Summary"'),
      "管理页不应再渲染 family55Summary",
    );
    assert(
      uiHtml.includes('id="probeTargetFamily54Input"'),
      "管理页缺少 gpt-5.4 主动探针复选框",
    );
    assert(
      uiHtml.includes('id="probeTargetFamily55Input"'),
      "管理页缺少 gpt-5.5 主动探针复选框",
    );
    for (const [controlId, model] of [
      ["probeTargetFamily56SolInput", "gpt-5.6-sol"],
      ["probeTargetFamily56TerraInput", "gpt-5.6-terra"],
      ["probeTargetFamily56LunaInput", "gpt-5.6-luna"],
    ]) {
      assert(uiHtml.includes(`id="${controlId}"`), `管理页缺少 ${model} 主动探针复选框`);
    }
    assert(
      uiHtml.includes('id="probeAutoEnabledInput"'),
      "管理页缺少自动探测开关",
    );
    assert(
      uiHtml.includes('id="probeIntervalMinutesInput"'),
      "管理页缺少主动探针分钟频率输入框",
    );
    assert(uiHtml.includes('id="probeRunButton"'), "管理页缺少立即探测按钮");
    assert(
      uiHtml.includes('id="interceptStreamingInput"'),
      "管理页缺少流式拦截复选框",
    );
    assert(
      uiHtml.includes('id="interceptNonStreamingInput"'),
      "管理页缺少非流式拦截复选框",
    );
    assert(
      uiHtml.includes('id="interceptRuleModeSelect"') &&
        uiHtml.includes('value="reasoning_tokens"') &&
        uiHtml.includes('value="final_answer_only_high_xhigh"') &&
        uiHtml.includes('<option value="none">') &&
        uiHtml.includes("final answer only") &&
        uiHtml.includes("不使用 reasoning 规则") &&
        uiHtml.includes("命中条件"),
      "管理页缺少三种 reasoning 规则模式",
    );
    assert(
      uiHtml.includes('id="reasoningMatchModeSelect"') &&
        uiHtml.includes('value="manual"') &&
        uiHtml.includes('value="formula_518n_minus_2"') &&
        uiHtml.includes("手动填写 reasoning_equals") &&
        uiHtml.includes("518*n - 2 规则") &&
        uiHtml.includes("2070") &&
        uiHtml.includes("续写恢复不是单独的拦截规则"),
      "管理页缺少 reasoning match 下拉框与 518*n - 2 公式说明",
    );
    assert(
      uiHtml.includes('id="continuationRecoveryCountValue"') &&
        uiHtml.includes("续写次数") &&
        uiHtml.includes('id="continuationRecoverySuccessRatioValue"') &&
        uiHtml.includes("续写成功率"),
      "管理页运行状态缺少续写次数和续写成功率卡片",
    );
    assert(
      uiHtml.includes('id="streamActionStrict502Input"') &&
        uiHtml.includes('value="strict_502"') &&
        uiHtml.includes('id="streamActionDisconnectInput"') &&
        uiHtml.includes('value="disconnect"') &&
        uiHtml.includes('id="streamActionContinuationRecoveryInput"') &&
        uiHtml.includes('value="continuation_recovery"') &&
        uiHtml.includes("命中后处理") &&
        uiHtml.includes("标准保护：网关内重试，耗尽后返回 502") &&
        uiHtml.includes("续写恢复：Responses 流式先续写") &&
        uiHtml.includes("兼容旧行为：已透传时断开连接"),
      "管理页缺少命中后处理与续写恢复选项",
    );
    assert(
      uiHtml.includes("当前生效策略") &&
        uiHtml.includes('id="policySummaryValue"') &&
        uiHtml.includes("命中后最大内部尝试次数") &&
        uiHtml.includes("所有命中后内部动作共用这里的次数"),
      "管理页缺少一眼可读的当前策略摘要与内部尝试次数说明",
    );
    assert(
      uiHtml.includes('id="capacityErrorActionSelect"') &&
        uiHtml.includes('id="http429ActionSelect"') &&
        uiHtml.includes('id="transientRetryEnabledInput"') &&
        uiHtml.includes('id="transientRetryInitialDelayMsInput"') &&
        uiHtml.includes('id="transientRetryMaxDelayMsInput"') &&
        uiHtml.includes('id="latencyGuardEnabledInput"') &&
        uiHtml.includes('id="firstProgressTimeoutMsInput"') &&
        uiHtml.includes('id="firstProgressActionSelect"') &&
        uiHtml.includes('id="totalTimeoutMsInput"'),
      "管理页缺少 Capacity、HTTP 429、临时故障自动恢复或响应超时策略控件",
    );
    assert(
      (uiHtml.match(/class="field compact-config-field"/g) || []).length >= 3 &&
        uiHtml.includes(".compact-config-field input") &&
        uiHtml.includes("min-height: 38px;") &&
        uiHtml.includes("font-size: 13px;"),
      "non_stream_status_code 与网关内重试次数输入框应使用紧凑配置样式",
    );
    assert(
      uiHtml.includes('id="endpointsInput"') &&
        uiHtml.includes(".compact-config-field textarea") &&
        uiHtml.includes("min-height: 104px;") &&
        uiHtml.includes("font-weight: 600;"),
      "endpoints 多行输入框应使用紧凑配置样式，避免组件和字体过大",
    );
    assert(
      uiHtml.indexOf('name="capacity_error_action"') > -1 &&
        uiHtml.indexOf('name="http_429_action"') > -1 &&
        uiHtml.indexOf('name="log_match"') > -1,
      "Capacity、HTTP 429 与 log_match 控件缺失",
    );
    assert(
      uiHtml.includes('id="interceptModeValue"'),
      "管理页缺少当前拦截模式展示",
    );
    assert(
      uiHtml.includes('id="guardRetryAttemptsInput"'),
      "管理页缺少网关内重试次数输入框",
    );
    assert(uiHtml.includes("命中后最大内部尝试次数"), "管理页缺少命中后最大内部尝试次数标签");
    assert(
      uiHtml.includes('id="capacityErrorActionSelect"'),
      "管理页缺少上游 Capacity 动作选择",
    );
    assert(
      uiHtml.includes("Capacity") && uiHtml.includes("HTTP 429"),
      "管理页缺少上游 Capacity 或 HTTP 429 策略标签",
    );
    assert(uiHtml.includes("TG群："), "管理页缺少 TG 群入口文案");
    assert(
      uiHtml.includes('href="https://t.me/AI_INPUT_IM"'),
      "管理页缺少 TG 群链接",
    );
    assert(
      uiHtml.indexOf('name="guard_retry_attempts"') <
        uiHtml.indexOf('name="non_stream_status_code"') &&
        uiHtml.indexOf('name="non_stream_status_code"') <
          uiHtml.indexOf('name="capacity_error_action"') &&
        uiHtml.indexOf('name="capacity_error_action"') <
          uiHtml.indexOf('name="log_match"'),
      "命中后最大内部尝试次数、最终状态码和上游 Capacity 策略应位于 log_match 之前",
    );
    assert(
      !uiHtml.includes("516 命中次数"),
      "管理页不应再显示 516 命中次数卡片",
    );
    assert(!uiHtml.includes("516 占比"), "管理页不应再显示 516 占比卡片");
    assert(
      uiHtml.includes("当前规则命中总数"),
      "管理页缺少当前规则命中总数卡片",
    );
    assert(uiHtml.includes("实际拦截总数"), "管理页缺少实际拦截总数卡片");
    assert(uiHtml.includes("实际拦截占比"), "管理页缺少实际拦截占比卡片");
    const matchedStatsIndex = uiHtml.indexOf("当前规则命中总数");
    const blockedTotalStatsIndex = uiHtml.indexOf("实际拦截总数");
    const blockedRatioStatsIndex = uiHtml.indexOf("实际拦截占比");
    assert(
      matchedStatsIndex < blockedTotalStatsIndex &&
        blockedTotalStatsIndex < blockedRatioStatsIndex,
      "管理页统计卡片顺序应为当前规则命中总数、实际拦截总数、实际拦截占比",
    );
    await verifyRenderedUiEvidenceDetailsBehavior(uiHtml);
    await fetch(`http://127.0.0.1:${gatewayPort}/favicon.ico`);
    const statusAfterUiRefresh = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      statusBeforeUiRefresh.metrics.bypassed_proxy_request_count === 1,
      "status 未正确记录未纳入检查的透传请求数",
    );
    assert(
      statusBeforeUiRefresh.metrics.failed_proxy_request_count === 0,
      "测试基线下不应存在代理失败请求",
    );
    assert(
      statusBeforeUiRefresh.metrics.total_proxy_request_count -
        statusBeforeUiRefresh.metrics.inspected_response_count ===
        statusBeforeUiRefresh.metrics.bypassed_proxy_request_count +
          statusBeforeUiRefresh.metrics.failed_proxy_request_count,
      "代理请求总数与被检查响应总数的差值应能由透传请求和失败请求解释",
    );
    assert(
      statusAfterUiRefresh.metrics.total_proxy_request_count ===
        statusBeforeUiRefresh.metrics.total_proxy_request_count,
      "管理页刷新相关请求不应增加代理请求总数",
    );
    const enableTransientRetryForBypassBoundary = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          transient_retry: {
            enabled: true,
            initial_delay_ms: 0,
            max_delay_ms: 0,
          },
        }),
      },
    );
    assert(
      enableTransientRetryForBypassBoundary.status === 200,
      "旁路边界测试前启用临时重试失败",
    );
    const brokenBypassKey = "bypass-fetch-fallback-must-remain-bounded";
    const brokenBypassResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/v1/models?test_sequence_key=${encodeURIComponent(brokenBypassKey)}&test_fail_before_response_attempts=2`,
    );
    assert(
      brokenBypassResponse.status === 502,
      `异常旁路请求应返回 502，实际为 ${brokenBypassResponse.status}`,
    );
    assert(
      upstream.modelRequests.filter((entry) => entry.sequence_key === brokenBypassKey).length === 2,
      "列表外路径只应保留原有两次 fetch fallback，不应进入临时故障持续重试",
    );
    const disableTransientRetryAfterBypassBoundary = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          transient_retry: {
            enabled: false,
            initial_delay_ms: 0,
            max_delay_ms: 0,
          },
        }),
      },
    );
    assert(
      disableTransientRetryAfterBypassBoundary.status === 200,
      "旁路边界测试后恢复临时重试配置失败",
    );
    const statusAfterBrokenBypass = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      statusAfterBrokenBypass.metrics.bypassed_proxy_request_count ===
        statusBeforeUiRefresh.metrics.bypassed_proxy_request_count,
      "旁路透传半路失败时不应同时计入 bypassed_proxy_request_count",
    );
    assert(
      statusAfterBrokenBypass.metrics.failed_proxy_request_count ===
        statusBeforeUiRefresh.metrics.failed_proxy_request_count + 1,
      "旁路透传半路失败时应单独计入 failed_proxy_request_count",
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    const brokenBypassLogText = await readFile(logPath, "utf8");
    assert(
      brokenBypassLogText.includes(
        "[upstream-error] fetch failed after retry path=/v1/models",
      ),
      "上游 fetch failed 应记录为 upstream-error 摘要日志",
    );
    assert(
      !brokenBypassLogText.includes("[error] TypeError: fetch failed"),
      "上游 fetch failed 不应记录为 gateway 内部 error 堆栈",
    );
    const uploadDisconnectMetricsBefore = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    const uploadDisconnectKey = "client-disconnect-during-request-upload";
    await abortRequestDuringUpload(gatewayPort, uploadDisconnectKey);
    let uploadDisconnectSample = null;
    const uploadDisconnectDeadline = Date.now() + 3000;
    while (!uploadDisconnectSample && Date.now() < uploadDisconnectDeadline) {
      const payload = await fetch(
        `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning`,
      ).then((response) => response.json());
      uploadDisconnectSample = (payload.recent_samples || []).find(
        (sample) =>
          sample.request_summary?.sanitized_headers?.["x-test-key"] === uploadDisconnectKey,
      );
      if (!uploadDisconnectSample) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    const uploadDisconnectMetricsAfter = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      uploadDisconnectSample?.final_action === "client_disconnected" &&
        uploadDisconnectSample?.client_http_status === null &&
        Number(uploadDisconnectSample?.request_summary?.body_bytes) > 0 &&
        Number(uploadDisconnectSample?.request_summary?.body_bytes) < 65536,
      `上传阶段断连不得伪装成 413 request_rejected: ${JSON.stringify(uploadDisconnectSample)}`,
    );
    assert(
      uploadDisconnectMetricsAfter.metrics.total_proxy_request_count ===
        uploadDisconnectMetricsBefore.metrics.total_proxy_request_count + 1 &&
        uploadDisconnectMetricsAfter.metrics.failed_proxy_request_count ===
          uploadDisconnectMetricsBefore.metrics.failed_proxy_request_count + 1 &&
        uploadDisconnectMetricsAfter.metrics.inspected_response_count ===
          uploadDisconnectMetricsBefore.metrics.inspected_response_count,
      `上传阶段断连必须作为一个失败代理请求且不能计为 inspected: before=${JSON.stringify(uploadDisconnectMetricsBefore.metrics)} after=${JSON.stringify(uploadDisconnectMetricsAfter.metrics)}`,
    );
    const oversizedPayloadResponse = await fetch(
      `http://127.0.0.1:${limitGatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: Buffer.alloc(2048, 65),
      },
    );
    const oversizedPayloadBody = await oversizedPayloadResponse.json();
    assert(
      oversizedPayloadResponse.status === 413,
      `超限请求体应返回 413，实际为 ${oversizedPayloadResponse.status}`,
    );
    assert(
      oversizedPayloadBody?.error?.type === "gateway_rejection",
      "超限请求体应返回本地拒绝类型",
    );
    assert(
      oversizedPayloadBody?.error?.code === "request_body_limit_exceeded",
      "超限请求体应返回单独错误码",
    );
    assert(
      `${oversizedPayloadBody?.error?.message || ""}`.includes(
        "请求体超过限制",
      ),
      "超限请求体应返回明确错误信息",
    );
    const statusAfterOversizedPayload = await fetch(
      `http://127.0.0.1:${limitGatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      statusAfterOversizedPayload.metrics.failed_proxy_request_count === 1,
      "超限请求体应计入 failed_proxy_request_count",
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    const oversizedPayloadLogText = await readFile(limitLogPath, "utf8");
    assert(
      oversizedPayloadLogText.includes(
        "[gateway-reject] request body too large path=/responses",
      ),
      "超限请求体应记录为 gateway-reject 摘要日志",
    );
    assert(
      !oversizedPayloadLogText.includes("[error] Error: 请求体超过限制"),
      "超限请求体不应记录为 gateway 内部 error 堆栈",
    );
    const slowRequestPromise = fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          test_reasoning_tokens: 128,
          test_response_delay_ms: 180,
        }),
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    const statusDuringSlowRequest = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      statusDuringSlowRequest.metrics.active_proxy_request_count >= 1,
      "代理请求进行中时应记录 active_proxy_request_count",
    );
    assert(
      statusDuringSlowRequest.metrics.active_proxy_path_counts?.[
        "/responses"
      ] >= 1,
      "代理请求进行中时应记录 active_proxy_path_counts",
    );
    const slowRequestResponse = await slowRequestPromise;
    assert(
      slowRequestResponse.status === 200,
      `慢速代理请求状态异常: ${slowRequestResponse.status}`,
    );
    await slowRequestResponse.text();
    const statusAfterSlowRequest = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      statusAfterSlowRequest.metrics.active_proxy_request_count === 0,
      "代理请求结束后 active_proxy_request_count 应回到 0",
    );

    for (const responsePath of ["/responses", "/v1/responses"]) {
      const blockedResponse = await fetch(
        `http://127.0.0.1:${gatewayPort}${responsePath}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: responsePath === "/responses" ? "gpt-5.5" : "gpt-5.4",
            reasoning: {
              effort: responsePath === "/responses" ? "high" : "medium",
            },
            messages: [{ role: "user", content: "blocked sample" }],
            test_reasoning_tokens: 516,
            test_include_final_answer_only: true,
          }),
        },
      );
      const blockedBody = await blockedResponse.json();
      assert(
        blockedResponse.status === 502,
        `${responsePath} 516 未返回 502: ${blockedResponse.status}`,
      );
      assert(
        blockedBody?.error?.code === "reasoning_guard_triggered",
        `${responsePath} 516 返回体不正确`,
      );

      const okResponse = await fetch(
        `http://127.0.0.1:${gatewayPort}${responsePath}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: responsePath === "/responses" ? "gpt-5.4" : "gpt-5.5",
            reasoning: {
              effort: responsePath === "/responses" ? "medium" : "high",
            },
            messages: [{ role: "user", content: "ok sample" }],
            test_reasoning_tokens: 128,
          }),
        },
      );
      const okBody = await okResponse.json();
      assert(
        okResponse.status === 200,
        `${responsePath} 128 透传状态异常: ${okResponse.status}`,
      );
      assert(
        okResponse.headers.get("x-upstream-test") === "responses-128",
        `${responsePath} 128 未保留头`,
      );
      assert(
        okBody?.usage?.output_tokens_details?.reasoning_tokens === 128,
        `${responsePath} 128 返回体异常`,
      );
    }

    const defaultModeStatus = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      defaultModeStatus.metrics.matched_non_streaming_count === 12,
      `双开默认模式下非流式命中次数不正确: ${defaultModeStatus.metrics.matched_non_streaming_count}`,
    );
    assert(
      defaultModeStatus.metrics.blocked_non_streaming_count === 12,
      `双开默认模式下非流式拦截次数不正确: ${defaultModeStatus.metrics.blocked_non_streaming_count}`,
    );
    assert(
      defaultModeStatus.reasoning_behavior,
      "status 接口缺少 reasoning_behavior",
    );
    assert(
      defaultModeStatus.reasoning_behavior.schema_version === 3,
      "status reasoning_behavior 缺少 schema_version=3",
    );
    assert(
      defaultModeStatus.reasoning_behavior.analytics_ready === true,
      "status reasoning_behavior 缺少 analytics_ready=true",
    );
    assert(
      typeof defaultModeStatus.reasoning_behavior.analytics_started_at ===
        "string" &&
        defaultModeStatus.reasoning_behavior.analytics_started_at.length > 0,
      "status reasoning_behavior 缺少 analytics_started_at",
    );
    assert(
      Number(defaultModeStatus.reasoning_behavior.summary?.total_samples) >= 8,
      `reasoning 行为样本总数不正确: ${JSON.stringify(defaultModeStatus.reasoning_behavior.summary)}`,
    );
    assert(
      defaultModeStatus.reasoning_behavior.summary?.commentary_observed_ratio ===
        defaultModeStatus.reasoning_behavior.summary?.commentary_present_ratio,
      "status reasoning_behavior summary 缺少 commentary_observed_ratio 兼容别名",
    );
    assert(
      Array.isArray(
        defaultModeStatus.reasoning_behavior.top_reasoning_tokens,
      ) &&
        defaultModeStatus.reasoning_behavior.top_reasoning_tokens.some(
          (entry) => entry.value === 516,
        ),
      "reasoning 高频 token 排行榜缺少 516",
    );
    assert(
      Array.isArray(defaultModeStatus.reasoning_behavior.by_model_family) &&
        defaultModeStatus.reasoning_behavior.by_model_family.some(
          (entry) =>
            (entry.model_family === "gpt-5.4" ||
              entry.model_family === "gpt-5.5") &&
            entry.commentary_observed_ratio === entry.commentary_present_ratio,
        ),
      "status 接口未返回按模型家族聚合",
    );
    assert(
      Array.isArray(defaultModeStatus.reasoning_behavior.by_reasoning_effort) &&
        defaultModeStatus.reasoning_behavior.by_reasoning_effort.some(
          (entry) =>
            (entry.reasoning_effort === "high" ||
              entry.reasoning_effort === "medium") &&
            entry.commentary_observed_ratio === entry.commentary_present_ratio,
        ),
      "status 接口未返回按思考等级聚合",
    );
    assert(
      Array.isArray(
        defaultModeStatus.reasoning_behavior.by_model_family_and_effort,
      ) &&
        defaultModeStatus.reasoning_behavior.by_model_family_and_effort.some(
          (entry) =>
            entry.model_family === "gpt-5.4" ||
            entry.model_family === "gpt-5.5" ||
            entry.group_key === "gpt-5.5|high",
        ),
      "status 接口未返回按模型家族+思考等级聚合",
    );
    const directAnalytics = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning`,
    ).then((response) => response.json());
    assert(
      directAnalytics.schema_version === 3 &&
        directAnalytics.analytics_ready === true,
      "独立 reasoning analytics 接口缺少 schema_version 或 analytics_ready",
    );
    assert(
      Number(directAnalytics.summary?.total_samples) >= 8,
      "独立 reasoning analytics 接口未返回样本统计",
    );
    assert(
      directAnalytics.summary?.commentary_observed_ratio ===
        directAnalytics.summary?.commentary_present_ratio,
      "独立 reasoning analytics 接口缺少 commentary_observed_ratio",
    );
    assert(
      Array.isArray(directAnalytics.by_reasoning_token) &&
        directAnalytics.by_reasoning_token.some(
          (entry) =>
            Number.isFinite(Number(entry.commentary_observed_ratio)) &&
            entry.commentary_observed_ratio === entry.commentary_present_ratio,
        ),
      "独立 reasoning analytics 接口 by_reasoning_token 缺少 commentary_observed_ratio",
    );
    assert(
      Array.isArray(directAnalytics.candidate_patterns) &&
        directAnalytics.candidate_patterns.every(
          (entry) => !`${entry.pattern_key || ""}`.includes("commentary_absent"),
        ) &&
        (directAnalytics.candidate_patterns.length === 0 ||
          directAnalytics.candidate_patterns.some((entry) =>
            `${entry.pattern_key || ""}`.includes("commentary_not_observed"),
          )),
      "独立 reasoning analytics 候选特征应使用 commentary_not_observed 口径",
    );
    assert(
      Array.isArray(directAnalytics.by_model_family) &&
        directAnalytics.by_model_family.some(
          (entry) => entry.model_family === "gpt-5.5",
        ),
      "独立 reasoning analytics 接口未返回 gpt-5.5 family 聚合",
    );
    assert(
      Array.isArray(directAnalytics.by_reasoning_effort) &&
        directAnalytics.by_reasoning_effort.some(
          (entry) => entry.reasoning_effort === "high",
        ),
      "独立 reasoning analytics 接口未返回 high effort 聚合",
    );
    const reasoningAnalyzeResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning/analyze`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          filters: {
            include_retries: true,
            include_blocked: true,
          },
          conditions: {
            reasoning_tokens: [516],
            final_answer_only: true,
            commentary_not_observed: true,
            time_normalization_deviation: "high",
          },
        }),
      },
    );
    const reasoningAnalyzePayload = await reasoningAnalyzeResponse.json();
    assert(
      reasoningAnalyzeResponse.status === 200,
      `reasoning 特征分析接口失败: ${reasoningAnalyzeResponse.status}`,
    );
    assert(
      reasoningAnalyzePayload.analysis_profile === "516_candidate_review_v1",
      `reasoning 特征分析 profile 不正确: ${JSON.stringify(reasoningAnalyzePayload)}`,
    );
    assert(
      reasoningAnalyzePayload.analysis_value === "valuable",
      `reasoning 特征分析应有分析价值: ${JSON.stringify(reasoningAnalyzePayload)}`,
    );
    assert(
      reasoningAnalyzePayload.field_coverage?.reasoning_tokens > 0 &&
        reasoningAnalyzePayload.field_coverage?.final_answer_only > 0 &&
        reasoningAnalyzePayload.field_coverage?.commentary_observed > 0,
      "reasoning 特征分析缺少核心字段覆盖率",
    );
    assert(
      Number(reasoningAnalyzePayload.candidate_summary?.candidate_count || 0) > 0,
      `reasoning 特征分析未定位候选样本: ${JSON.stringify(reasoningAnalyzePayload.candidate_summary)}`,
    );
    assert(
      [
        "candidate",
        "strong_candidate",
        "high_false_positive_risk",
      ].includes(reasoningAnalyzePayload.conclusion),
      `reasoning 特征分析结论等级不正确: ${reasoningAnalyzePayload.conclusion}`,
    );
    const reasoningItemResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.5",
          reasoning: { effort: "high" },
          messages: [{ role: "user", content: "reasoning item sample" }],
          test_reasoning_tokens: 128,
          test_include_reasoning_item: true,
        }),
      },
    );
    assert(
      reasoningItemResponse.status === 200,
      `带 reasoning item 的响应应正常透传: ${reasoningItemResponse.status}`,
    );
    const historicalFixtures = await createHistoricalImportFixtures(tempRoot);
    const importRunResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/imports/run`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source_paths: {
            cc_switch_db: historicalFixtures.ccSwitchDbPath,
            codex_logs_db: historicalFixtures.codexLogsDbPath,
            codex_sessions_root: historicalFixtures.sessionsRoot,
          },
        }),
      },
    );
    const importRunPayload = await importRunResponse.json();
    assert(
      importRunResponse.status === 202,
      `历史导入分析应创建后台任务: ${importRunResponse.status}`,
    );
    assert(
      importRunPayload.import_job?.job_id,
      `历史导入分析缺少任务信息: ${JSON.stringify(importRunPayload)}`,
    );
    const importJobId = importRunPayload.import_job.job_id;
    let importJob = importRunPayload.import_job;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (importJob.status === "completed") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      const importJobResponse = await fetch(
        `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/imports/jobs/${encodeURIComponent(importJobId)}`,
      );
      assert(
        importJobResponse.status === 200,
        `历史导入任务查询失败: ${importJobResponse.status}`,
      );
      const importJobPayload = await importJobResponse.json();
      importJob = importJobPayload.import_job;
    }
    assert(
      importJob.status === "completed",
      `历史导入分析任务未完成: ${JSON.stringify(importJob)}`,
    );
    assert(
      importJob.summary?.total_requests === 2,
      `历史导入 CC Switch 请求总数不正确: ${JSON.stringify(importJob.summary)}`,
    );
    assert(
      importJob.summary?.failed_requests === 1,
      `历史导入失败请求数不正确: ${JSON.stringify(importJob.summary)}`,
    );
    assert(
      importJob.summary?.codex_log_rows === 2,
      `历史导入 Codex 日志行数不正确: ${JSON.stringify(importJob.summary)}`,
    );
    assert(
      importJob.preflight?.analysis_value === "no_analysis_value",
      `历史导入缺核心字段时应标记无分析价值: ${JSON.stringify(importJob.preflight)}`,
    );
    assert(
      importJob.preflight?.missing_core_fields?.includes("reasoning_tokens") &&
        importJob.preflight?.missing_core_fields?.includes("final_answer_only") &&
        importJob.preflight?.missing_core_fields?.includes("commentary_observed"),
      `历史导入 preflight 缺少核心字段缺失列表: ${JSON.stringify(importJob.preflight)}`,
    );
    assert(
      importJob.feature_analysis?.conclusion === "no_analysis_value",
      `历史导入 feature_analysis 应停止在无价值结论: ${JSON.stringify(importJob.feature_analysis)}`,
    );
    const historicalAnalyzeResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/imports/analyze`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ job_id: importJobId }),
      },
    );
    const historicalAnalyzePayload = await historicalAnalyzeResponse.json();
    assert(
      historicalAnalyzeResponse.status === 200,
      `历史导入分析接口失败: ${historicalAnalyzeResponse.status}`,
    );
    assert(
      historicalAnalyzePayload.analysis_profile === "516_candidate_review_v1" &&
        historicalAnalyzePayload.analysis_value === "no_analysis_value" &&
        historicalAnalyzePayload.conclusion === "no_analysis_value",
      `历史导入分析接口应返回无分析价值: ${JSON.stringify(historicalAnalyzePayload)}`,
    );
    assert(
      historicalAnalyzePayload.field_coverage?.reasoning_tokens === 0,
      "历史导入分析接口应暴露缺失字段覆盖率",
    );
    const latestImportPayload = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/imports/latest`,
    ).then((response) => response.json());
    assert(
      latestImportPayload.import_job?.job_id === importJobId,
      "历史导入 latest 接口未返回最近任务",
    );
    const degradedAnalyticsResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning?date_from=2026-01-01&date_to=2026-03-15`,
    );
    const degradedAnalyticsPayload = await degradedAnalyticsResponse.json();
    assert(
      degradedAnalyticsResponse.status === 200,
      `大范围 reasoning analytics 查询应返回降级响应: ${degradedAnalyticsResponse.status}`,
    );
    assert(
      degradedAnalyticsPayload.degraded === true &&
        degradedAnalyticsPayload.degrade_reason === "date_range_too_large",
      `大范围 reasoning analytics 查询缺少降级信号: ${JSON.stringify(degradedAnalyticsPayload)}`,
    );
    assert(
      Array.isArray(degradedAnalyticsPayload.recent_samples) &&
        degradedAnalyticsPayload.recent_samples.length === 0,
      "大范围 reasoning analytics 降级响应不应全量返回明细样本",
    );
    const malformedRequestSecret = "malformed-request-encrypted-secret";
    const malformedRequestKey = "malformed-request-excerpt-redaction";
    const malformedRequestResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `{"test_sequence_key":"${malformedRequestKey}","encrypted_content":"${malformedRequestSecret}"`,
      },
    );
    assert(
      malformedRequestResponse.status >= 400,
      `畸形 JSON 请求应被拒绝或记录为错误: ${malformedRequestResponse.status}`,
    );
    const malformedRequestAnalytics = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning`,
    ).then((response) => response.json());
    const malformedRequestSample = (malformedRequestAnalytics.recent_samples || []).find((sample) =>
      `${sample.request_payload_excerpt || ""}`.includes(malformedRequestKey) ||
        sample.final_action === "gateway_error",
    );
    const malformedRequestExcerpt = `${malformedRequestSample?.request_payload_excerpt || ""}`;
    assert(
      malformedRequestSample &&
        !malformedRequestExcerpt.includes("encrypted_content") &&
        !malformedRequestExcerpt.includes(malformedRequestSecret),
      `畸形 JSON 请求摘要不应落盘 encrypted_content 字段或值: ${JSON.stringify(malformedRequestSample)}`,
    );
    const malformedRequestObjectSecret = "malformed-request-object-secret";
    const malformedRequestArraySecret = "malformed-request-array-secret";
    const malformedRequestObjectKey = "malformed-request-object-excerpt-redaction";
    const malformedRequestObjectResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `{"test_sequence_key":"${malformedRequestObjectKey}","encrypted_content":{"secret":"${malformedRequestObjectSecret}","items":["${malformedRequestArraySecret}"]`,
      },
    );
    assert(
      malformedRequestObjectResponse.status >= 400,
      `对象/数组值畸形 JSON 请求应被拒绝或记录为错误: ${malformedRequestObjectResponse.status}`,
    );
    const malformedObjectAnalytics = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning`,
    ).then((response) => response.json());
    const malformedObjectSample = (malformedObjectAnalytics.recent_samples || []).find((sample) =>
      `${sample.request_payload_excerpt || ""}`.includes(malformedRequestObjectKey),
    );
    const malformedObjectExcerpt = `${malformedObjectSample?.request_payload_excerpt || ""}`;
    assert(
      malformedObjectSample &&
        !malformedObjectExcerpt.includes("encrypted_content") &&
        !malformedObjectExcerpt.includes(malformedRequestObjectSecret) &&
        !malformedObjectExcerpt.includes(malformedRequestArraySecret),
      `对象/数组值畸形 JSON 请求摘要不应落盘 encrypted_content 字段或值: ${JSON.stringify(malformedObjectSample)}`,
    );
    const malformedRequestEscapedKeySecret = "malformed-request-escaped-key-secret";
    const malformedRequestEscapedKey = "malformed-request-escaped-key-redaction";
    const malformedRequestEscapedKeyResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `{"test_sequence_key":"${malformedRequestEscapedKey}","\\u0065ncrypted_content":"${malformedRequestEscapedKeySecret}"`,
      },
    );
    assert(
      malformedRequestEscapedKeyResponse.status >= 400,
      `escaped-letter key 畸形 JSON 请求应被拒绝或记录为错误: ${malformedRequestEscapedKeyResponse.status}`,
    );
    const malformedEscapedKeyAnalytics = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning`,
    ).then((response) => response.json());
    const malformedEscapedKeySample = (malformedEscapedKeyAnalytics.recent_samples || []).find((sample) =>
      `${sample.request_payload_excerpt || ""}`.includes(malformedRequestEscapedKey),
    );
    const malformedEscapedKeyExcerpt = `${malformedEscapedKeySample?.request_payload_excerpt || ""}`;
    assert(
      malformedEscapedKeySample &&
        !malformedEscapedKeyExcerpt.includes("encrypted_content") &&
        !malformedEscapedKeyExcerpt.includes("\\u0065ncrypted_content") &&
        !malformedEscapedKeyExcerpt.includes(malformedRequestEscapedKeySecret),
      `escaped-letter key 畸形 JSON 请求摘要不应落盘 encrypted_content 字段或值: ${JSON.stringify(malformedEscapedKeySample)}`,
    );
    const malformedRequestUnquotedSecret = "malformed-request-unquoted-secret";
    const malformedRequestUnquotedKey = "malformed-request-unquoted-redaction";
    const malformedRequestUnquotedResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `{"test_sequence_key":"${malformedRequestUnquotedKey}","encrypted_content":${malformedRequestUnquotedSecret}`,
      },
    );
    assert(
      malformedRequestUnquotedResponse.status >= 400,
      `未加引号值畸形 JSON 请求应被拒绝或记录为错误: ${malformedRequestUnquotedResponse.status}`,
    );
    const malformedUnquotedAnalytics = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning`,
    ).then((response) => response.json());
    const malformedUnquotedSample = (malformedUnquotedAnalytics.recent_samples || []).find((sample) =>
      `${sample.request_payload_excerpt || ""}`.includes(malformedRequestUnquotedKey),
    );
    const malformedUnquotedExcerpt = `${malformedUnquotedSample?.request_payload_excerpt || ""}`;
    assert(
      malformedUnquotedSample &&
        !malformedUnquotedExcerpt.includes("encrypted_content") &&
        !malformedUnquotedExcerpt.includes(malformedRequestUnquotedSecret),
      `未加引号值畸形 JSON 请求摘要不应落盘 encrypted_content 字段或值: ${JSON.stringify(malformedUnquotedSample)}`,
    );
    const malformedRequestSecrets = [
      malformedRequestSecret,
      malformedRequestObjectSecret,
      malformedRequestArraySecret,
      malformedRequestEscapedKeySecret,
      malformedRequestUnquotedSecret,
    ];
    const malformedRequestKeys = [
      malformedRequestKey,
      malformedRequestObjectKey,
      malformedRequestEscapedKey,
      malformedRequestUnquotedKey,
    ];
    const exportJsonResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning/export?format=json`,
    );
    const exportJsonPayload = await exportJsonResponse.json();
    assert(
      exportJsonResponse.status === 200,
      `reasoning JSON 导出失败: ${exportJsonResponse.status}`,
    );
    assert(
      exportJsonPayload.analytics_ready === true,
      "reasoning JSON 导出缺少 analytics_ready",
    );
    assert(
      Array.isArray(exportJsonPayload.samples) &&
        exportJsonPayload.samples.length >= 8,
      "reasoning JSON 导出未包含样本",
    );
    const exportJsonText = JSON.stringify(exportJsonPayload);
    assertTextContainsAll(exportJsonText, "reasoning JSON 导出", malformedRequestKeys);
    assertTextDoesNotLeakEncryptedContent(exportJsonText, "reasoning JSON 导出", malformedRequestSecrets);
    assert(
      Array.isArray(exportJsonPayload.by_model_family) &&
        exportJsonPayload.by_model_family.some(
          (entry) =>
            entry.model_family === "gpt-5.4" &&
            entry.commentary_observed_ratio === entry.commentary_present_ratio,
        ),
      "reasoning JSON 导出未包含按模型家族聚合",
    );
    assert(
      Array.isArray(exportJsonPayload.by_reasoning_effort) &&
        exportJsonPayload.by_reasoning_effort.some(
          (entry) =>
            entry.reasoning_effort === "medium" &&
            entry.commentary_observed_ratio === entry.commentary_present_ratio,
        ),
      "reasoning JSON 导出未包含按思考等级聚合",
    );
    assert(
      Array.isArray(exportJsonPayload.by_model_family_and_effort) &&
        exportJsonPayload.by_model_family_and_effort.some(
          (entry) => entry.group_key,
        ),
      "reasoning JSON 导出未包含按模型家族+思考等级聚合",
    );
    const backgroundExportEndDate = formatLocalDateKey(new Date());
    const backgroundExportStartDate = formatLocalDateKey(addLocalDays(new Date(), -40));
    const backgroundExportResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning/export?format=json&date_from=${backgroundExportStartDate}&date_to=${backgroundExportEndDate}`,
    );
    const backgroundExportPayload = await backgroundExportResponse.json();
    assert(
      backgroundExportResponse.status === 202,
      `大范围 reasoning JSON 导出应创建后台任务: ${backgroundExportResponse.status}`,
    );
    assert(
      backgroundExportPayload?.export_job?.job_id &&
        backgroundExportPayload.export_job.status,
      `大范围 reasoning JSON 导出缺少后台任务信息: ${JSON.stringify(backgroundExportPayload)}`,
    );
    const exportJobId = backgroundExportPayload.export_job.job_id;
    let exportJobStatus = backgroundExportPayload.export_job;
    for (let pollIndex = 0; pollIndex < 20; pollIndex += 1) {
      if (exportJobStatus.status === "completed") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      const pollResponse = await fetch(
        `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning/export/jobs/${encodeURIComponent(exportJobId)}`,
      );
      assert(
        pollResponse.status === 200,
        `后台 reasoning 导出任务状态查询失败: ${pollResponse.status}`,
      );
      const pollPayload = await pollResponse.json();
      exportJobStatus = pollPayload.export_job;
    }
    assert(
      exportJobStatus.status === "completed",
      `后台 reasoning 导出任务未完成: ${JSON.stringify(exportJobStatus)}`,
    );
    assert(
      exportJobStatus.progress?.processed_days === exportJobStatus.progress?.total_days,
      `后台 reasoning 导出进度不正确: ${JSON.stringify(exportJobStatus.progress)}`,
    );
    assert(
      exportJobStatus.download_url &&
        exportJobStatus.download_url.includes("/api/analytics/reasoning/export/jobs/"),
      `后台 reasoning 导出缺少下载链接: ${JSON.stringify(exportJobStatus)}`,
    );
    const backgroundDownloadResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}${exportJobStatus.download_url}`,
    );
    assert(
      backgroundDownloadResponse.status === 200,
      `后台 reasoning 导出下载失败: ${backgroundDownloadResponse.status}`,
    );
    const backgroundDownloadText = await backgroundDownloadResponse.text();
    const backgroundDownloadPayload = JSON.parse(backgroundDownloadText);
    assert(
      Array.isArray(backgroundDownloadPayload.samples) &&
        backgroundDownloadPayload.samples.length >= malformedRequestKeys.length,
      `后台 reasoning 导出应覆盖当前日期样本，不能空测: ${backgroundDownloadText}`,
    );
    assertTextContainsAll(backgroundDownloadText, "后台 reasoning 导出下载", malformedRequestKeys);
    assertTextDoesNotLeakEncryptedContent(backgroundDownloadText, "后台 reasoning 导出下载", malformedRequestSecrets);
    const blockedReasoningSample = exportJsonPayload.samples.find(
      (sample) =>
        sample.blocked_by_gateway &&
        sample.request_reasoning_effort &&
        sample.final_action === "blocked",
    );
    assert(
      blockedReasoningSample,
      "reasoning 导出缺少被拦截且带思考等级的样本",
    );
    assert(
      blockedReasoningSample?.request_summary?.body_bytes >= 0 &&
        typeof blockedReasoningSample?.request_summary?.body_sha256 ===
          "string",
      "reasoning 导出样本缺少请求摘要",
    );
    assert(
      typeof blockedReasoningSample?.request_payload_excerpt === "string" &&
        blockedReasoningSample.request_payload_excerpt.includes(
          "blocked sample",
        ),
      "reasoning 导出样本缺少请求体摘要",
    );
    assert(
      blockedReasoningSample?.client_http_status === 502,
      "被拦截样本应记录客户端状态 502",
    );
    assert(
      blockedReasoningSample?.commentary_observed ===
        blockedReasoningSample?.has_commentary,
      "reasoning JSON 导出样本缺少 commentary_observed 采集别名",
    );
    const failedReasoningSample = exportJsonPayload.samples.find(
      (sample) => sample.final_action === "upstream_fetch_failed",
    );
    assert(failedReasoningSample, "reasoning 导出缺少上游失败样本");
    assert(
      failedReasoningSample?.failure_summary?.code ===
        "upstream_fetch_failed" ||
        failedReasoningSample?.failure_summary?.message,
      "上游失败样本缺少失败摘要",
    );
    const sampleWithReasoningItem = exportJsonPayload.samples.find(
      (sample) => sample.has_reasoning_item && sample.has_final_answer,
    );
    assert(
      sampleWithReasoningItem,
      "reasoning 导出缺少同时包含 reasoning item 与最终答案的样本",
    );
    assert(
      sampleWithReasoningItem.final_answer_only === false,
      "带 reasoning item 的响应不应判定为 final_answer_only",
    );
    const exportCsvResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning/export?format=csv`,
    );
    const exportCsvText = await exportCsvResponse.text();
    assert(
      exportCsvResponse.status === 200,
      `reasoning CSV 导出失败: ${exportCsvResponse.status}`,
    );
    assert(
      exportCsvText.includes("sample_id") &&
        exportCsvText.includes("gateway_request_id") &&
        exportCsvText.includes("request_reasoning_effort") &&
        exportCsvText.includes("commentary_observed") &&
        exportCsvText.includes("client_http_status"),
      "reasoning CSV 导出缺少表头",
    );
    assertTextContainsAll(exportCsvText, "reasoning CSV 导出", malformedRequestKeys);
    assertTextDoesNotLeakEncryptedContent(exportCsvText, "reasoning CSV 导出", malformedRequestSecrets);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const analyticsFiles = await readdir(path.join(tempRoot, "analytics"));
    assert(
      analyticsFiles.some(
        (name) =>
          name.startsWith("reasoning-behavior-") && name.endsWith(".json"),
      ),
      `未生成 reasoning analytics 日文件: ${JSON.stringify(analyticsFiles)}`,
    );
    const dayFilePath = path.join(
      tempRoot,
      "analytics",
      analyticsFiles.find(
        (name) =>
          name.startsWith("reasoning-behavior-") && name.endsWith(".json"),
      ),
    );
    const dayFilePayload = JSON.parse(await readFile(dayFilePath, "utf8"));
    const dayFileText = JSON.stringify(dayFilePayload);
    assertTextContainsAll(dayFileText, "reasoning 日文件", malformedRequestKeys);
    assertTextDoesNotLeakEncryptedContent(dayFileText, "reasoning 日文件", malformedRequestSecrets);
    assert(
      dayFilePayload.schema_version === 3,
      "reasoning 日文件 schema_version 未升级",
    );
    assert(
      Array.isArray(dayFilePayload.samples) &&
        dayFilePayload.samples.some((sample) => sample.gateway_request_id),
      "reasoning 日文件样本缺少 gateway_request_id",
    );
    assert(
      Array.isArray(dayFilePayload.samples) &&
        dayFilePayload.samples.some(
          (sample) => sample.final_action === "request_rejected",
        ),
      "reasoning 日文件缺少请求体超限样本",
    );

    const invalidInterceptConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_streaming: false,
          intercept_non_streaming: false,
        }),
      },
    );
    const invalidInterceptConfigPayload =
      await invalidInterceptConfigResponse.json();
    assert(
      invalidInterceptConfigResponse.status === 400,
      `流式与非流式都关闭时后端应拒绝: ${invalidInterceptConfigResponse.status}`,
    );
    assert(
      `${invalidInterceptConfigPayload?.error?.message || ""}`.includes(
        "流式与非流式至少选择一个",
      ),
      "流式与非流式都关闭时后端应返回拦截目标校验错误",
    );

    const streamOnlyConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_streaming: true,
          intercept_non_streaming: false,
        }),
      },
    );
    assert(
      streamOnlyConfigResponse.status === 200,
      `切换仅流式拦截失败: ${streamOnlyConfigResponse.status}`,
    );
    const nonBlockedNonStreamKey = "non-stream-observe-only-forwarding-telemetry";
    const nonBlockedNonStreamResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.4",
          test_response_model: "gpt-5.4",
          test_reasoning_tokens: 516,
          test_sequence_key: nonBlockedNonStreamKey,
        }),
      },
    );
    const nonBlockedNonStreamBody = await nonBlockedNonStreamResponse.json();
    assert(
      nonBlockedNonStreamResponse.status === 200,
      `仅流式模式下非流式命中应透传: ${nonBlockedNonStreamResponse.status}`,
    );
    assert(
      nonBlockedNonStreamBody?.usage?.output_tokens_details
        ?.reasoning_tokens === 516,
      "仅流式模式下非流式命中透传体不正确",
    );
    const nonBlockedNonStreamAnalytics = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning`,
    ).then((response) => response.json());
    const nonBlockedNonStreamSample = (
      nonBlockedNonStreamAnalytics.recent_samples || []
    ).find((sample) =>
      `${sample.request_payload_excerpt || ""}`.includes(nonBlockedNonStreamKey),
    );
    assert(
      nonBlockedNonStreamSample?.final_action === "observe_only" &&
        Number.isFinite(nonBlockedNonStreamSample?.client_headers_sent_at_ms) &&
        Number.isFinite(nonBlockedNonStreamSample?.client_first_write_at_ms) &&
        Number.isFinite(nonBlockedNonStreamSample?.time_to_client_first_write_ms) &&
        nonBlockedNonStreamSample?.response_forwarding_started === true,
      `非流式 observe-only 样本必须在实际透传后落盘: ${JSON.stringify(nonBlockedNonStreamSample)}`,
    );
    const statusAfterStreamOnlyNonStream = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      statusAfterStreamOnlyNonStream.metrics.matched_non_streaming_count === 13,
      `仅流式模式下非流式命中仍应计数: ${statusAfterStreamOnlyNonStream.metrics.matched_non_streaming_count}`,
    );
    assert(
      statusAfterStreamOnlyNonStream.metrics.blocked_non_streaming_count === 12,
      `仅流式模式下非流式透传不应增加拦截数: ${statusAfterStreamOnlyNonStream.metrics.blocked_non_streaming_count}`,
    );
    assert(
      statusAfterStreamOnlyNonStream.model_insights.consistency?.matched >= 1,
      "仅流式模式下非流式命中透传仍应进入模型一致性收口",
    );

    const nonStreamOnlyConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_streaming: false,
          intercept_non_streaming: true,
        }),
      },
    );
    assert(
      nonStreamOnlyConfigResponse.status === 200,
      `切换仅非流式拦截失败: ${nonStreamOnlyConfigResponse.status}`,
    );
    const observedOnlyStream = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        model: "gpt-5.4",
        stream: true,
        test_reasoning_tokens: 516,
        test_stream_models: ["gpt-5.4", "gpt-5.4"],
        test_stream_fingerprints: ["fp_same_observe", "fp_same_observe"],
        test_response_ids: ["resp_same_observe", "resp_same_observe"],
      },
    );
    assert(
      observedOnlyStream.status === 200,
      `仅非流式模式下流式命中应透传: ${observedOnlyStream.status}`,
    );
    assert(
      observedOnlyStream.text.includes("hello"),
      "仅非流式模式下流式命中应保留正常 chunk",
    );
    assert(
      observedOnlyStream.text.includes("[DONE]"),
      "仅非流式模式下流式命中应完整结束",
    );
    assert(
      !observedOnlyStream.closedByError,
      "仅非流式模式下流式命中不应异常断开",
    );
    const statusAfterObservedOnlyStream = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      statusAfterObservedOnlyStream.metrics.matched_streaming_count === 1,
      `仅非流式模式下流式命中仍应计数: ${statusAfterObservedOnlyStream.metrics.matched_streaming_count}`,
    );
    assert(
      statusAfterObservedOnlyStream.metrics.blocked_streaming_count === 0,
      `仅非流式模式下流式透传不应增加流式拦截数: ${statusAfterObservedOnlyStream.metrics.blocked_streaming_count}`,
    );
    assert(
      !statusAfterObservedOnlyStream.model_insights.suspicious_samples?.some(
        (sample) =>
          sample.path === "/responses" &&
          sample.anomaly_type === "single_request_rebuild_suspected",
      ),
      "仅非流式模式下正常观察流式 516 不应生成 single_request_rebuild_suspected 可疑样本",
    );

    const noneModeKey = "none-direct-stream-516";
    const noneModeSecret = "none-mode-encrypted-reasoning";
    const noneModeMetricsBefore = statusAfterObservedOnlyStream.metrics;
    const noneModeConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_rule_mode: "none",
          stream_action: "continuation_recovery",
          guard_retry_attempts: 3,
        }),
      },
    );
    assert(
      noneModeConfigResponse.status === 200,
      `切换不使用 reasoning 规则失败: ${noneModeConfigResponse.status}`,
    );
    const noneModeStream = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        model: "gpt-5.6-sol",
        stream: true,
        include: ["reasoning.encrypted_content"],
        input: "none mode direct stream",
        test_sequence_key: noneModeKey,
        test_reasoning_tokens: 516,
        test_stream_reasoning_encrypted_content: noneModeSecret,
        test_stream_text: "none-mode-visible-output",
        test_stream_chunk_delay_ms: 10,
        test_stream_pause_after_output_ms: 600,
      },
    );
    assert(noneModeStream.status === 200, `none 流式透传失败: ${noneModeStream.status}`);
    assert(
      Number.isFinite(noneModeStream.firstChunkAtMs) &&
        noneModeStream.completedAtMs - noneModeStream.firstChunkAtMs >= 400,
      `none 模式仍在等待完整 SSE 后才向客户端写入: ${JSON.stringify({
        firstChunkAtMs: noneModeStream.firstChunkAtMs,
        completedAtMs: noneModeStream.completedAtMs,
      })}`,
    );
    assert(
      noneModeStream.text.includes("none-mode-visible-output") &&
        noneModeStream.text.includes("encrypted_content") &&
        noneModeStream.text.includes(noneModeSecret),
      `none 模式应原样保留可见输出与 encrypted reasoning: ${noneModeStream.text}`,
    );
    const noneModeRequests = upstream.responseRequests.filter(
      (entry) => entry.body?.test_sequence_key === noneModeKey,
    );
    assert(
      noneModeRequests.length === 1 &&
        noneModeRequests[0].body?.include?.includes("reasoning.encrypted_content"),
      `none 模式不应触发续写或改写 include: ${JSON.stringify(noneModeRequests)}`,
    );
    const noneModeStatus = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      noneModeStatus.metrics.matched_response_count === noneModeMetricsBefore.matched_response_count &&
        noneModeStatus.metrics.continuation_recovery_count ===
          noneModeMetricsBefore.continuation_recovery_count,
      "none 模式不应增加 reasoning 命中或续写次数",
    );
    const noneModeAnalytics = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning`,
    ).then((response) => response.json());
    const noneModeSample = (noneModeAnalytics.recent_samples || []).find((sample) =>
      `${sample.request_payload_excerpt || ""}`.includes(noneModeKey),
    );
    assert(
      noneModeSample?.final_action === "passed" &&
        noneModeSample?.matched_current_rule === false &&
        noneModeSample?.blocked_by_gateway === false &&
        Number.isFinite(noneModeSample?.time_to_first_progress_ms) &&
        noneModeSample?.response_forwarding_started === true &&
        Number.isFinite(noneModeSample?.client_first_write_at_ms),
      `none 模式未完整采集直接透传与首个有效输出时序: ${JSON.stringify(noneModeSample)}`,
    );
    const restoreStreamActionAfterNoneResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stream_action: statusAfterObservedOnlyStream.config?.stream_action,
        }),
      },
    );
    assert(
      restoreStreamActionAfterNoneResponse.status === 200,
      `none 用例后恢复 stream_action 失败: ${restoreStreamActionAfterNoneResponse.status}`,
    );

    const finalOnlyModeConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_rule_mode: "final_answer_only_high_xhigh",
          intercept_streaming: true,
          intercept_non_streaming: true,
          guard_retry_attempts: 0,
        }),
      },
    );
    assert(
      finalOnlyModeConfigResponse.status === 200,
      `切换 final answer only 拦截模式失败: ${finalOnlyModeConfigResponse.status}`,
    );
    const finalOnlyModeStatus = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      finalOnlyModeStatus.config?.intercept_rule_mode ===
        "final_answer_only_high_xhigh",
      "final answer only 拦截模式未在状态接口生效",
    );
    const finalOnlyModeLogs = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/logs`,
    ).then((response) => response.json());
    assert(
      finalOnlyModeLogs.entries.some((entry) =>
        `${entry.message || ""}`.includes(
          "[config] updated intercept_rule_mode=final_answer_only_high_xhigh",
        ),
      ),
      "保存 final answer only 模式后，配置日志应明确显示 intercept_rule_mode",
    );

    const finalOnlyHighZeroResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.5",
          reasoning: { effort: "high" },
          test_reasoning_tokens: 0,
          test_include_final_answer_only: true,
        }),
      },
    );
    assert(
      finalOnlyHighZeroResponse.status === 200,
      `普通 high final answer only reasoning_tokens=0 应放行观察: ${finalOnlyHighZeroResponse.status}`,
    );
    const finalOnlyHighNullResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.5",
          reasoning: { effort: "high" },
          test_omit_reasoning_tokens: true,
          test_include_final_answer_only: true,
        }),
      },
    );
    assert(
      finalOnlyHighNullResponse.status === 502,
      `high final answer only reasoning_tokens=null 仍应被拦截: ${finalOnlyHighNullResponse.status}`,
    );
    const finalOnlyHighPositiveResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.5",
          reasoning: { effort: "high" },
          test_reasoning_tokens: 85,
          test_include_final_answer_only: true,
        }),
      },
    );
    assert(
      finalOnlyHighPositiveResponse.status === 502,
      `high final answer only reasoning_tokens=85 仍应被拦截: ${finalOnlyHighPositiveResponse.status}`,
    );
    for (const effort of ["max", "ultra"]) {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: effort === "max" ? "gpt-5.6-sol" : "gpt-5.6-terra",
          reasoning: { effort },
          test_reasoning_tokens: 85,
          test_include_final_answer_only: true,
        }),
      });
      assert(
        response.status === 200,
        `${effort} 不属于 final_answer_only_high_xhigh，不能被实验规则拦截: ${response.status}`,
      );
    }
    const maxUltraFinalOnlyAnalytics = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning`,
    ).then((response) => response.json());
    for (const effort of ["max", "ultra"]) {
      assert(
        maxUltraFinalOnlyAnalytics.recent_samples?.some(
          (sample) => sample.request_reasoning_effort === effort && sample.final_action === "passed",
        ),
        `${effort} final answer only 放行样本未完整落入 analytics`,
      );
    }
    const compactionFinalOnlyZeroResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-codex-beta-features": "remote_compaction_v2",
          "x-codex-request-kind": "context_compaction",
        },
        body: JSON.stringify({
          model: "gpt-5.5",
          reasoning: { effort: "xhigh" },
          input: [{ role: "user", content: "compact the current conversation" }],
          test_reasoning_tokens: 0,
          test_include_final_answer_only: true,
        }),
      },
    );
    assert(
      compactionFinalOnlyZeroResponse.status === 200,
      `remote_compaction_v2 reasoning_tokens=0 不应被 final only 模式拦截: ${compactionFinalOnlyZeroResponse.status}`,
    );
    const compactionFinalOnlyNullResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-codex-beta-features": "remote_compaction_v2",
          "x-codex-request-kind": "context_compaction",
        },
        body: JSON.stringify({
          model: "gpt-5.5",
          reasoning: { effort: "xhigh" },
          input: [{ role: "user", content: "compact the current conversation" }],
          test_omit_reasoning_tokens: true,
          test_include_final_answer_only: true,
        }),
      },
    );
    assert(
      compactionFinalOnlyNullResponse.status === 200,
      `context_compaction reasoning_tokens=null 也必须原样透传: ${compactionFinalOnlyNullResponse.status}`,
    );
    const compactionFinalOnlyLowResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-codex-beta-features": "remote_compaction_v2",
          "x-codex-request-kind": "context_compaction",
        },
        body: JSON.stringify({
          model: "gpt-5.5",
          reasoning: { effort: "low" },
          input: [{ role: "user", content: "compact the current conversation" }],
          test_reasoning_tokens: 18,
          test_include_final_answer_only: true,
        }),
      },
    );
    assert(
      compactionFinalOnlyLowResponse.status === 200,
      `remote_compaction_v2 reasoning_tokens=18 不应被 final only 模式拦截: ${compactionFinalOnlyLowResponse.status}`,
    );
    const compactionReasoningRuleBypassKey = "context-compaction-516-bypass";
    const compactionReasoningRuleBypassResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-codex-beta-features": "remote_compaction_v2",
          "x-codex-request-kind": "context_compaction",
        },
        body: JSON.stringify({
          model: "gpt-5.5",
          reasoning: { effort: "xhigh" },
          input: [{ role: "user", content: "compact the current conversation" }],
          test_reasoning_tokens: 516,
          test_include_final_answer_only: true,
          test_sequence_key: compactionReasoningRuleBypassKey,
        }),
      },
    );
    assert(
      compactionReasoningRuleBypassResponse.status === 200,
      `context_compaction reasoning_tokens=516 必须原样透传唯一压缩输出: ${compactionReasoningRuleBypassResponse.status}`,
    );
    assert(
      upstream.responseRequests.filter(
        (entry) => entry.body?.test_sequence_key === compactionReasoningRuleBypassKey,
      ).length === 1,
      "context_compaction reasoning_tokens=516 不应触发内部重试或续写",
    );
    const metadataCompactionKey = "metadata-compaction-516-bypass";
    const metadataCompactionResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-codex-beta-features": "remote_compaction_v2",
          "x-codex-turn-metadata": JSON.stringify({
            request_kind: "compaction",
          }),
        },
        body: JSON.stringify({
          model: "gpt-5.5",
          reasoning: { effort: "xhigh" },
          input: [{ role: "user", content: "compact the current conversation" }],
          test_reasoning_tokens: 516,
          test_include_final_answer_only: true,
          test_sequence_key: metadataCompactionKey,
        }),
      },
    );
    assert(
      metadataCompactionResponse.status === 200,
      `x-codex-turn-metadata request_kind=compaction 必须透传唯一压缩输出: ${metadataCompactionResponse.status}`,
    );
    assert(
      upstream.responseRequests.filter(
        (entry) => entry.body?.test_sequence_key === metadataCompactionKey,
      ).length === 1,
      "request_kind=compaction 不应触发内部重试或本地拦截",
    );
    const compactionAnalytics = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning`,
    ).then((response) => response.json());
    const compactionSamples = (compactionAnalytics.recent_samples || []).filter(
      (sample) => sample.request_kind === "context_compaction",
    );
    assert(
      compactionSamples.length >= 4,
      `remote_compaction_v2 样本应以 context_compaction 落盘: ${JSON.stringify(compactionSamples)}`,
    );
    const compactionZeroSample = compactionSamples.find((sample) => sample.reasoning_tokens === 0);
    const compactionNullSample = compactionSamples.find((sample) => sample.reasoning_tokens === null);
    const compactionLowSample = compactionSamples.find((sample) => sample.reasoning_tokens === 18);
    const compactionReasoningRuleBypassSample = compactionSamples.find(
      (sample) =>
        sample.reasoning_tokens === 516 &&
        `${sample.request_payload_excerpt || ""}`.includes(compactionReasoningRuleBypassKey),
    );
    const metadataCompactionSample = compactionSamples.find(
      (sample) =>
        sample.reasoning_tokens === 516 &&
        `${sample.request_payload_excerpt || ""}`.includes(metadataCompactionKey),
    );
    assert(
      compactionZeroSample &&
        compactionNullSample &&
        compactionLowSample &&
        compactionReasoningRuleBypassSample &&
        metadataCompactionSample,
      `context_compaction 样本应覆盖 reasoning_tokens=0/null/18/516: ${JSON.stringify(compactionSamples)}`,
    );
    assert(
      compactionZeroSample.final_action === "passed" &&
        compactionZeroSample.client_http_status === 200 &&
        compactionZeroSample.matched_current_rule === false &&
        compactionZeroSample.blocked_by_gateway === false &&
        compactionZeroSample.intercept_exempt_reason === "context_compaction",
      `只有 reasoning_tokens=0 的 context_compaction 样本应标记豁免: ${JSON.stringify(compactionZeroSample)}`,
    );
    assert(
      compactionNullSample.final_action === "passed" &&
        compactionNullSample.matched_current_rule === false &&
        compactionNullSample.intercept_exempt_reason === "context_compaction",
      `reasoning_tokens=null 的 context_compaction 样本也必须豁免: ${JSON.stringify(compactionNullSample)}`,
    );
    assert(
      compactionLowSample.final_action === "passed" &&
        compactionLowSample.matched_current_rule === false &&
        compactionLowSample.intercept_exempt_reason === "context_compaction",
      `reasoning_tokens=18 的 context_compaction 样本必须标记压缩豁免: ${JSON.stringify(compactionLowSample)}`,
    );
    assert(
      compactionReasoningRuleBypassSample.final_action === "passed" &&
        compactionReasoningRuleBypassSample.matched_current_rule === false &&
        compactionReasoningRuleBypassSample.blocked_by_gateway === false &&
        compactionReasoningRuleBypassSample.intercept_exempt_reason === "context_compaction",
      `reasoning_tokens=516 的 context_compaction 样本必须完整豁免: ${JSON.stringify(compactionReasoningRuleBypassSample)}`,
    );
    assert(
      metadataCompactionSample.final_action === "passed" &&
        metadataCompactionSample.client_http_status === 200 &&
        metadataCompactionSample.matched_current_rule === false &&
        metadataCompactionSample.blocked_by_gateway === false &&
        metadataCompactionSample.intercept_exempt_reason === "context_compaction",
      `request_kind=compaction 样本必须标记压缩豁免: ${JSON.stringify(metadataCompactionSample)}`,
    );

    const compactionEncryptedKey = "metadata-compaction-encrypted-preservation";
    const compactionEncryptedSecret = "compaction-encrypted-content-must-survive";
    const compactionEncryptedConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stream_action: "continuation_recovery" }),
      },
    );
    assert(
      compactionEncryptedConfigResponse.status === 200,
      `压缩协议清洗回归测试切换 continuation_recovery 失败: ${compactionEncryptedConfigResponse.status}`,
    );
    const compactionEncryptedResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        model: "gpt-5.5",
        reasoning: { effort: "xhigh" },
        stream: true,
        input: [{ role: "user", content: "compact the current conversation" }],
        test_sequence_key: compactionEncryptedKey,
        test_reasoning_sequence: [0],
        test_stream_text: "",
        test_include_stream_compaction_item: true,
        test_stream_compaction_encrypted_content: compactionEncryptedSecret,
      },
      {
        headers: {
          "x-codex-beta-features": "remote_compaction_v2",
          "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction" }),
        },
      },
    );
    assert(
      compactionEncryptedResponse.status === 200 &&
        compactionEncryptedResponse.text.includes("encrypted_content") &&
        compactionEncryptedResponse.text.includes(compactionEncryptedSecret),
      `request_kind=compaction 必须原样保留唯一 compaction item: ${compactionEncryptedResponse.text}`,
    );
    const compactionEncryptedRestoreResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stream_action: "strict_502" }),
      },
    );
    assert(
      compactionEncryptedRestoreResponse.status === 200,
      `压缩协议清洗回归测试恢复 strict_502 失败: ${compactionEncryptedRestoreResponse.status}`,
    );
    const compactionExemptPattern = (compactionAnalytics.candidate_patterns || []).find(
      (entry) =>
        entry.pattern_key ===
        "reasoning=18|final_answer_only|commentary_not_observed",
    );
    assert(
      compactionExemptPattern?.status === "context_compaction_exempt",
      `context_compaction 候选组合应标记为压缩豁免: ${JSON.stringify(compactionExemptPattern)}`,
    );
    const finalOnlyHighStreamZeroResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.5",
          reasoning: { effort: "high" },
          stream: true,
          test_reasoning_tokens: 0,
          test_include_final_answer_only: true,
        }),
      },
    );
    assert(
      finalOnlyHighStreamZeroResponse.status === 200,
      `流式 high final answer only reasoning_tokens=0 应放行观察: ${finalOnlyHighStreamZeroResponse.status}`,
    );
    const finalOnlyHighStreamPositiveResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.5",
          reasoning: { effort: "high" },
          stream: true,
          test_reasoning_tokens: 85,
          test_include_final_answer_only: true,
        }),
      },
    );
    assert(
      finalOnlyHighStreamPositiveResponse.status === 502,
      `流式 high final answer only reasoning_tokens=85 仍应被拦截: ${finalOnlyHighStreamPositiveResponse.status}`,
    );
    const finalOnlyMediumResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.5",
          reasoning: { effort: "medium" },
          test_reasoning_tokens: 0,
          test_include_final_answer_only: true,
        }),
      },
    );
    assert(
      finalOnlyMediumResponse.status === 200,
      `medium final answer only 不应被 final only 模式拦截: ${finalOnlyMediumResponse.status}`,
    );
    const tokenOnlyResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.5",
          reasoning: { effort: "xhigh" },
          test_reasoning_tokens: 516,
          test_include_reasoning_item: true,
        }),
      },
    );
    assert(
      tokenOnlyResponse.status === 200,
      `final only 模式下 516 非 final_answer_only 不应被拦截: ${tokenOnlyResponse.status}`,
    );

    const bothModeConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_rule_mode: "reasoning_tokens",
          intercept_streaming: true,
          intercept_non_streaming: true,
          guard_retry_attempts: 3,
        }),
      },
    );
    assert(
      bothModeConfigResponse.status === 200,
      `恢复双开拦截失败: ${bothModeConfigResponse.status}`,
    );

    const zeroGuardRetryConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          guard_retry_attempts: 0,
        }),
      },
    );
    assert(
      zeroGuardRetryConfigResponse.status === 200,
      `guard_retry_attempts=0 应保存成功: ${zeroGuardRetryConfigResponse.status}`,
    );
    const zeroGuardRetryStatus = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      zeroGuardRetryStatus.config?.guard_retry_attempts === 0,
      "guard_retry_attempts=0 未在状态接口生效",
    );
    const zeroRetryKey = "non-stream-zero-retry-516";
    const zeroRetryResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          test_sequence_key: zeroRetryKey,
          test_reasoning_sequence: [516],
        }),
      },
    );
    const zeroRetryBody = await zeroRetryResponse.json();
    assert(
      zeroRetryResponse.status === 502,
      `guard_retry_attempts=0 命中规则应直接返回 502: ${zeroRetryResponse.status}`,
    );
    assert(
      zeroRetryBody?.error?.code === "reasoning_guard_triggered",
      "guard_retry_attempts=0 命中规则返回体不正确",
    );
    assert(
      upstream.responseRequests.filter(
        (entry) => entry.body?.test_sequence_key === zeroRetryKey,
      ).length === 1,
      "guard_retry_attempts=0 命中规则不应触发内部重试",
    );
    const zeroRetryLogs = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/logs`,
    ).then((response) => response.json());
    assert(
      zeroRetryLogs.entries.some((entry) =>
        `${entry.message || ""}`.includes(
          "[match] non-stream path=/responses reasoning_tokens=516 action=return_status_502",
        ),
      ),
      "guard_retry_attempts=0 命中规则日志应标记为 return_status_502",
    );
    const formulaModeConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reasoning_match_mode: "formula_518n_minus_2",
          guard_retry_attempts: 0,
        }),
      },
    );
    assert(
      formulaModeConfigResponse.status === 200,
      `518*n-2 规则模式应保存成功: ${formulaModeConfigResponse.status}`,
    );
    const formulaModeStatus = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      formulaModeStatus.config?.reasoning_match_mode === "formula_518n_minus_2",
      "518*n-2 规则模式未在状态接口生效",
    );
    const formulaModeKey = "non-stream-formula-2070";
    const formulaModeResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          test_sequence_key: formulaModeKey,
          test_reasoning_sequence: [2070],
        }),
      },
    );
    assert(
      formulaModeResponse.status === 502,
      `518*n-2 规则模式应命中 2070，而不是只命中默认三值: ${formulaModeResponse.status}`,
    );
    for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      for (const reasoningTokens of [516, 1034]) {
        const response = await fetch(`http://127.0.0.1:${gatewayPort}/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            reasoning: { effort: "ultra" },
            test_response_model: model,
            test_reasoning_tokens: reasoningTokens,
          }),
        });
        assert(
          response.status === 502,
          `${model} 的 ${reasoningTokens} 未沿用模型无关公式规则: ${response.status}`,
        );
      }
    }
    const manualModeRestoreResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reasoning_match_mode: "manual",
        }),
      },
    );
    assert(
      manualModeRestoreResponse.status === 200,
      `恢复手动 reasoning_equals 模式失败: ${manualModeRestoreResponse.status}`,
    );
    const negativeGuardRetryConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          guard_retry_attempts: -1,
        }),
      },
    );
    assert(
      negativeGuardRetryConfigResponse.status === 400,
      `guard_retry_attempts=-1 应被拒绝: ${negativeGuardRetryConfigResponse.status}`,
    );
    const invalidGuardRetryConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          guard_retry_attempts: "abc",
        }),
      },
    );
    assert(
      invalidGuardRetryConfigResponse.status === 400,
      `guard_retry_attempts=abc 应被拒绝: ${invalidGuardRetryConfigResponse.status}`,
    );
    const oneGuardRetryConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          guard_retry_attempts: 1,
        }),
      },
    );
    assert(
      oneGuardRetryConfigResponse.status === 200,
      `guard_retry_attempts=1 应保存成功: ${oneGuardRetryConfigResponse.status}`,
    );

    const statusBeforeGuardRetry = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    const nonStreamRetryKey = "non-stream-516-then-128";
    const nonStreamRetryResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.4",
          test_response_model: "gpt-5.4",
          test_sequence_key: nonStreamRetryKey,
          test_reasoning_sequence: [516, 128],
        }),
      },
    );
    const nonStreamRetryBody = await nonStreamRetryResponse.json();
    assert(
      nonStreamRetryResponse.status === 200,
      `非流式命中后应由网关内部重试恢复为 200: ${nonStreamRetryResponse.status}`,
    );
    assert(
      nonStreamRetryBody?.usage?.output_tokens_details?.reasoning_tokens ===
        128,
      "非流式命中后内部重试未返回第二次正常响应",
    );
    assert(
      upstream.responseRequests.filter(
        (entry) => entry.body?.test_sequence_key === nonStreamRetryKey,
      ).length === 2,
      "非流式命中后内部重试应向上游请求 2 次",
    );
    const nonStreamRetryLogs = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/logs`,
    ).then((response) => response.json());
    assert(
      nonStreamRetryLogs.entries.some((entry) =>
        `${entry.message || ""}`.includes(
          "[match] non-stream path=/responses reasoning_tokens=516 action=internal_retry remaining=1",
        ),
      ),
      "非流式内部重试日志应标记为 internal_retry",
    );
    const statusAfterNonStreamGuardRetry = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      statusAfterNonStreamGuardRetry.metrics.total_proxy_request_count ===
        statusBeforeGuardRetry.metrics.total_proxy_request_count + 2,
      "非流式内部重试应按每次上游尝试计入代理请求总数",
    );
    assert(
      statusAfterNonStreamGuardRetry.metrics.inspected_response_count ===
        statusBeforeGuardRetry.metrics.inspected_response_count + 2,
      "非流式内部重试应按每次响应计入被检查响应总数",
    );
    assert(
      statusAfterNonStreamGuardRetry.metrics.matched_response_count ===
        statusBeforeGuardRetry.metrics.matched_response_count + 1,
      "非流式内部重试首次命中应计入当前规则命中总数",
    );
    assert(
      statusAfterNonStreamGuardRetry.metrics.blocked_response_count ===
        statusBeforeGuardRetry.metrics.blocked_response_count + 1,
      "非流式内部重试首次吞掉响应应计入实际拦截总数",
    );
    assert(
      statusAfterNonStreamGuardRetry.metrics.matched_non_streaming_count ===
        statusBeforeGuardRetry.metrics.matched_non_streaming_count + 1,
      "非流式内部重试首次命中应计入非流式命中次数",
    );
    assert(
      statusAfterNonStreamGuardRetry.metrics.blocked_non_streaming_count ===
        statusBeforeGuardRetry.metrics.blocked_non_streaming_count + 1,
      "非流式内部重试首次吞掉响应应计入非流式拦截次数",
    );

    const statusBeforeBetaTurnRetry = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    const betaTurnRetryKey = "non-stream-beta-turn-516-then-128";
    const betaTurnRetryResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-codex-beta-features": "remote_compaction_v2",
          "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn" }),
        },
        body: JSON.stringify({
          model: "gpt-5.5",
          reasoning: { effort: "xhigh" },
          test_sequence_key: betaTurnRetryKey,
          test_reasoning_sequence: [516, 128],
          test_include_reasoning_item: true,
        }),
      },
    );
    const betaTurnRetryBody = await betaTurnRetryResponse.json();
    assert(
      betaTurnRetryResponse.status === 200,
      `remote_compaction_v2 普通 turn 命中 516 后应内部重试恢复为 200: ${betaTurnRetryResponse.status}`,
    );
    assert(
      betaTurnRetryBody?.usage?.output_tokens_details?.reasoning_tokens === 128,
      "remote_compaction_v2 普通 turn 内部重试未返回第二次正常响应",
    );
    assert(
      upstream.responseRequests.filter(
        (entry) => entry.body?.test_sequence_key === betaTurnRetryKey,
      ).length === 2,
      "remote_compaction_v2 普通 turn 命中 516 后应向上游请求 2 次",
    );
    const statusAfterBetaTurnRetry = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      statusAfterBetaTurnRetry.metrics.matched_response_count ===
        statusBeforeBetaTurnRetry.metrics.matched_response_count + 1 &&
        statusAfterBetaTurnRetry.metrics.blocked_response_count ===
          statusBeforeBetaTurnRetry.metrics.blocked_response_count + 1,
      "remote_compaction_v2 普通 turn 命中 516 应计入一次命中和一次内部拦截",
    );
    const betaTurnAnalytics = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning`,
    ).then((response) => response.json());
    const betaTurnBlockedSample = (betaTurnAnalytics.recent_samples || []).find(
      (sample) =>
        sample.reasoning_tokens === 516 &&
        `${sample.request_payload_excerpt || ""}`.includes(betaTurnRetryKey),
    );
    assert(
      betaTurnBlockedSample?.request_kind === "normal" &&
        betaTurnBlockedSample?.matched_current_rule === true &&
        betaTurnBlockedSample?.blocked_by_gateway === true &&
        betaTurnBlockedSample?.final_action === "internal_retry" &&
        betaTurnBlockedSample?.intercept_exempt_reason !== "context_compaction",
      `remote_compaction_v2 普通 turn 不应被误判为 context_compaction: ${JSON.stringify(betaTurnBlockedSample)}`,
    );

    const upstreamErrorKey = "real-upstream-429";
    const upstreamErrorResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          test_sequence_key: upstreamErrorKey,
          test_error_status: 429,
          test_error_payload: {
            error: {
              type: "rate_limit_error",
              message: "too many requests",
            },
          },
        }),
      },
    );
    const upstreamErrorBody = await upstreamErrorResponse.json();
    assert(
      upstreamErrorResponse.status === 429,
      `上游真实 429 应透传: ${upstreamErrorResponse.status}`,
    );
    assert(
      upstreamErrorBody?.error?.type === "rate_limit_error",
      "上游真实 429 响应体应透传",
    );
    assert(
      upstream.responseRequests.filter(
        (entry) => entry.body?.test_sequence_key === upstreamErrorKey,
      ).length === 1,
      "上游真实 429 不应触发规则内部重试",
    );

    const runUpstreamPolicyCase = async ({
      key,
      capacityAction,
      http429Action,
      requestBody,
      expectedStatus,
      expectedRequests,
      expectedCode = null,
      expectedReason = null,
    }) => {
      const configResponse = await fetch(
        `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            intercept_rule_mode: "none",
            guard_retry_attempts: 2,
            capacity_error_action: capacityAction,
            http_429_action: http429Action,
          }),
        },
      );
      assert(configResponse.status === 200, `${key} 配置失败: ${configResponse.status}`);
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ test_sequence_key: key, ...requestBody }),
      });
      const responseText = await response.text();
      let responseBody = null;
      try {
        responseBody = JSON.parse(responseText);
      } catch {
        responseBody = null;
      }
      assert(response.status === expectedStatus, `${key} 状态错误: ${response.status}`);
      assert(
        upstream.responseRequests.filter((entry) => entry.body?.test_sequence_key === key).length ===
          expectedRequests,
        `${key} 上游请求次数错误`,
      );
      if (expectedCode) {
        assert(
          responseBody?.error?.code === expectedCode,
          `${key} 502 code 错误: ${responseText}`,
        );
      } else {
        assert(
          responseBody?.error?.message || responseText.trim(),
          `${key} 应原样透传上游错误体`,
        );
      }
      assert(
        response.headers.get("x-codex-retry-gateway-reason") === expectedReason,
        `${key} reason header 错误: ${response.headers.get("x-codex-retry-gateway-reason")}`,
      );
    };

    for (const policyCase of [
      {
        key: "capacity-action-pass-through",
        capacityAction: "pass_through",
        http429Action: "return_502",
        expectedStatus: 429,
        expectedRequests: 1,
        expectedReason: null,
      },
      {
        key: "capacity-action-return-502",
        capacityAction: "return_502",
        http429Action: "pass_through",
        expectedStatus: 502,
        expectedRequests: 1,
        expectedCode: "upstream_capacity_policy_triggered",
        expectedReason: "upstream-capacity",
      },
      {
        key: "capacity-action-retry-then-pass-through",
        capacityAction: "retry_then_pass_through",
        http429Action: "return_502",
        expectedStatus: 429,
        expectedRequests: 3,
        expectedReason: null,
      },
      {
        key: "capacity-action-retry-then-502",
        capacityAction: "retry_then_502",
        http429Action: "pass_through",
        expectedStatus: 502,
        expectedRequests: 3,
        expectedCode: "upstream_capacity_policy_triggered",
        expectedReason: "upstream-capacity",
      },
    ]) {
      await runUpstreamPolicyCase({
        ...policyCase,
        requestBody: {
          test_capacity_error_attempts: 10,
          test_retry_after: "0",
        },
      });
    }

    for (const policyCase of [
      {
        key: "http-429-action-pass-through",
        capacityAction: "return_502",
        http429Action: "pass_through",
        expectedStatus: 429,
        expectedRequests: 1,
        expectedReason: null,
      },
      {
        key: "http-429-action-return-502",
        capacityAction: "pass_through",
        http429Action: "return_502",
        expectedStatus: 502,
        expectedRequests: 1,
        expectedCode: "upstream_rate_limit_policy_triggered",
        expectedReason: "upstream-rate-limited",
      },
      {
        key: "http-429-action-retry-then-pass-through",
        capacityAction: "return_502",
        http429Action: "retry_then_pass_through",
        expectedStatus: 429,
        expectedRequests: 3,
        expectedReason: null,
      },
      {
        key: "http-429-action-retry-then-502",
        capacityAction: "pass_through",
        http429Action: "retry_then_502",
        expectedStatus: 502,
        expectedRequests: 3,
        expectedCode: "upstream_rate_limit_policy_triggered",
        expectedReason: "upstream-rate-limited",
      },
    ]) {
      await runUpstreamPolicyCase({
        ...policyCase,
        requestBody: {
          test_http_429_attempts: 10,
          test_retry_after: "0",
        },
      });
    }

    const newUpstreamPoliciesConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_rule_mode: "none",
          guard_retry_attempts: 1,
          transient_retry: {
            enabled: false,
            initial_delay_ms: 0,
            max_delay_ms: 0,
          },
          http_429_action: "pass_through",
          model_unavailable_error_action: "retry_then_pass_through",
          http_502_503_error_action: "retry_then_pass_through",
          other_http_4xx_error_action: "retry_then_pass_through",
          other_http_5xx_error_action: "retry_then_pass_through",
          error_message_fallback_action: "retry_then_pass_through",
        }),
      },
    );
    assert(
      newUpstreamPoliciesConfigResponse.status === 200,
      `新增上游错误策略配置失败: ${newUpstreamPoliciesConfigResponse.status}`,
    );

    const assertNewUpstreamPolicyRetries = async ({ key, status, payload }) => {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "policy-test-model",
          test_response_model: "policy-test-model",
          test_sequence_key: key,
          test_transient_error_attempts: 1,
          test_transient_error_status: status,
          test_transient_error_payload: payload,
        }),
      });
      assert(
        response.status === 200 &&
          upstream.responseRequests.filter((entry) => entry.body?.test_sequence_key === key).length === 2,
        `${key} 应在同一客户端连接内重试后恢复: ${response.status}`,
      );
    };

    await assertNewUpstreamPolicyRetries({
      key: "model-unavailable-200-envelope-then-ok",
      status: 200,
      payload: { error: "模型 'gpt-5.6-sol' 未配置或不可用" },
    });
    for (const status of [502, 503]) {
      await assertNewUpstreamPolicyRetries({
        key: `http-${status}-policy-then-ok`,
        status,
        payload: { error: { message: "upstream gateway failed" } },
      });
    }
    await assertNewUpstreamPolicyRetries({
      key: "other-http-4xx-policy-then-ok",
      status: 400,
      payload: { error: { message: "request cannot be processed" } },
    });
    await assertNewUpstreamPolicyRetries({
      key: "other-http-5xx-policy-then-ok",
      status: 501,
      payload: { error: { message: "upstream feature unavailable" } },
    });
    await assertNewUpstreamPolicyRetries({
      key: "error-message-fallback-200-envelope-then-ok",
      status: 200,
      payload: { error: { message: "代理返回了未分类错误" } },
    });

    const http429ExclusionKey = "http-429-must-not-use-other-4xx";
    const http429ExclusionResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "policy-test-model",
          test_sequence_key: http429ExclusionKey,
          test_http_429_attempts: 1,
        }),
      },
    );
    assert(
      http429ExclusionResponse.status === 429 &&
        upstream.responseRequests.filter(
          (entry) => entry.body?.test_sequence_key === http429ExclusionKey,
        ).length === 1,
      `HTTP 429 不得落入其他 4xx 策略: ${http429ExclusionResponse.status}`,
    );

    const disableModelUnavailablePolicyResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model_unavailable_error_action: "pass_through" }),
      },
    );
    assert(
      disableModelUnavailablePolicyResponse.status === 200,
      "关闭模型未配置/不可用策略失败",
    );
    const disabledModelUnavailableKey = "model-unavailable-policy-disabled";
    const disabledModelUnavailableResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "policy-test-model",
          test_sequence_key: disabledModelUnavailableKey,
          test_transient_error_attempts: 1,
          test_transient_error_status: 200,
          test_transient_error_payload: {
            error: "模型 'gpt-5.6-sol' 未配置或不可用",
          },
        }),
      },
    );
    assert(
      disabledModelUnavailableResponse.status === 200 &&
        upstream.responseRequests.filter(
          (entry) => entry.body?.test_sequence_key === disabledModelUnavailableKey,
        ).length === 1,
      "关闭模型未配置/不可用策略后不应重放请求",
    );

    const restoreNewUpstreamPoliciesResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model_unavailable_error_action: "pass_through",
          http_502_503_error_action: "pass_through",
          other_http_4xx_error_action: "pass_through",
          other_http_5xx_error_action: "pass_through",
          error_message_fallback_action: "pass_through",
        }),
      },
    );
    assert(
      restoreNewUpstreamPoliciesResponse.status === 200,
      "新增上游错误策略用例后恢复透传配置失败",
    );

    await runUpstreamPolicyCase({
      key: "stream-capacity-text-plain-return-502",
      capacityAction: "return_502",
      http429Action: "pass_through",
      requestBody: {
        stream: true,
        test_capacity_error_attempts: 1,
        test_capacity_error_status: 503,
        test_capacity_error_content_type: "text/plain; charset=utf-8",
      },
      expectedStatus: 502,
      expectedRequests: 1,
      expectedCode: "upstream_capacity_policy_triggered",
      expectedReason: "upstream-capacity",
    });

    await runUpstreamPolicyCase({
      key: "stream-http-429-text-plain-return-502",
      capacityAction: "pass_through",
      http429Action: "return_502",
      requestBody: {
        stream: true,
        test_http_429_attempts: 1,
        test_http_429_content_type: "text/plain; charset=utf-8",
      },
      expectedStatus: 502,
      expectedRequests: 1,
      expectedCode: "upstream_rate_limit_policy_triggered",
      expectedReason: "upstream-rate-limited",
    });

    const retryAfterDateKey = "http-429-retry-after-date";
    const retryAfterDateConfig = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_rule_mode: "none",
          guard_retry_attempts: 1,
          http_429_action: "retry_then_502",
        }),
      },
    );
    assert(retryAfterDateConfig.status === 200, "Retry-After date 配置失败");
    const retryAfterDateStartedAt = Date.now();
    const retryAfterDateResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          test_sequence_key: retryAfterDateKey,
          test_http_429_attempts: 1,
          test_retry_after: new Date(Date.now() + 2500).toUTCString(),
        }),
      },
    );
    assert(retryAfterDateResponse.status === 200, `Retry-After date 后未恢复: ${retryAfterDateResponse.status}`);
    assert(Date.now() - retryAfterDateStartedAt >= 1000, "HTTP-date Retry-After 未被遵守");

    const capacityRetryAfterConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_rule_mode: "none",
          guard_retry_attempts: 1,
          capacity_error_action: "retry_then_502",
          http_429_action: "retry_then_502",
        }),
      },
    );
    assert(capacityRetryAfterConfigResponse.status === 200, "Capacity Retry-After 配置失败");
    const capacityRetryAfterKey = "capacity-429-positive-retry-after";
    const capacityRetryAfterStartedAt = Date.now();
    const capacityRetryAfterResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          test_sequence_key: capacityRetryAfterKey,
          test_capacity_error_attempts: 1,
          test_retry_after: "0.15",
        }),
      },
    );
    assert(
      capacityRetryAfterResponse.status === 200 &&
        Date.now() - capacityRetryAfterStartedAt >= 100 &&
        upstream.responseRequests.filter(
          (entry) => entry.body?.test_sequence_key === capacityRetryAfterKey,
        ).length === 2,
      "HTTP 429 Capacity 响应也必须遵守正值 Retry-After",
    );

    const excessiveRetryAfterKey = "http-429-excessive-retry-after";
    const excessiveRetryAfterResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          test_sequence_key: excessiveRetryAfterKey,
          test_http_429_attempts: 10,
          test_retry_after: "61",
        }),
      },
    );
    assert(
      excessiveRetryAfterResponse.status === 502 &&
        upstream.responseRequests.filter(
          (entry) => entry.body?.test_sequence_key === excessiveRetryAfterKey,
        ).length === 1,
      "超过 60 秒的 Retry-After 不应继续内部重试",
    );

    const sharedBudgetConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_rule_mode: "reasoning_tokens",
          reasoning_match_mode: "formula_518n_minus_2",
          guard_retry_attempts: 1,
          capacity_error_action: "pass_through",
          http_429_action: "retry_then_502",
        }),
      },
    );
    assert(sharedBudgetConfigResponse.status === 200, "共享预算配置失败");
    const sharedBudgetKey = "http-429-then-reasoning-516-shared-budget";
    const sharedBudgetResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          test_sequence_key: sharedBudgetKey,
          test_http_429_attempts: 1,
          test_retry_after: "0",
          test_reasoning_tokens: 516,
        }),
      },
    );
    const sharedBudgetBody = await sharedBudgetResponse.json();
    assert(
      sharedBudgetResponse.status === 502 &&
        sharedBudgetBody?.error?.code === "reasoning_guard_triggered" &&
        upstream.responseRequests.filter(
          (entry) => entry.body?.test_sequence_key === sharedBudgetKey,
        ).length === 2,
      "HTTP 429 与 reasoning 未共用 guard_retry_attempts",
    );

    const disconnectHeadersSentConfig = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_rule_mode: "reasoning_tokens",
          reasoning_match_mode: "formula_518n_minus_2",
          intercept_streaming: true,
          guard_retry_attempts: 2,
          stream_action: "disconnect",
          latency_guard: {
            enabled: false,
            first_progress_timeout_ms: 0,
            first_progress_action: "return_502",
            total_timeout_ms: 0,
          },
        }),
      },
    );
    assert(disconnectHeadersSentConfig.status === 200, "disconnect 已写头场景配置失败");
    const disconnectHeadersSentKey = "disconnect-headers-sent-no-retry";
    let disconnectHeadersSentResponse = null;
    try {
      disconnectHeadersSentResponse = await readSseUntilClose(
        `http://127.0.0.1:${gatewayPort}/responses`,
        {
          stream: true,
          test_sequence_key: disconnectHeadersSentKey,
          test_reasoning_tokens: 516,
          test_stream_reasoning_in_output_chunk: true,
        },
      );
    } catch {
      // 头尚未刷到客户端前直接断开时，fetch 可以在创建 Response 前失败。
    }
    assert(
      (disconnectHeadersSentResponse === null || disconnectHeadersSentResponse.closedByError) &&
        upstream.responseRequests.filter(
          (entry) => entry.body?.test_sequence_key === disconnectHeadersSentKey,
        ).length === 1,
      "客户端响应头已发送后，reasoning 命中只能断连且不得内部重试或改写 502",
    );
    const restoreStrictStreamActionResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stream_action: "strict_502" }),
      },
    );
    assert(restoreStrictStreamActionResponse.status === 200, "disconnect 场景后恢复 strict_502 失败");

    const configureLatencyGuard = async ({
      interceptRuleMode = "none",
      guardRetryAttempts = 0,
      firstProgressTimeoutMs = 0,
      firstProgressAction = "return_502",
      totalTimeoutMs = 0,
    }) => {
      const response = await fetch(
        `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            intercept_rule_mode: interceptRuleMode,
            reasoning_match_mode: "formula_518n_minus_2",
            guard_retry_attempts: guardRetryAttempts,
            capacity_error_action: "pass_through",
            http_429_action: "pass_through",
            latency_guard: {
              enabled: true,
              first_progress_timeout_ms: firstProgressTimeoutMs,
              first_progress_action: firstProgressAction,
              total_timeout_ms: totalTimeoutMs,
            },
          }),
        },
      );
      assert(response.status === 200, `latency_guard 配置失败: ${response.status}`);
    };

    const bypassLatencyConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_rule_mode: "none",
          endpoints: ["/responses"],
          latency_guard: {
            enabled: true,
            first_progress_timeout_ms: 0,
            first_progress_action: "return_502",
            total_timeout_ms: 50,
          },
        }),
      },
    );
    assert(bypassLatencyConfigResponse.status === 200, "旁路 latency 配置失败");
    const bypassLatencyResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/v1/models?test_delay_ms=120`,
    );
    assert(
      bypassLatencyResponse.status === 200 &&
        bypassLatencyResponse.headers.get("x-upstream-test") === "models-ok",
      "未列入 endpoints 的路径应完全旁路 latency guard",
    );
    const restoreManagedEndpointsResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          endpoints: [
            "/responses",
            "/chat/completions",
            "/v1/responses",
            "/v1/chat/completions",
          ],
        }),
      },
    );
    assert(restoreManagedEndpointsResponse.status === 200, "恢复 gateway 管理 endpoints 失败");

    await configureLatencyGuard({ firstProgressTimeoutMs: 60 });
    const firstProgressTimeoutKey = "latency-first-progress-return-502";
    const firstProgressTimeoutResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        stream: true,
        test_sequence_key: firstProgressTimeoutKey,
        test_reasoning_tokens: 128,
        test_stream_initial_delay_ms: 200,
      },
    );
    assert(
      firstProgressTimeoutResponse.status === 502,
      `首个有效输出超时未返回 502: ${firstProgressTimeoutResponse.status}`,
    );
    const firstProgressTimeoutBody = JSON.parse(firstProgressTimeoutResponse.text);
    assert(
      firstProgressTimeoutResponse.headers.get("x-codex-retry-gateway-reason") ===
          "upstream-first-progress-timeout" &&
        firstProgressTimeoutBody?.error?.code === "upstream_first_progress_timeout",
      `首个有效输出超时未返回稳定 502: ${firstProgressTimeoutResponse.text}`,
    );

    const lifecycleTimeoutKey = "latency-lifecycle-is-not-progress";
    const lifecycleTimeoutResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        stream: true,
        test_sequence_key: lifecycleTimeoutKey,
        test_reasoning_tokens: 128,
        test_include_stream_lifecycle: true,
        test_stream_pause_before_output_ms: 200,
        test_stream_chunk_delay_ms: 10,
      },
    );
    assert(
      lifecycleTimeoutResponse.status === 502,
      "仅收到 response.created/in_progress 不应结束首 progress 计时",
    );

    const mislabeledLifecycleTimeoutKey = "latency-mislabeled-sse-lifecycle-is-not-progress";
    const mislabeledLifecycleTimeoutResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        stream: true,
        test_sequence_key: mislabeledLifecycleTimeoutKey,
        test_reasoning_tokens: 128,
        test_include_stream_lifecycle: true,
        test_stream_split_first_chunk_at: 5,
        test_stream_pause_after_first_chunk_ms: 100,
        test_stream_chunk_delay_ms: 10,
        test_stream_response_content_type: "text/plain; charset=utf-8",
      },
    );
    assert(
      mislabeledLifecycleTimeoutResponse.status === 502,
      "误标 Content-Type 的 SSE lifecycle 也不应结束首 progress 计时",
    );

    const splitSseFieldCases = [
      { key: "data", splitAt: 1, firstEventField: null },
      { key: "event", splitAt: 3, firstEventField: "event: response.created" },
      { key: "id", splitAt: 1, firstEventField: "id: evt-split" },
      { key: "retry", splitAt: 3, firstEventField: "retry: 1000" },
    ];
    for (const testCase of splitSseFieldCases) {
      const splitFieldResponse = await readSseUntilClose(
        `http://127.0.0.1:${gatewayPort}/responses`,
        {
          stream: true,
          test_sequence_key: `latency-mislabeled-sse-split-${testCase.key}`,
          test_reasoning_tokens: 128,
          test_stream_first_event_field: testCase.firstEventField,
          test_stream_split_first_chunk_at: testCase.splitAt,
          test_stream_pause_after_first_chunk_ms: 100,
          test_stream_chunk_delay_ms: 10,
          test_stream_response_content_type: "text/plain; charset=utf-8",
        },
      );
      assert(
        splitFieldResponse.status === 502,
        `误标 SSE 的 ${testCase.key}: 字段名跨 chunk 时不得误算普通文本 progress`,
      );
    }

    const standaloneBomResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        stream: true,
        test_sequence_key: "latency-mislabeled-sse-standalone-bom",
        test_reasoning_tokens: 128,
        test_include_stream_lifecycle: true,
        test_stream_prepend_bom: true,
        test_stream_split_first_chunk_at: 1,
        test_stream_pause_after_first_chunk_ms: 100,
        test_stream_chunk_delay_ms: 10,
        test_stream_response_content_type: "text/plain; charset=utf-8",
      },
    );
    assert(
      standaloneBomResponse.status === 502,
      "误标 SSE 的独立 BOM chunk 不得被算作首 progress",
    );
    const splitBomBytesResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        stream: true,
        test_sequence_key: "latency-mislabeled-sse-split-bom-bytes",
        test_reasoning_tokens: 128,
        test_include_stream_lifecycle: true,
        test_stream_prepend_bom: true,
        test_stream_split_first_chunk_bytes_at: 1,
        test_stream_pause_after_first_chunk_ms: 100,
        test_stream_chunk_delay_ms: 10,
        test_stream_response_content_type: "text/plain; charset=utf-8",
      },
    );
    assert(
      splitBomBytesResponse.status === 502,
      "UTF-8 BOM 字节跨 chunk 时仍不得被算作首 progress",
    );

    await configureLatencyGuard({ firstProgressTimeoutMs: 500, totalTimeoutMs: 1000 });
    const preProgressTerminationKey = "latency-pre-progress-upstream-termination";
    const preProgressTerminationResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        stream: true,
        test_sequence_key: preProgressTerminationKey,
        test_force_terminate_before_progress: true,
      },
    );
    assert(
      preProgressTerminationResponse.status === 200 &&
        preProgressTerminationResponse.headers.get("x-upstream-test") === "sse-terminated" &&
        preProgressTerminationResponse.text.includes("response.created"),
      `none + latency_guard 在首 progress 前上游断流时应透传已缓冲前导块和上游响应头: ${JSON.stringify(preProgressTerminationResponse)}`,
    );

    await configureLatencyGuard({ firstProgressTimeoutMs: 60 });
    const emptyCommentaryTimeoutKey = "latency-empty-commentary-is-not-progress";
    const emptyCommentaryTimeoutResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        stream: true,
        test_sequence_key: emptyCommentaryTimeoutKey,
        test_include_empty_commentary_event: true,
        test_stream_pause_after_empty_commentary_ms: 200,
      },
    );
    assert(
      emptyCommentaryTimeoutResponse.status === 502,
      "空 commentary 结构事件不应结束首 progress 计时",
    );

    await configureLatencyGuard({ firstProgressTimeoutMs: 60 });
    const slowTextStreamKey = "latency-slow-non-sse-stream-progress";
    const slowTextStreamResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        stream: true,
        test_sequence_key: slowTextStreamKey,
        test_force_slow_text_for_stream: true,
        test_slow_text_first_chunk: "plain-visible-progress",
        test_slow_text_final_chunk: "plain-stream-complete",
        test_slow_text_pause_ms: 200,
      },
    );
    assert(
      slowTextStreamResponse.status === 200 &&
        slowTextStreamResponse.text.includes("plain-visible-progress") &&
        slowTextStreamResponse.text.includes("plain-stream-complete"),
      `非 SSE 的非空流式 chunk 应结束首 progress 计时: status=${slowTextStreamResponse.status} body=${slowTextStreamResponse.text}`,
    );

    for (const firstChunk of ["id: ordinary visible text\n\n", ": ordinary visible text\n\n"]) {
      const reservedPrefixTextResponse = await readSseUntilClose(
        `http://127.0.0.1:${gatewayPort}/responses`,
        {
          stream: true,
          test_sequence_key: `latency-plain-reserved-prefix-${firstChunk.charCodeAt(0)}`,
          test_force_slow_text_for_stream: true,
          test_slow_text_first_chunk: firstChunk,
          test_slow_text_final_chunk: "plain-stream-complete",
          test_slow_text_pause_ms: 100,
        },
      );
      assert(
        reservedPrefixTextResponse.status === 200 &&
          reservedPrefixTextResponse.text.includes("ordinary visible text") &&
          !reservedPrefixTextResponse.closedByError,
        `普通文本仅以 SSE 保留字段开头时仍应计为 progress: ${JSON.stringify(reservedPrefixTextResponse)}`,
      );
    }

    const fallbackWithTrailingCandidateResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        stream: true,
        test_sequence_key: "latency-plain-fallback-with-trailing-candidate",
        test_force_slow_text_for_stream: true,
        test_slow_text_first_chunk: "id: ordinary visible text\n\nd",
        test_slow_text_final_chunk: "efinitely plain text",
        test_slow_text_pause_ms: 100,
      },
    );
    assert(
      fallbackWithTrailingCandidateResponse.status === 200 &&
        fallbackWithTrailingCandidateResponse.text.includes("ordinary visible text") &&
        !fallbackWithTrailingCandidateResponse.closedByError,
      "完整非 JSON 事件回退为普通文本后，尾随候选前缀不得重新压住 progress",
    );

    const toolProgressKey = "latency-tool-call-is-progress";
    const toolProgressResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        stream: true,
        test_sequence_key: toolProgressKey,
        test_reasoning_tokens: 128,
        test_stream_text: "",
        test_include_stream_function_call: true,
        test_stream_pause_after_function_call_ms: 220,
        test_stream_chunk_delay_ms: 10,
      },
    );
    assert(
      toolProgressResponse.status === 200 &&
        toolProgressResponse.text.includes("function_call") &&
        !toolProgressResponse.closedByError,
      "tool/function call 应结束首 progress 计时并正常透传",
    );

    await configureLatencyGuard({
      guardRetryAttempts: 1,
      firstProgressTimeoutMs: 60,
      firstProgressAction: "retry_then_502",
    });
    const timeoutRetryKey = "latency-first-progress-retry-recovers";
    const timeoutRetryResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        stream: true,
        test_sequence_key: timeoutRetryKey,
        test_reasoning_sequence: [128, 128],
        test_stream_initial_delay_ms_sequence: [180, 0],
        test_stream_chunk_delay_ms: 10,
      },
    );
    assert(
      timeoutRetryResponse.status === 200 &&
        upstream.responseRequests.filter(
          (entry) => entry.body?.test_sequence_key === timeoutRetryKey,
        ).length === 2,
      "首 progress 超时重试未使用共享预算恢复",
    );

    const rateLimitWithFirstProgressGuardConfig = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_rule_mode: "none",
          guard_retry_attempts: 1,
          http_429_action: "retry_then_502",
          latency_guard: {
            enabled: true,
            first_progress_timeout_ms: 60,
            first_progress_action: "return_502",
            total_timeout_ms: 1000,
          },
        }),
      },
    );
    assert(rateLimitWithFirstProgressGuardConfig.status === 200, "429 + 首 progress 组合配置失败");
    const rateLimitWithFirstProgressGuardKey = "latency-429-wait-after-complete-attempt";
    let rateLimitWithFirstProgressGuardResponse = null;
    try {
      rateLimitWithFirstProgressGuardResponse = await fetch(
        `http://127.0.0.1:${gatewayPort}/responses`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            test_sequence_key: rateLimitWithFirstProgressGuardKey,
            test_http_429_attempts: 1,
            test_retry_after: "0.12",
          }),
          signal: AbortSignal.timeout(1000),
        },
      );
    } catch {
      // 断言统一处理超时或断连。
    }
    assert(
      rateLimitWithFirstProgressGuardResponse?.status === 200 &&
        upstream.responseRequests.filter(
          (entry) => entry.body?.test_sequence_key === rateLimitWithFirstProgressGuardKey,
        ).length === 2,
      "已完整收到 429 后，首 progress timer 不应中断 Retry-After 等待",
    );

    const retryWaitDisconnectConfig = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_rule_mode: "none",
          guard_retry_attempts: 1,
          http_429_action: "retry_then_502",
          latency_guard: {
            enabled: false,
            first_progress_timeout_ms: 0,
            first_progress_action: "return_502",
            total_timeout_ms: 0,
          },
        }),
      },
    );
    assert(retryWaitDisconnectConfig.status === 200, "Retry-After 断连场景配置失败");
    const retryWaitDisconnectMetricsBefore = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    const retryWaitDisconnectKey = "http-429-retry-wait-client-disconnect";
    const retryWaitDisconnectController = new AbortController();
    const retryWaitDisconnectPromise = fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          test_sequence_key: retryWaitDisconnectKey,
          test_http_429_attempts: 10,
          test_retry_after: "0.5",
        }),
        signal: retryWaitDisconnectController.signal,
      },
    );
    const retryWaitUpstreamDeadline = Date.now() + 2000;
    while (
      upstream.responseRequests.filter(
        (entry) => entry.body?.test_sequence_key === retryWaitDisconnectKey,
      ).length === 0 &&
      Date.now() < retryWaitUpstreamDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
    retryWaitDisconnectController.abort();
    try {
      await retryWaitDisconnectPromise;
    } catch {
      // 客户端主动取消仍未收到响应的请求属于预期。
    }
    let retryWaitDisconnectSample = null;
    const retryWaitSampleDeadline = Date.now() + 3000;
    while (!retryWaitDisconnectSample && Date.now() < retryWaitSampleDeadline) {
      const payload = await fetch(
        `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning`,
      ).then((response) => response.json());
      retryWaitDisconnectSample = (payload.recent_samples || []).find((sample) =>
        `${sample.request_payload_excerpt || ""}`.includes(retryWaitDisconnectKey),
      );
      if (!retryWaitDisconnectSample) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    const retryWaitDisconnectMetricsAfter = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      retryWaitDisconnectSample?.final_action === "client_disconnected" &&
        retryWaitDisconnectSample?.policy_trigger === "http_429",
      `Retry-After 等待中断连样本收口错误: ${JSON.stringify(retryWaitDisconnectSample)}`,
    );
    assert(
      retryWaitDisconnectMetricsAfter.metrics.total_proxy_request_count ===
        retryWaitDisconnectMetricsBefore.metrics.total_proxy_request_count + 1 &&
        retryWaitDisconnectMetricsAfter.metrics.inspected_response_count ===
          retryWaitDisconnectMetricsBefore.metrics.inspected_response_count + 1 &&
        retryWaitDisconnectMetricsAfter.metrics.failed_proxy_request_count ===
          retryWaitDisconnectMetricsBefore.metrics.failed_proxy_request_count &&
        retryWaitDisconnectMetricsAfter.metrics.http_429_trigger_count ===
          retryWaitDisconnectMetricsBefore.metrics.http_429_trigger_count + 1 &&
        retryWaitDisconnectMetricsAfter.metrics.http_429_retry_count ===
          retryWaitDisconnectMetricsBefore.metrics.http_429_retry_count,
      `Retry-After 等待中断连不得同时计入 inspected 与 failed: before=${JSON.stringify(retryWaitDisconnectMetricsBefore.metrics)} after=${JSON.stringify(retryWaitDisconnectMetricsAfter.metrics)}`,
    );

    const policyDeadlineGatewayPort = await getFreePort();
    const policyDeadlineConfigPath = path.join(tempRoot, "policy-deadline-config.json");
    const policyDeadlineLogPath = path.join(tempRoot, "policy-deadline-gateway.log");
    const policyDeadlineTimerFaultPath = path.join(tempRoot, "policy-deadline-timer-fault.cjs");
    await writeFile(
      policyDeadlineTimerFaultPath,
      [
        "const originalSetTimeout = global.setTimeout;",
        "const originalUnshift = Array.prototype.unshift;",
        "const originalObjectEntries = Object.entries;",
        "const originalDateNow = Date.now;",
        "const originalFetch = global.fetch;",
        "let acceleratedTotalDeadline = false;",
        "let stalledRetryDelay = false;",
        "let dispatchWindowDeadlineAt = 0;",
        "let stalledDispatchWindowRetry = false;",
        "const stalledRetrySampleActions = new Set();",
        "let finalDispatchHeaderCloneCount = 0;",
        "let splitTotalGateHeaderCloneCount = 0;",
        "let splitTotalGateStage = 0;",
        "let splitTotalGateForcedNow = 0;",
        "let firstProgressHeaderCloneCount = 0;",
        "let initialHeaderCloneStalled = false;",
        "let guardToFetchStallActive = false;",
        "Date.now = function patchedDateNow() {",
        "  const stack = new Error().stack;",
        "  if (splitTotalGateStage === 1 && stack.includes('expireTotalDeadlineIfNeeded')) {",
        "    splitTotalGateStage = 2;",
        "    return 0;",
        "  }",
        "  if ((splitTotalGateStage === 1 || splitTotalGateStage === 2) && stack.includes('proxyRequest')) {",
        "    splitTotalGateStage = 0;",
        "    splitTotalGateForcedNow = originalDateNow() + 1000;",
        "    return splitTotalGateForcedNow;",
        "  }",
        "  if (guardToFetchStallActive && new Error().stack.includes('expireTotalDeadlineIfNeeded')) {",
        "    guardToFetchStallActive = false;",
        "    const capturedNow = originalDateNow();",
        "    const releaseAt = capturedNow + 80;",
        "    while (originalDateNow() < releaseAt) {}",
        "    return capturedNow;",
        "  }",
        "  return originalDateNow();",
        "};",
        "global.fetch = function patchedFetch(input, init) {",
        "  if (init?.headers?.get?.('x-test-guard-to-fetch-stall') === '1') {",
        "    guardToFetchStallActive = false;",
        "  }",
        "  return Reflect.apply(originalFetch, this, [input, init]);",
        "};",
        "global.setTimeout = function patchedSetTimeout(callback, delay, ...args) {",
        "  const numericDelay = Number(delay);",
        "  if (!acceleratedTotalDeadline && numericDelay >= 600 && numericDelay <= 731) {",
        "    acceleratedTotalDeadline = true;",
        "    return originalSetTimeout(callback, 100, ...args);",
        "  }",
        "  if (!stalledRetryDelay && numericDelay === 50) {",
        "    stalledRetryDelay = true;",
        "    return originalSetTimeout(() => {",
        "      const stalledUntil = Date.now() + 100;",
        "      while (Date.now() < stalledUntil) {}",
        "      callback(...args);",
        "    }, delay);",
        "  }",
        "  if (!dispatchWindowDeadlineAt && numericDelay >= 180 && numericDelay <= 220) {",
        "    dispatchWindowDeadlineAt = Date.now() + numericDelay;",
        "  }",
        "  if (!stalledDispatchWindowRetry && dispatchWindowDeadlineAt && numericDelay === 60) {",
        "    stalledDispatchWindowRetry = true;",
        "    return originalSetTimeout(() => {",
        "      const resumeAt = dispatchWindowDeadlineAt - 20;",
        "      while (Date.now() < resumeAt) {}",
        "      callback(...args);",
        "    }, delay);",
        "  }",
        "  return originalSetTimeout(callback, delay, ...args);",
        "};",
        "Array.prototype.unshift = function patchedUnshift(...items) {",
        "  const retrySample = items.find((item) => ['http_429_internal_retry', 'internal_retry', 'continuation_recovery', 'first_progress_timeout_internal_retry'].includes(item?.final_action));",
        "  if (dispatchWindowDeadlineAt && retrySample && !stalledRetrySampleActions.has(retrySample.final_action)) {",
        "    stalledRetrySampleActions.add(retrySample.final_action);",
        "    const releaseAt = dispatchWindowDeadlineAt + 20;",
        "    while (Date.now() < releaseAt) {}",
        "    dispatchWindowDeadlineAt = 0;",
        "  }",
        "  return Reflect.apply(originalUnshift, this, items);",
        "};",
        "Object.entries = function patchedObjectEntries(value) {",
        "  if (value && value['x-test-final-dispatch-stall'] === '1' && new Error().stack.includes('cloneHeadersForUpstream')) {",
        "    finalDispatchHeaderCloneCount += 1;",
        "    if (finalDispatchHeaderCloneCount === 2 && dispatchWindowDeadlineAt) {",
        "      const releaseAt = dispatchWindowDeadlineAt + 20;",
        "      while (Date.now() < releaseAt) {}",
        "      dispatchWindowDeadlineAt = 0;",
        "    }",
        "  }",
        "  if (value && value['x-test-split-total-gate'] === '1' && new Error().stack.includes('cloneHeadersForUpstream')) {",
        "    splitTotalGateHeaderCloneCount += 1;",
        "    if (splitTotalGateHeaderCloneCount === 2) {",
        "      splitTotalGateStage = 1;",
        "    }",
        "  }",
        "  if (value && value['x-test-first-progress-header-stall'] === '1' && new Error().stack.includes('cloneHeadersForUpstream')) {",
        "    firstProgressHeaderCloneCount += 1;",
        "    if (firstProgressHeaderCloneCount === 2) {",
        "      const releaseAt = originalDateNow() + 80;",
        "      while (originalDateNow() < releaseAt) {}",
        "    }",
        "  }",
        "  if (value && value['x-test-initial-header-stall'] === '1' && new Error().stack.includes('cloneHeadersForUpstream') && !initialHeaderCloneStalled) {",
        "    initialHeaderCloneStalled = true;",
        "    const releaseAt = originalDateNow() + 80;",
        "    while (originalDateNow() < releaseAt) {}",
        "  }",
        "  if (value && value['x-test-guard-to-fetch-stall'] === '1' && new Error().stack.includes('cloneHeadersForUpstream')) {",
        "    guardToFetchStallActive = true;",
        "  }",
        "  return Reflect.apply(originalObjectEntries, Object, [value]);",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      policyDeadlineConfigPath,
      JSON.stringify(
        {
          ...config,
          listen_port: policyDeadlineGatewayPort,
          intercept_rule_mode: "none",
          guard_retry_attempts: 1,
          http_429_action: "retry_then_502",
          latency_guard: {
            enabled: true,
            first_progress_timeout_ms: 0,
            first_progress_action: "return_502",
            total_timeout_ms: 731,
          },
          active_probe: { enabled: false },
        },
        null,
        2,
      ),
      "utf8",
    );
    let policyDeadlineGateway = null;
    try {
      policyDeadlineGateway = startGateway(
        policyDeadlineConfigPath,
        policyDeadlineLogPath,
        { nodeArgs: ["--require", policyDeadlineTimerFaultPath] },
      );
      await waitForHealth(
        `http://127.0.0.1:${policyDeadlineGatewayPort}${config.health_path}`,
        { gateway: policyDeadlineGateway, logPath: policyDeadlineLogPath },
      );
      const policyDeadlineKey = "latency-total-deadline-during-retry-after";
      let policyDeadlineResponse = null;
      let policyDeadlineBody = null;
      let policyDeadlineError = null;
      try {
        policyDeadlineResponse = await fetch(
          `http://127.0.0.1:${policyDeadlineGatewayPort}/responses`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              test_sequence_key: policyDeadlineKey,
              test_http_429_attempts: 10,
              test_retry_after: "0.25",
            }),
            signal: AbortSignal.timeout(1500),
          },
        );
        policyDeadlineBody = await policyDeadlineResponse.json();
      } catch (error) {
        policyDeadlineError = error;
      }
      assert(
        policyDeadlineResponse?.status === 502 &&
          policyDeadlineResponse.headers.get("x-codex-retry-gateway-reason") ===
            "upstream-total-timeout" &&
          policyDeadlineBody?.error?.code === "upstream_total_timeout",
        `Retry-After 等待被总 deadline 中断后必须返回 502: status=${policyDeadlineResponse?.status ?? "none"} body=${JSON.stringify(policyDeadlineBody)} error=${policyDeadlineError?.message || "none"}`,
      );
      const policyDeadlineAnalytics = await fetch(
        `http://127.0.0.1:${policyDeadlineGatewayPort}/__codex_retry_gateway/api/analytics/reasoning`,
      ).then((response) => response.json());
      const policyDeadlineSamples = (policyDeadlineAnalytics.recent_samples || []).filter((sample) =>
        `${sample.request_payload_excerpt || ""}`.includes(policyDeadlineKey),
      );
      assert(
        policyDeadlineSamples.length === 1 &&
          policyDeadlineSamples[0]?.final_action === "total_timeout_returned_502" &&
          policyDeadlineSamples[0]?.retry_after_ms === 250 &&
          policyDeadlineSamples[0]?.retry_trigger === null &&
          policyDeadlineSamples[0]?.retry_delay_ms === null &&
          upstream.responseRequests.filter(
            (entry) => entry.body?.test_sequence_key === policyDeadlineKey,
          ).length === 1,
        `Retry-After deadline 收口必须复用同一 attempt 样本且不得创建新 attempt: ${JSON.stringify(policyDeadlineSamples)}`,
      );

      const lateTimerConfigResponse = await fetch(
        `http://127.0.0.1:${policyDeadlineGatewayPort}/__codex_retry_gateway/api/config`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            intercept_rule_mode: "none",
            guard_retry_attempts: 1,
            http_429_action: "retry_then_502",
            latency_guard: {
              enabled: true,
              first_progress_timeout_ms: 0,
              first_progress_action: "return_502",
              total_timeout_ms: 120,
            },
          }),
        },
      );
      assert(lateTimerConfigResponse.status === 200, "过期 timer 顺序反例配置失败");
      const lateTimerDeadlineKey = "latency-total-deadline-after-late-retry-timer";
      const lateTimerDeadlineResponse = await fetch(
        `http://127.0.0.1:${policyDeadlineGatewayPort}/responses`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            test_sequence_key: lateTimerDeadlineKey,
            test_http_429_attempts: 1,
            test_retry_after: "0.05",
          }),
          signal: AbortSignal.timeout(1500),
        },
      );
      const lateTimerDeadlineBody = await lateTimerDeadlineResponse.json();
      assert(
        lateTimerDeadlineResponse.status === 502 &&
          lateTimerDeadlineResponse.headers.get("x-codex-retry-gateway-reason") ===
            "upstream-total-timeout" &&
          lateTimerDeadlineBody?.error?.code === "upstream_total_timeout" &&
          upstream.responseRequests.filter(
            (entry) => entry.body?.test_sequence_key === lateTimerDeadlineKey,
          ).length === 1,
        "Retry-After timer 恢复时总 deadline 已过期，不得派发新 attempt",
      );

      const dispatchWindowConfigResponse = await fetch(
        `http://127.0.0.1:${policyDeadlineGatewayPort}/__codex_retry_gateway/api/config`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            intercept_rule_mode: "none",
            guard_retry_attempts: 1,
            http_429_action: "retry_then_502",
            latency_guard: {
              enabled: true,
              first_progress_timeout_ms: 0,
              first_progress_action: "return_502",
              total_timeout_ms: 220,
            },
          }),
        },
      );
      assert(dispatchWindowConfigResponse.status === 200, "下一 attempt 最终 deadline 闸门配置失败");
      const dispatchWindowKey = "latency-final-gate-before-next-dispatch";
      try {
        const dispatchWindowResponse = await fetch(
          `http://127.0.0.1:${policyDeadlineGatewayPort}/responses`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              test_sequence_key: dispatchWindowKey,
              test_http_429_attempts: 1,
              test_retry_after: "0.06",
            }),
            signal: AbortSignal.timeout(1500),
          },
        );
        await dispatchWindowResponse.arrayBuffer();
      } catch {
        // 总 deadline 可以在第二次请求已按时派发后取消其响应读取。
      }
      const dispatchWindowRequests = upstream.responseRequests.filter(
        (entry) => entry.body?.test_sequence_key === dispatchWindowKey,
      );
      assert(
        dispatchWindowRequests.length === 2 &&
          dispatchWindowRequests[1].received_at_ms - dispatchWindowRequests[0].received_at_ms < 220,
        `下一 attempt 必须在总 deadline 前真正派发: ${JSON.stringify(dispatchWindowRequests)}`,
      );

      const assertSharedRetryDispatchBeforeDeadline = async ({
        key,
        configBody,
        requestBody,
      }) => {
        const configResponse = await fetch(
          `http://127.0.0.1:${policyDeadlineGatewayPort}/__codex_retry_gateway/api/config`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(configBody),
          },
        );
        assert(configResponse.status === 200, `${key} 配置失败`);
        try {
          const response = await fetch(
            `http://127.0.0.1:${policyDeadlineGatewayPort}/responses`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ test_sequence_key: key, ...requestBody }),
              signal: AbortSignal.timeout(1500),
            },
          );
          await response.arrayBuffer();
        } catch {
          // 同步样本故障注入会让总 deadline 在第二次派发后到期。
        }
        const requests = upstream.responseRequests.filter(
          (entry) => entry.body?.test_sequence_key === key,
        );
        assert(
          requests.length === 2 && requests[1].received_at_ms - requests[0].received_at_ms < 220,
          `${key} 的共享 retry 必须在总 deadline 前真正派发: ${JSON.stringify(requests)}`,
        );
      };

      await assertSharedRetryDispatchBeforeDeadline({
        key: "latency-final-gate-reasoning-guard-retry",
        configBody: {
          intercept_rule_mode: "reasoning_tokens",
          reasoning_match_mode: "formula_518n_minus_2",
          reasoning_equals: [516],
          stream_action: "strict_502",
          intercept_streaming: true,
          intercept_non_streaming: true,
          guard_retry_attempts: 1,
          latency_guard: {
            enabled: true,
            first_progress_timeout_ms: 0,
            first_progress_action: "return_502",
            total_timeout_ms: 220,
          },
        },
        requestBody: { test_reasoning_sequence: [516, 128] },
      });

      await assertSharedRetryDispatchBeforeDeadline({
        key: "latency-final-gate-continuation-retry",
        configBody: {
          intercept_rule_mode: "reasoning_tokens",
          reasoning_match_mode: "manual",
          reasoning_equals: [516],
          stream_action: "continuation_recovery",
          intercept_streaming: true,
          intercept_non_streaming: true,
          guard_retry_attempts: 1,
          latency_guard: {
            enabled: true,
            first_progress_timeout_ms: 0,
            first_progress_action: "return_502",
            total_timeout_ms: 220,
          },
        },
        requestBody: {
          stream: true,
          test_reasoning_sequence: [516, 128],
          test_stream_chunk_delay_ms: 10,
        },
      });

      await assertSharedRetryDispatchBeforeDeadline({
        key: "latency-final-gate-first-progress-retry",
        configBody: {
          intercept_rule_mode: "none",
          guard_retry_attempts: 1,
          latency_guard: {
            enabled: true,
            first_progress_timeout_ms: 40,
            first_progress_action: "retry_then_502",
            total_timeout_ms: 220,
          },
        },
        requestBody: {
          stream: true,
          test_reasoning_sequence: [128, 128],
          test_stream_initial_delay_ms_sequence: [80, 0],
          test_stream_chunk_delay_ms: 10,
        },
      });

      const finalDispatchGapConfigResponse = await fetch(
        `http://127.0.0.1:${policyDeadlineGatewayPort}/__codex_retry_gateway/api/config`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            intercept_rule_mode: "none",
            guard_retry_attempts: 1,
            http_429_action: "retry_then_502",
            latency_guard: {
              enabled: true,
              first_progress_timeout_ms: 0,
              first_progress_action: "return_502",
              total_timeout_ms: 220,
            },
          }),
        },
      );
      assert(finalDispatchGapConfigResponse.status === 200, "真实 fetch 前最终 deadline RED 配置失败");
      const finalDispatchGapMetricsBefore = await fetch(
        `http://127.0.0.1:${policyDeadlineGatewayPort}/__codex_retry_gateway/api/status`,
      ).then((response) => response.json());
      const finalDispatchGapKey = "latency-final-gate-after-header-clone-stall";
      const finalDispatchGapResponse = await fetch(
        `http://127.0.0.1:${policyDeadlineGatewayPort}/responses`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-test-final-dispatch-stall": "1",
          },
          body: JSON.stringify({
            test_sequence_key: finalDispatchGapKey,
            test_http_429_attempts: 1,
            test_retry_after: "0",
          }),
          signal: AbortSignal.timeout(1500),
        },
      );
      const finalDispatchGapBody = await finalDispatchGapResponse.json();
      const finalDispatchGapMetricsAfter = await fetch(
        `http://127.0.0.1:${policyDeadlineGatewayPort}/__codex_retry_gateway/api/status`,
      ).then((response) => response.json());
      const finalDispatchGapRequests = upstream.responseRequests.filter(
        (entry) => entry.body?.test_sequence_key === finalDispatchGapKey,
      );
      assert(
        finalDispatchGapResponse.status === 502 &&
          finalDispatchGapBody?.error?.code === "upstream_total_timeout" &&
          finalDispatchGapBody?.retry_attempts_used === 0 &&
          finalDispatchGapRequests.length === 1 &&
          finalDispatchGapMetricsAfter.metrics.total_proxy_request_count ===
            finalDispatchGapMetricsBefore.metrics.total_proxy_request_count + 1,
        `最终 deadline 跨过后不得增加预算、attempt 或真实上游请求: body=${JSON.stringify(finalDispatchGapBody)} requests=${JSON.stringify(finalDispatchGapRequests)} before=${JSON.stringify(finalDispatchGapMetricsBefore.metrics)} after=${JSON.stringify(finalDispatchGapMetricsAfter.metrics)}`,
      );

      const initialDispatchAnchorConfigResponse = await fetch(
        `http://127.0.0.1:${policyDeadlineGatewayPort}/__codex_retry_gateway/api/config`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            intercept_rule_mode: "none",
            guard_retry_attempts: 0,
            latency_guard: {
              enabled: true,
              first_progress_timeout_ms: 0,
              first_progress_action: "return_502",
              total_timeout_ms: 40,
            },
          }),
        },
      );
      assert(initialDispatchAnchorConfigResponse.status === 200, "首次 total 派发锚点配置失败");
      const initialDispatchAnchorMetricsBefore = await fetch(
        `http://127.0.0.1:${policyDeadlineGatewayPort}/__codex_retry_gateway/api/status`,
      ).then((response) => response.json());
      const initialDispatchAnchorKey = "latency-total-starts-at-first-real-fetch";
      const initialDispatchAnchorResponse = await fetch(
        `http://127.0.0.1:${policyDeadlineGatewayPort}/responses`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-test-initial-header-stall": "1",
          },
          body: JSON.stringify({ test_sequence_key: initialDispatchAnchorKey }),
          signal: AbortSignal.timeout(1500),
        },
      );
      const initialDispatchAnchorBody = await initialDispatchAnchorResponse.json();
      const initialDispatchAnchorMetricsAfter = await fetch(
        `http://127.0.0.1:${policyDeadlineGatewayPort}/__codex_retry_gateway/api/status`,
      ).then((response) => response.json());
      const initialDispatchAnchorRequests = upstream.responseRequests.filter(
        (entry) => entry.body?.test_sequence_key === initialDispatchAnchorKey,
      );
      assert(
        initialDispatchAnchorResponse.status === 200 &&
          initialDispatchAnchorBody?.usage?.output_tokens_details?.reasoning_tokens === 128 &&
          initialDispatchAnchorRequests.length === 1 &&
          initialDispatchAnchorMetricsAfter.metrics.total_proxy_request_count ===
            initialDispatchAnchorMetricsBefore.metrics.total_proxy_request_count + 1 &&
          initialDispatchAnchorMetricsAfter.metrics.inspected_response_count ===
            initialDispatchAnchorMetricsBefore.metrics.inspected_response_count + 1,
        `首次 total 必须从真实 fetch 派发建立，本地 header 准备不得产生未派发 inspected sample: ${JSON.stringify({
          status: initialDispatchAnchorResponse.status,
          body: initialDispatchAnchorBody,
          requests: initialDispatchAnchorRequests,
          before: initialDispatchAnchorMetricsBefore.metrics,
          after: initialDispatchAnchorMetricsAfter.metrics,
        })}`,
      );

      const guardToFetchAnchorConfigResponse = await fetch(
        `http://127.0.0.1:${policyDeadlineGatewayPort}/__codex_retry_gateway/api/config`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            intercept_rule_mode: "none",
            guard_retry_attempts: 0,
            latency_guard: {
              enabled: true,
              first_progress_timeout_ms: 40,
              first_progress_action: "return_502",
              total_timeout_ms: 300,
            },
          }),
        },
      );
      assert(guardToFetchAnchorConfigResponse.status === 200, "首 progress 真实 fetch 锚点配置失败");
      const guardToFetchAnchorKey = "latency-first-progress-starts-at-real-fetch";
      const guardToFetchAnchorResponse = await fetch(
        `http://127.0.0.1:${policyDeadlineGatewayPort}/responses`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-test-guard-to-fetch-stall": "1",
          },
          body: JSON.stringify({ test_sequence_key: guardToFetchAnchorKey }),
          signal: AbortSignal.timeout(1500),
        },
      );
      const guardToFetchAnchorBody = await guardToFetchAnchorResponse.json();
      assert(
        guardToFetchAnchorResponse.status === 200 &&
          guardToFetchAnchorBody?.usage?.output_tokens_details?.reasoning_tokens === 128 &&
          upstream.responseRequests.filter(
            (entry) => entry.body?.test_sequence_key === guardToFetchAnchorKey,
          ).length === 1,
        `current 首 progress 必须锚定真实 fetch，guard 到 fetch 的同步停顿不得派发过期 attempt: status=${guardToFetchAnchorResponse.status} body=${JSON.stringify(guardToFetchAnchorBody)}`,
      );

      const splitTotalGateConfigResponse = await fetch(
        `http://127.0.0.1:${policyDeadlineGatewayPort}/__codex_retry_gateway/api/config`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            intercept_rule_mode: "none",
            guard_retry_attempts: 1,
            http_429_action: "retry_then_502",
            latency_guard: {
              enabled: true,
              first_progress_timeout_ms: 0,
              first_progress_action: "return_502",
              total_timeout_ms: 220,
            },
          }),
        },
      );
      assert(splitTotalGateConfigResponse.status === 200, "pending 最终闸门归属配置失败");
      const splitTotalGateMetricsBefore = await fetch(
        `http://127.0.0.1:${policyDeadlineGatewayPort}/__codex_retry_gateway/api/status`,
      ).then((response) => response.json());
      const splitTotalGateKey = "latency-pending-owner-at-final-total-gate";
      const splitTotalGateResponse = await fetch(
        `http://127.0.0.1:${policyDeadlineGatewayPort}/responses`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-test-split-total-gate": "1",
          },
          body: JSON.stringify({
            test_sequence_key: splitTotalGateKey,
            test_http_429_attempts: 1,
            test_retry_after: "0",
          }),
          signal: AbortSignal.timeout(1500),
        },
      );
      const splitTotalGateBody = await splitTotalGateResponse.json();
      const splitTotalGateAnalytics = await fetch(
        `http://127.0.0.1:${policyDeadlineGatewayPort}/__codex_retry_gateway/api/analytics/reasoning`,
      ).then((response) => response.json());
      const splitTotalGateSamples = (splitTotalGateAnalytics.recent_samples || []).filter(
        (sample) => `${sample.request_payload_excerpt || ""}`.includes(splitTotalGateKey),
      );
      const splitTotalGateRequests = upstream.responseRequests.filter(
        (entry) => entry.body?.test_sequence_key === splitTotalGateKey,
      );
      const splitTotalGateMetricsAfter = await fetch(
        `http://127.0.0.1:${policyDeadlineGatewayPort}/__codex_retry_gateway/api/status`,
      ).then((response) => response.json());
      assert(
        splitTotalGateResponse.status === 502 &&
          splitTotalGateBody?.error?.code === "upstream_total_timeout" &&
          splitTotalGateRequests.length === 1 &&
          splitTotalGateSamples.length === 1 &&
          splitTotalGateSamples[0]?.attempt_id?.endsWith(":attempt:1") &&
          splitTotalGateSamples[0]?.retry_budget_used === 0 &&
          Number.isFinite(splitTotalGateSamples[0]?.upstream_fetch_started_at_ms) &&
          splitTotalGateMetricsAfter.metrics.total_proxy_request_count ===
            splitTotalGateMetricsBefore.metrics.total_proxy_request_count + 1 &&
          splitTotalGateMetricsAfter.metrics.inspected_response_count ===
            splitTotalGateMetricsBefore.metrics.inspected_response_count + 1,
        `pending 最终 total gate 过期时必须由已检查的旧 attempt 收口: ${JSON.stringify({
          body: splitTotalGateBody,
          samples: splitTotalGateSamples,
          requests: splitTotalGateRequests,
          before: splitTotalGateMetricsBefore.metrics,
          after: splitTotalGateMetricsAfter.metrics,
        })}`,
      );

      const firstProgressHeaderStallConfigResponse = await fetch(
        `http://127.0.0.1:${policyDeadlineGatewayPort}/__codex_retry_gateway/api/config`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            intercept_rule_mode: "none",
            guard_retry_attempts: 1,
            http_429_action: "retry_then_502",
            latency_guard: {
              enabled: true,
              first_progress_timeout_ms: 40,
              first_progress_action: "return_502",
              total_timeout_ms: 220,
            },
          }),
        },
      );
      assert(firstProgressHeaderStallConfigResponse.status === 200, "首 progress 派发起点配置失败");
      const firstProgressHeaderStallKey = "latency-first-progress-starts-at-dispatch";
      const firstProgressHeaderStallResponse = await fetch(
        `http://127.0.0.1:${policyDeadlineGatewayPort}/responses`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-test-first-progress-header-stall": "1",
          },
          body: JSON.stringify({
            test_sequence_key: firstProgressHeaderStallKey,
            test_http_429_attempts: 1,
            test_retry_after: "0",
          }),
          signal: AbortSignal.timeout(1500),
        },
      );
      const firstProgressHeaderStallBody = await firstProgressHeaderStallResponse.json();
      const firstProgressHeaderStallRequests = upstream.responseRequests.filter(
        (entry) => entry.body?.test_sequence_key === firstProgressHeaderStallKey,
      );
      assert(
        firstProgressHeaderStallResponse.status === 200 &&
          firstProgressHeaderStallBody?.usage?.output_tokens_details?.reasoning_tokens === 128 &&
          firstProgressHeaderStallRequests.length === 2,
        `请求准备耗时不得消耗尚未派发 attempt 的首 progress 窗口: status=${firstProgressHeaderStallResponse.status} body=${JSON.stringify(firstProgressHeaderStallBody)} requests=${JSON.stringify(firstProgressHeaderStallRequests)}`,
      );

      const pendingSampleConfigResponse = await fetch(
        `http://127.0.0.1:${policyDeadlineGatewayPort}/__codex_retry_gateway/api/config`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            intercept_rule_mode: "none",
            guard_retry_attempts: 1,
            http_429_action: "retry_then_502",
            latency_guard: {
              enabled: false,
              first_progress_timeout_ms: 0,
              first_progress_action: "return_502",
              total_timeout_ms: 0,
            },
          }),
        },
      );
      assert(pendingSampleConfigResponse.status === 200, "pending policy 样本配置失败");
      const pendingLogsBefore = await fetch(
        `http://127.0.0.1:${policyDeadlineGatewayPort}/__codex_retry_gateway/api/logs`,
      ).then((response) => response.json());
      const pendingSampleKey = "policy-retry-sample-before-next-headers";
      const pendingSampleAbortController = new AbortController();
      const pendingSampleRequest = fetch(
        `http://127.0.0.1:${policyDeadlineGatewayPort}/responses`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            test_sequence_key: pendingSampleKey,
            test_http_429_attempts: 1,
            test_retry_after: "0",
            test_response_delay_ms: 800,
          }),
          signal: pendingSampleAbortController.signal,
        },
      ).then((response) => response.arrayBuffer()).catch(() => null);
      const pendingDispatchDeadline = Date.now() + 500;
      while (
        upstream.responseRequests.filter(
          (entry) => entry.body?.test_sequence_key === pendingSampleKey,
        ).length < 2 &&
        Date.now() < pendingDispatchDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert(
        upstream.responseRequests.filter(
          (entry) => entry.body?.test_sequence_key === pendingSampleKey,
        ).length === 2,
        "pending policy 样本用例未进入第二次上游 fetch",
      );
      let pendingRetrySample = null;
      const pendingSampleDeadline = Date.now() + 250;
      while (!pendingRetrySample && Date.now() < pendingSampleDeadline) {
        const analytics = await fetch(
          `http://127.0.0.1:${policyDeadlineGatewayPort}/__codex_retry_gateway/api/analytics/reasoning`,
        ).then((response) => response.json());
        pendingRetrySample = (analytics.recent_samples || []).find(
          (sample) =>
            sample.final_action === "http_429_internal_retry" &&
            `${sample.request_payload_excerpt || ""}`.includes(pendingSampleKey),
        );
        if (!pendingRetrySample) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      const pendingSampleAnalytics = await fetch(
        `http://127.0.0.1:${policyDeadlineGatewayPort}/__codex_retry_gateway/api/analytics/reasoning`,
      ).then((response) => response.json());
      const pendingRetrySamples = (pendingSampleAnalytics.recent_samples || []).filter(
        (sample) =>
          sample.final_action === "http_429_internal_retry" &&
          `${sample.request_payload_excerpt || ""}`.includes(pendingSampleKey),
      );
      const pendingSampleRequests = upstream.responseRequests.filter(
        (entry) => entry.body?.test_sequence_key === pendingSampleKey,
      );
      const pendingLogsAfter = await fetch(
        `http://127.0.0.1:${policyDeadlineGatewayPort}/__codex_retry_gateway/api/logs?since_seq=${pendingLogsBefore.latest_seq}`,
      ).then((response) => response.json());
      const pendingRetryLog = (pendingLogsAfter.entries || []).find(
        (entry) =>
          `${entry.message || ""}`.includes("[upstream-429]") &&
          `${entry.message || ""}`.includes("action=internal_retry"),
      );
      pendingSampleAbortController.abort();
      await pendingSampleRequest;
      // Windows 跨进程墙钟可能小幅回拨，派发顺序由上游请求序列和 evidence 边界共同证明。
      const crossProcessClockToleranceMs = 50;
      assert(
        pendingRetrySample &&
          pendingRetrySamples.length === 1 &&
          pendingRetrySample.duration_total_ms < 500 &&
          pendingRetrySample.request_finished_at_ms <=
            pendingSampleRequests[1].received_at_ms + crossProcessClockToleranceMs &&
          Number.isInteger(pendingRetrySample.evidence_log_seq_range?.to) &&
          Number.isInteger(pendingRetryLog?.seq) &&
          pendingRetrySample.evidence_log_seq_range.to < pendingRetryLog.seq,
        `旧 policy attempt 必须在下一 fetch 挂起期间及时按自身时间落盘: ${JSON.stringify({
          sample: pendingRetrySample,
          matching_sample_count: pendingRetrySamples.length,
          second_upstream_received_at_ms: pendingSampleRequests[1]?.received_at_ms ?? null,
          checks: {
            duration_bounded: (pendingRetrySample?.duration_total_ms ?? Infinity) < 500,
            finished_before_second_dispatch_with_clock_tolerance:
              (pendingRetrySample?.request_finished_at_ms ?? Infinity) <=
              (pendingSampleRequests[1]?.received_at_ms ?? -Infinity) +
                crossProcessClockToleranceMs,
            evidence_bound_present: Number.isInteger(
              pendingRetrySample?.evidence_log_seq_range?.to,
            ),
            evidence_excludes_retry_completion_log:
              Number.isInteger(pendingRetryLog?.seq) &&
              (pendingRetrySample?.evidence_log_seq_range?.to ?? Infinity) < pendingRetryLog.seq,
          },
          retry_completion_log: pendingRetryLog ?? null,
        })}`,
      );
    } finally {
      await stopGateway(policyDeadlineGateway);
    }

    const completionDeadlineGatewayPort = await getFreePort();
    const completionDeadlineConfigPath = path.join(
      tempRoot,
      "completion-deadline-config.json",
    );
    const completionDeadlineLogPath = path.join(
      tempRoot,
      "completion-deadline-gateway.log",
    );
    const completionDeadlineFaultPath = path.join(
      tempRoot,
      "completion-deadline-fault.cjs",
    );
    await writeFile(
      completionDeadlineFaultPath,
      [
        "const originalSetTimeout = global.setTimeout;",
        "const originalJsonParse = JSON.parse;",
        "const originalJsonStringify = JSON.stringify;",
        "const originalHeadersEntries = Headers.prototype.entries;",
        "const originalWeakSetAdd = WeakSet.prototype.add;",
        "const delayedFirstProgressTimers = new Set();",
        "let delayedTotalTimerCount = 0;",
        "let delayedFetchRejectionFirstProgress = false;",
        "let stalledCapacityTerminalBody = false;",
        "let stalledReasoningTerminalBody = false;",
        "let stalledExpectedTerminationBody = false;",
        "const stalledExpectedTerminationModelFinalizes = new Set();",
        "let stalledRateLimitHeaderCopy = false;",
        "let stalledStreamHeaderCopy = false;",
        "let stalledTerminationHeaderCopy = false;",
        "global.setTimeout = function patchedSetTimeout(callback, delay, ...args) {",
        "  const numericDelay = Number(delay);",
        "  if (numericDelay >= 35 && numericDelay <= 40 && !delayedFetchRejectionFirstProgress) {",
        "    delayedFetchRejectionFirstProgress = true;",
        "    return originalSetTimeout(() => {",
        "      callback(...args);",
        "      const releaseAt = Date.now() + 40;",
        "      while (Date.now() < releaseAt) {}",
        "    }, delay);",
        "  }",
        "  if (numericDelay >= 300 && numericDelay <= 550) {",
        "    return originalSetTimeout(callback, 800, ...args);",
        "  }",
        "  const delayedFirstProgressBucket = numericDelay >= 43 && numericDelay <= 45",
        "    ? 45",
        "    : numericDelay >= 46 && numericDelay <= 47",
        "      ? 47",
        "      : numericDelay >= 198 && numericDelay <= 200",
        "        ? 200",
        "        : null;",
        "  if (delayedFirstProgressBucket && !delayedFirstProgressTimers.has(delayedFirstProgressBucket)) {",
        "    delayedFirstProgressTimers.add(delayedFirstProgressBucket);",
        "    return originalSetTimeout(callback, delayedFirstProgressBucket === 200 ? 500 : 200, ...args);",
        "  }",
        "  if (delayedTotalTimerCount < 9 && numericDelay >= 55 && numericDelay <= 70) {",
        "    delayedTotalTimerCount += 1;",
        "    return originalSetTimeout(callback, 200, ...args);",
        "  }",
        "  return originalSetTimeout(callback, delay, ...args);",
        "};",
        "JSON.stringify = function patchedJsonStringify(value, ...args) {",
        "  const result = Reflect.apply(originalJsonStringify, JSON, [value, ...args]);",
        "  const code = value?.error?.code;",
        "  if (!stalledCapacityTerminalBody && code === 'upstream_capacity_policy_triggered') {",
        "    stalledCapacityTerminalBody = true;",
        "    const releaseAt = Date.now() + 100;",
        "    while (Date.now() < releaseAt) {}",
        "  }",
        "  if (!stalledReasoningTerminalBody && code === 'reasoning_guard_triggered') {",
        "    stalledReasoningTerminalBody = true;",
        "    const releaseAt = Date.now() + 100;",
        "    while (Date.now() < releaseAt) {}",
        "  }",
        "  if (!stalledExpectedTerminationBody && code === 'gateway_error' && value?.error?.message === 'upstream stream terminated before completion') {",
        "    stalledExpectedTerminationBody = true;",
        "    const releaseAt = Date.now() + 100;",
        "    while (Date.now() < releaseAt) {}",
        "  }",
        "  return result;",
        "};",
        "WeakSet.prototype.add = function patchedWeakSetAdd(value) {",
        "  const result = Reflect.apply(originalWeakSetAdd, this, [value]);",
        "  const model = value?.effectiveLocalModel;",
        "  if (model === 'gpt-5.5-termination-first-progress-fault' && !stalledExpectedTerminationModelFinalizes.has(model)) {",
        "    stalledExpectedTerminationModelFinalizes.add(model);",
        "    const releaseAt = Date.now() + 100;",
        "    while (Date.now() < releaseAt) {}",
        "  }",
        "  return result;",
        "};",
        "Headers.prototype.entries = function patchedHeadersEntries() {",
        "  if (!stalledRateLimitHeaderCopy && this.get('x-upstream-test') === 'responses-http-429' && new Error().stack.includes('copyHeadersToClient')) {",
        "    stalledRateLimitHeaderCopy = true;",
        "    const releaseAt = Date.now() + 100;",
        "    while (Date.now() < releaseAt) {}",
        "  }",
        "  if (!stalledStreamHeaderCopy && `${this.get('content-type') || ''}`.includes('x-test-header-copy-stall=1') && new Error().stack.includes('copyHeadersToClient')) {",
        "    stalledStreamHeaderCopy = true;",
        "    const releaseAt = Date.now() + 100;",
        "    while (Date.now() < releaseAt) {}",
        "  }",
        "  if (!stalledTerminationHeaderCopy && this.get('x-test-termination-header-copy-stall') === '1' && new Error().stack.includes('copyHeadersToClient')) {",
        "    stalledTerminationHeaderCopy = true;",
        "    const releaseAt = Date.now() + 100;",
        "    while (Date.now() < releaseAt) {}",
        "  }",
        "  return Reflect.apply(originalHeadersEntries, this, []);",
        "};",
        "let stalledNonStreamDeadlineParse = false;",
        "let stalledStreamDeadlineParse = false;",
        "let stalledNonStreamFirstProgressParse = false;",
        "let stalledEofFirstProgressParse = false;",
        "JSON.parse = function patchedJsonParse(value, ...args) {",
        "  const result = Reflect.apply(originalJsonParse, JSON, [value, ...args]);",
        "  const text = typeof value === 'string' ? value : '';",
        "  if (!stalledNonStreamDeadlineParse && text.includes('\\\"id\\\":\\\"resp_test\\\"') && text.includes('\\\"test_response_fault_marker\\\":\\\"non-stream-total-parse\\\"')) {",
        "    stalledNonStreamDeadlineParse = true;",
        "    const releaseAt = Date.now() + 100;",
        "    while (Date.now() < releaseAt) {}",
        "  }",
        "  if (!stalledStreamDeadlineParse && text.includes('\\\"type\\\":\\\"response.output_text.delta\\\"') && text.includes('stream-total-parse-marker')) {",
        "    stalledStreamDeadlineParse = true;",
        "    const releaseAt = Date.now() + 100;",
        "    while (Date.now() < releaseAt) {}",
        "  }",
        "  if (!stalledNonStreamFirstProgressParse && text.includes('\\\"id\\\":\\\"resp_test\\\"') && text.includes('non-stream-first-progress-parse')) {",
        "    stalledNonStreamFirstProgressParse = true;",
        "    const releaseAt = Date.now() + 100;",
        "    while (Date.now() < releaseAt) {}",
        "  }",
        "  if (!stalledEofFirstProgressParse && text.includes('\\\"type\\\":\\\"response.completed\\\"') && text.includes('eof-first-progress-parse')) {",
        "    stalledEofFirstProgressParse = true;",
        "    const releaseAt = Date.now() + 100;",
        "    while (Date.now() < releaseAt) {}",
        "  }",
        "  return result;",
        "};",
        "const originalBufferConcat = Buffer.concat;",
        "let stalledOversizedCandidate = false;",
        "Buffer.concat = function patchedBufferConcat(list, totalLength) {",
        "  const result = Reflect.apply(originalBufferConcat, Buffer, [list, totalLength]);",
        "  if (!stalledOversizedCandidate && Number(totalLength) >= 1024 * 1024 && new Error().stack.includes('parseSsePayloads')) {",
        "    stalledOversizedCandidate = true;",
        "    const releaseAt = Date.now() + 230;",
        "    while (Date.now() < releaseAt) {}",
        "  }",
        "  return result;",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      completionDeadlineConfigPath,
      JSON.stringify(
        {
          ...config,
          listen_port: completionDeadlineGatewayPort,
          intercept_rule_mode: "none",
          guard_retry_attempts: 0,
          latency_guard: {
            enabled: true,
            first_progress_timeout_ms: 45,
            first_progress_action: "return_502",
            total_timeout_ms: 0,
          },
          active_probe: { enabled: false },
        },
        null,
        2,
      ),
      "utf8",
    );
    let completionDeadlineGateway = null;
    try {
      completionDeadlineGateway = startGateway(
        completionDeadlineConfigPath,
        completionDeadlineLogPath,
        { nodeArgs: ["--require", completionDeadlineFaultPath] },
      );
      await waitForHealth(
        `http://127.0.0.1:${completionDeadlineGatewayPort}${config.health_path}`,
        { gateway: completionDeadlineGateway, logPath: completionDeadlineLogPath },
      );

      const terminalDeadlineConfigResponse = await fetch(
        `http://127.0.0.1:${completionDeadlineGatewayPort}/__codex_retry_gateway/api/config`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            intercept_rule_mode: "reasoning_tokens",
            reasoning_match_mode: "formula_518n_minus_2",
            reasoning_equals: [516],
            stream_action: "strict_502",
            intercept_streaming: true,
            intercept_non_streaming: true,
            guard_retry_attempts: 0,
            capacity_error_action: "return_502",
            http_429_action: "pass_through",
            latency_guard: {
              enabled: true,
              first_progress_timeout_ms: 0,
              first_progress_action: "return_502",
              total_timeout_ms: 70,
            },
          }),
        },
      );
      assert(terminalDeadlineConfigResponse.status === 200, "非流式终态 deadline 配置失败");

      const assertTerminalDeadlineWins = async ({ key, requestBody }) => {
        const response = await fetch(
          `http://127.0.0.1:${completionDeadlineGatewayPort}/responses`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ test_sequence_key: key, ...requestBody }),
          },
        );
        const body = await response.json();
        assert(
          response.status === 502 &&
            response.headers.get("x-codex-retry-gateway-reason") ===
              "upstream-total-timeout" &&
            body?.error?.code === "upstream_total_timeout",
          `${key} 在首次 writeHead 前跨过 total deadline 时必须由 timeout 收口: status=${response.status} body=${JSON.stringify(body)}`,
        );
        return { response, body };
      };

      const capacityInsightStatusBefore = await fetch(
        `http://127.0.0.1:${completionDeadlineGatewayPort}/__codex_retry_gateway/api/status`,
      ).then((response) => response.json());
      await assertTerminalDeadlineWins({
        key: "total-deadline-before-capacity-policy-502-write",
        requestBody: {
          model: "gpt-5.4",
          test_capacity_error_attempts: 1,
          test_retry_after: "0",
        },
      });
      const capacityInsightStatusAfter = await fetch(
        `http://127.0.0.1:${completionDeadlineGatewayPort}/__codex_retry_gateway/api/status`,
      ).then((response) => response.json());
      assert(
        (capacityInsightStatusAfter.model_insights?.local_model_counts?.["gpt-5.4"] || 0) ===
          (capacityInsightStatusBefore.model_insights?.local_model_counts?.["gpt-5.4"] || 0) + 1 &&
          capacityInsightStatusAfter.model_insights?.consistency?.total_checked ===
            capacityInsightStatusBefore.model_insights?.consistency?.total_checked + 1,
        `同一 timeout attempt 的模型洞察只能提交一次: ${JSON.stringify({
          before: capacityInsightStatusBefore.model_insights,
          after: capacityInsightStatusAfter.model_insights,
        })}`,
      );
      await assertTerminalDeadlineWins({
        key: "total-deadline-before-http-429-pass-through-write",
        requestBody: {
          test_http_429_attempts: 1,
          test_retry_after: "0",
        },
      });

      const streamHeaderDeadlineResponse = await readSseUntilClose(
        `http://127.0.0.1:${completionDeadlineGatewayPort}/responses`,
        {
          stream: true,
          test_sequence_key: "total-deadline-during-stream-header-copy",
          test_stream_text: "stream-header-copy",
          test_stream_chunk_delay_ms: 0,
          test_stream_response_content_type:
            "text/event-stream; charset=utf-8; x-test-header-copy-stall=1",
        },
      );
      assert(
        streamHeaderDeadlineResponse.status === 502 &&
          streamHeaderDeadlineResponse.headers.get("x-codex-retry-gateway-reason") ===
            "upstream-total-timeout" &&
          JSON.parse(streamHeaderDeadlineResponse.text)?.error?.code ===
            "upstream_total_timeout",
        `流式 header copy 跨过 total deadline 后必须在 writeHead 前返回 timeout 502: ${JSON.stringify(streamHeaderDeadlineResponse)}`,
      );
      await assertTerminalDeadlineWins({
        key: "total-deadline-before-reasoning-block-write",
        requestBody: {
          test_reasoning_tokens: 516,
        },
      });

      const fetchRejectionDeadlineConfigResponse = await fetch(
        `http://127.0.0.1:${completionDeadlineGatewayPort}/__codex_retry_gateway/api/config`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            intercept_rule_mode: "none",
            guard_retry_attempts: 0,
            latency_guard: {
              enabled: true,
              first_progress_timeout_ms: 40,
              first_progress_action: "return_502",
              total_timeout_ms: 60,
            },
          }),
        },
      );
      assert(fetchRejectionDeadlineConfigResponse.status === 200, "fetch rejection deadline 优先级配置失败");
      const fetchRejectionMetricsBefore = await fetch(
        `http://127.0.0.1:${completionDeadlineGatewayPort}/__codex_retry_gateway/api/status`,
      ).then((response) => response.json());
      const fetchRejectionDeadlineResponse = await readSseUntilClose(
        `http://127.0.0.1:${completionDeadlineGatewayPort}/responses`,
        {
          stream: true,
          test_sequence_key: "total-deadline-overrides-first-progress-fetch-rejection",
          test_stream_initial_delay_ms: 200,
          test_stream_chunk_delay_ms: 10,
        },
      );
      const fetchRejectionDeadlineBody = JSON.parse(fetchRejectionDeadlineResponse.text);
      const fetchRejectionMetricsAfter = await fetch(
        `http://127.0.0.1:${completionDeadlineGatewayPort}/__codex_retry_gateway/api/status`,
      ).then((response) => response.json());
      assert(
        fetchRejectionDeadlineResponse.status === 502 &&
          fetchRejectionDeadlineResponse.headers.get("x-codex-retry-gateway-reason") ===
            "upstream-total-timeout" &&
          fetchRejectionDeadlineBody?.error?.code === "upstream_total_timeout" &&
          fetchRejectionMetricsAfter.metrics.total_timeout_count ===
            fetchRejectionMetricsBefore.metrics.total_timeout_count + 1 &&
          fetchRejectionMetricsAfter.metrics.first_progress_timeout_count ===
            fetchRejectionMetricsBefore.metrics.first_progress_timeout_count &&
          fetchRejectionMetricsAfter.metrics.failed_proxy_request_count ===
            fetchRejectionMetricsBefore.metrics.failed_proxy_request_count,
        `fetch rejection 收口时已过 total deadline，必须覆盖较早的 first-progress phase: ${JSON.stringify({
          response: fetchRejectionDeadlineResponse,
          body: fetchRejectionDeadlineBody,
          before: fetchRejectionMetricsBefore.metrics,
          after: fetchRejectionMetricsAfter.metrics,
        })}`,
      );

      const nonStreamFirstProgressParseConfigResponse = await fetch(
        `http://127.0.0.1:${completionDeadlineGatewayPort}/__codex_retry_gateway/api/config`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            intercept_rule_mode: "none",
            guard_retry_attempts: 0,
            latency_guard: {
              enabled: true,
              first_progress_timeout_ms: 41,
              first_progress_action: "return_502",
              total_timeout_ms: 0,
            },
          }),
        },
      );
      assert(nonStreamFirstProgressParseConfigResponse.status === 200, "非流式首 progress 解析边界配置失败");
      const nonStreamFirstProgressParseResponse = await fetch(
        `http://127.0.0.1:${completionDeadlineGatewayPort}/responses`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            test_sequence_key: "first-progress-crossed-during-non-stream-parse",
            test_response_fault_marker: "non-stream-first-progress-parse",
          }),
        },
      );
      const nonStreamFirstProgressParseBody = await nonStreamFirstProgressParseResponse.json();
      assert(
        nonStreamFirstProgressParseResponse.status === 502 &&
          nonStreamFirstProgressParseResponse.headers.get("x-codex-retry-gateway-reason") ===
            "upstream-first-progress-timeout" &&
          nonStreamFirstProgressParseBody?.error?.code === "upstream_first_progress_timeout",
        `非流式语义解析跨过首 progress deadline 后不得因提前清 timer 返回 200: status=${nonStreamFirstProgressParseResponse.status} body=${JSON.stringify(nonStreamFirstProgressParseBody)}`,
      );

      const eofFirstProgressParseConfigResponse = await fetch(
        `http://127.0.0.1:${completionDeadlineGatewayPort}/__codex_retry_gateway/api/config`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            intercept_rule_mode: "none",
            guard_retry_attempts: 0,
            latency_guard: {
              enabled: true,
              first_progress_timeout_ms: 42,
              first_progress_action: "return_502",
              total_timeout_ms: 0,
            },
          }),
        },
      );
      assert(eofFirstProgressParseConfigResponse.status === 200, "EOF 首 progress 解析边界配置失败");
      const eofFirstProgressParseResponse = await readSseUntilClose(
        `http://127.0.0.1:${completionDeadlineGatewayPort}/responses`,
        {
          stream: true,
          test_sequence_key: "first-progress-crossed-during-eof-parse",
          test_reasoning_tokens: 128,
          test_include_final_answer_only: true,
          test_stream_only_completed_event: true,
          test_stream_event_separator: "\r\r",
          test_stream_chunk_delay_ms: 0,
          test_response_fault_marker: "eof-first-progress-parse",
        },
      );
      const eofFirstProgressParseBody = JSON.parse(eofFirstProgressParseResponse.text);
      assert(
        eofFirstProgressParseResponse.status === 502 &&
          eofFirstProgressParseResponse.headers.get("x-codex-retry-gateway-reason") ===
            "upstream-first-progress-timeout" &&
          eofFirstProgressParseBody?.error?.code === "upstream_first_progress_timeout",
        `EOF SSE 语义解析跨过首 progress deadline 后不得因提前清 timer 返回 200: ${JSON.stringify(eofFirstProgressParseResponse)}`,
      );

      const restoreFirstProgressCompletionConfigResponse = await fetch(
        `http://127.0.0.1:${completionDeadlineGatewayPort}/__codex_retry_gateway/api/config`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            intercept_rule_mode: "none",
            guard_retry_attempts: 0,
            latency_guard: {
              enabled: true,
              first_progress_timeout_ms: 45,
              first_progress_action: "return_502",
              total_timeout_ms: 0,
            },
          }),
        },
      );
      assert(restoreFirstProgressCompletionConfigResponse.status === 200, "恢复首 progress 完成路径配置失败");
      const delayedFirstProgressResponse = await readSseUntilClose(
        `http://127.0.0.1:${completionDeadlineGatewayPort}/responses`,
        {
          stream: true,
          test_sequence_key: "delayed-first-progress-timer-wall-clock",
          test_stream_initial_delay_ms: 80,
          test_stream_chunk_delay_ms: 10,
        },
      );
      assert(
        delayedFirstProgressResponse.status === 502 &&
          delayedFirstProgressResponse.headers.get("x-codex-retry-gateway-reason") ===
            "upstream-first-progress-timeout",
        "首 progress timer 回调延迟时仍必须按墙钟执行硬阈值",
      );

      const delayedMetadataConfigResponse = await fetch(
        `http://127.0.0.1:${completionDeadlineGatewayPort}/__codex_retry_gateway/api/config`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            intercept_rule_mode: "none",
            guard_retry_attempts: 0,
            latency_guard: {
              enabled: true,
              first_progress_timeout_ms: 500,
              first_progress_action: "return_502",
              total_timeout_ms: 0,
            },
          }),
        },
      );
      assert(delayedMetadataConfigResponse.status === 200, "延迟 metadata timer 配置失败");
      const delayedMetadataStartedAt = Date.now();
      const delayedMetadataResponse = await readSseUntilClose(
        `http://127.0.0.1:${completionDeadlineGatewayPort}/responses`,
        {
          stream: true,
          test_sequence_key: "delayed-first-progress-metadata-wall-clock",
          test_include_stream_lifecycle: true,
          test_stream_lifecycle_repeat_count: 60,
          test_stream_initial_delay_ms: 0,
          test_stream_chunk_delay_ms: 10,
          test_record_stream_chunk_sent_at_ms: true,
        },
      );
      const delayedMetadataElapsedMs = Date.now() - delayedMetadataStartedAt;
      const delayedMetadataUpstreamRequest = upstream.responseRequests.find(
        (entry) => entry.body?.test_sequence_key === "delayed-first-progress-metadata-wall-clock",
      );
      const delayedMetadataChunkTimes =
        delayedMetadataUpstreamRequest?.stream_chunk_sent_at_ms || [];
      const delayedMetadataAnalytics = await fetch(
        `http://127.0.0.1:${completionDeadlineGatewayPort}/__codex_retry_gateway/api/analytics/reasoning`,
      ).then((response) => response.json());
      const delayedMetadataSample = (delayedMetadataAnalytics.recent_samples || []).find(
        (sample) =>
          `${sample.request_payload_excerpt || ""}`.includes(
            "delayed-first-progress-metadata-wall-clock",
          ),
      );
      const delayedMetadataDeadlineAtMs = Number.isFinite(
        delayedMetadataSample?.upstream_fetch_started_at_ms,
      )
        ? delayedMetadataSample.upstream_fetch_started_at_ms + 500
        : null;
      assert(
        delayedMetadataResponse.status === 502 &&
          delayedMetadataElapsedMs >= 500 &&
          delayedMetadataElapsedMs < 700 &&
          delayedMetadataChunkTimes.length >= 2 &&
          Number.isFinite(delayedMetadataDeadlineAtMs) &&
          delayedMetadataChunkTimes.some(
            (sentAtMs) => sentAtMs < delayedMetadataDeadlineAtMs,
          ) &&
          delayedMetadataChunkTimes.some(
            (sentAtMs) => sentAtMs >= delayedMetadataDeadlineAtMs,
          ),
        `前序 lifecycle 必须实际在 deadline 前发送，后续 chunk 首次跨线并立即超时: ${JSON.stringify({
          status: delayedMetadataResponse.status,
          elapsed_ms: delayedMetadataElapsedMs,
          upstream_received_at_ms: delayedMetadataUpstreamRequest?.received_at_ms ?? null,
          upstream_fetch_started_at_ms: delayedMetadataSample?.upstream_fetch_started_at_ms ?? null,
          deadline_at_ms: delayedMetadataDeadlineAtMs,
          stream_chunk_sent_at_ms: delayedMetadataChunkTimes,
        })}`,
      );
      assert(
        Number.isFinite(delayedMetadataSample?.first_stream_chunk_at_ms) &&
          Number.isFinite(delayedMetadataSample?.upstream_fetch_started_at_ms) &&
          delayedMetadataSample.first_stream_chunk_at_ms -
            delayedMetadataSample.upstream_fetch_started_at_ms < 500 &&
          delayedMetadataSample.timeout_phase === "first_progress",
        `lifecycle 反例必须由 gateway 自身时钟证明前序 chunk 已在 deadline 前处理: ${JSON.stringify(delayedMetadataSample)}`,
      );

      const synchronousDeadlineConfigResponse = await fetch(
        `http://127.0.0.1:${completionDeadlineGatewayPort}/__codex_retry_gateway/api/config`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            intercept_rule_mode: "none",
            guard_retry_attempts: 0,
            latency_guard: {
              enabled: true,
              first_progress_timeout_ms: 0,
              first_progress_action: "return_502",
              total_timeout_ms: 70,
            },
          }),
        },
      );
      assert(synchronousDeadlineConfigResponse.status === 200, "同步处理跨 total deadline 配置失败");

      const stalledNonStreamParseResponse = await fetch(
        `http://127.0.0.1:${completionDeadlineGatewayPort}/responses`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            test_sequence_key: "total-deadline-crossed-during-non-stream-parse",
            test_response_fault_marker: "non-stream-total-parse",
          }),
        },
      );
      const stalledNonStreamParseBody = await stalledNonStreamParseResponse.json();
      assert(
        stalledNonStreamParseResponse.status === 502 &&
          stalledNonStreamParseBody?.error?.code === "upstream_total_timeout",
        `非流式同步解析跨过 total deadline 后不得写出 200: status=${stalledNonStreamParseResponse.status} body=${JSON.stringify(stalledNonStreamParseBody)}`,
      );

      const stalledStreamParseResponse = await readSseUntilClose(
        `http://127.0.0.1:${completionDeadlineGatewayPort}/responses`,
        {
          stream: true,
          test_sequence_key: "total-deadline-crossed-during-stream-parse",
          test_stream_text: "stream-total-parse-marker",
          test_stream_chunk_delay_ms: 0,
        },
      );
      assert(
        stalledStreamParseResponse.status === 502 &&
          stalledStreamParseResponse.headers.get("x-codex-retry-gateway-reason") ===
            "upstream-total-timeout",
        `流式同步解析跨过 total deadline 后不得写出 200: status=${stalledStreamParseResponse.status}`,
      );

      const lateTerminationResponse = await readSseUntilClose(
        `http://127.0.0.1:${completionDeadlineGatewayPort}/responses`,
        {
          stream: true,
          test_sequence_key: "total-deadline-before-reader-termination",
          test_force_terminate_before_progress: true,
          test_terminate_delay_ms: 100,
        },
      );
      assert(
        lateTerminationResponse.status === 502 &&
          lateTerminationResponse.headers.get("x-codex-retry-gateway-reason") ===
            "upstream-total-timeout",
        `reader 在 total deadline 后异常时必须按 timeout 收口: status=${lateTerminationResponse.status}`,
      );

      const terminationPreparationTotalConfigResponse = await fetch(
        `http://127.0.0.1:${completionDeadlineGatewayPort}/__codex_retry_gateway/api/config`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            intercept_rule_mode: "reasoning_tokens",
            reasoning_match_mode: "formula_518n_minus_2",
            intercept_streaming: true,
            stream_action: "strict_502",
            guard_retry_attempts: 0,
            latency_guard: {
              enabled: true,
              first_progress_timeout_ms: 0,
              first_progress_action: "return_502",
              total_timeout_ms: 70,
            },
          }),
        },
      );
      assert(
        terminationPreparationTotalConfigResponse.status === 200,
        "termination 终态准备跨 total deadline 配置失败",
      );
      const terminationPreparationTotalKey =
        "total-deadline-crossed-during-expected-termination-body";
      const terminationPreparationTotalResponse = await readSseUntilClose(
        `http://127.0.0.1:${completionDeadlineGatewayPort}/responses`,
        {
          stream: true,
          test_sequence_key: terminationPreparationTotalKey,
          test_force_terminate_before_progress: true,
          test_terminate_delay_ms: 10,
        },
      );
      const terminationPreparationTotalBody = JSON.parse(
        terminationPreparationTotalResponse.text,
      );
      assert(
        terminationPreparationTotalResponse.status === 502 &&
          terminationPreparationTotalResponse.headers.get(
            "x-codex-retry-gateway-reason",
          ) === "upstream-total-timeout" &&
          terminationPreparationTotalBody?.error?.code === "upstream_total_timeout",
        `预期 reader 终止后的错误体准备跨过 total deadline 时不得返回普通 termination 502: ${JSON.stringify(terminationPreparationTotalResponse)}`,
      );

      const terminationPreparationFirstProgressConfigResponse = await fetch(
        `http://127.0.0.1:${completionDeadlineGatewayPort}/__codex_retry_gateway/api/config`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            intercept_rule_mode: "none",
            guard_retry_attempts: 0,
            latency_guard: {
              enabled: true,
              first_progress_timeout_ms: 70,
              first_progress_action: "return_502",
              total_timeout_ms: 0,
            },
          }),
        },
      );
      assert(
        terminationPreparationFirstProgressConfigResponse.status === 200,
        "termination 终态准备跨 first-progress deadline 配置失败",
      );
      const terminationPreparationFirstProgressKey =
        "first-progress-crossed-during-expected-termination-finalize";
      const terminationPreparationFirstProgressResponse = await readSseUntilClose(
        `http://127.0.0.1:${completionDeadlineGatewayPort}/responses`,
        {
          stream: true,
          model: "gpt-5.5-termination-first-progress-fault",
          test_sequence_key: terminationPreparationFirstProgressKey,
          test_force_terminate_before_progress: true,
          test_terminate_delay_ms: 10,
        },
      );
      const terminationPreparationFirstProgressBody =
        terminationPreparationFirstProgressResponse.status === 502
          ? JSON.parse(terminationPreparationFirstProgressResponse.text)
          : null;
      const terminationPreparationAnalytics = await fetch(
        `http://127.0.0.1:${completionDeadlineGatewayPort}/__codex_retry_gateway/api/analytics/reasoning`,
      ).then((response) => response.json());
      const terminationPreparationTotalSample = (
        terminationPreparationAnalytics.recent_samples || []
      ).find((sample) =>
        `${sample.request_payload_excerpt || ""}`.includes(terminationPreparationTotalKey),
      );
      const terminationPreparationFirstProgressSample = (
        terminationPreparationAnalytics.recent_samples || []
      ).find((sample) =>
        `${sample.request_payload_excerpt || ""}`.includes(
          terminationPreparationFirstProgressKey,
        ),
      );
      assert(
        terminationPreparationFirstProgressResponse.status === 502 &&
          terminationPreparationFirstProgressResponse.headers.get(
            "x-codex-retry-gateway-reason",
          ) === "upstream-first-progress-timeout" &&
          terminationPreparationFirstProgressBody?.error?.code ===
            "upstream_first_progress_timeout" &&
          terminationPreparationTotalSample?.timeout_phase === "total" &&
          terminationPreparationTotalSample?.upstream_stream_terminated === true &&
          terminationPreparationTotalSample?.final_action === "total_timeout_returned_502" &&
          terminationPreparationFirstProgressSample?.timeout_phase === "first_progress" &&
          terminationPreparationFirstProgressSample?.upstream_stream_terminated === true &&
          terminationPreparationFirstProgressSample?.final_action ===
            "first_progress_timeout_returned_502",
        `预期 reader 终止后的模型归档跨过 first-progress deadline 时不得 flush lifecycle 200，且两条路径都必须落 timeout outcome: ${JSON.stringify({
          total_response: terminationPreparationTotalResponse,
          total_sample: terminationPreparationTotalSample,
          first_progress_response: terminationPreparationFirstProgressResponse,
          first_progress_sample: terminationPreparationFirstProgressSample,
        })}`,
      );

      const terminationClientTimingConfigResponse = await fetch(
        `http://127.0.0.1:${completionDeadlineGatewayPort}/__codex_retry_gateway/api/config`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            intercept_rule_mode: "none",
            guard_retry_attempts: 0,
            latency_guard: {
              enabled: true,
              first_progress_timeout_ms: 500,
              first_progress_action: "return_502",
              total_timeout_ms: 0,
            },
          }),
        },
      );
      assert(
        terminationClientTimingConfigResponse.status === 200,
        "termination 客户端首写时序配置失败",
      );
      const terminationClientTimingKey = "expected-termination-client-write-after-headers";
      const terminationClientTimingResponse = await readSseUntilClose(
        `http://127.0.0.1:${completionDeadlineGatewayPort}/responses`,
        {
          stream: true,
          test_sequence_key: terminationClientTimingKey,
          test_force_terminate_before_progress: true,
          test_terminate_delay_ms: 10,
          test_termination_header_copy_stall: true,
        },
      );
      const terminationClientTimingAnalytics = await fetch(
        `http://127.0.0.1:${completionDeadlineGatewayPort}/__codex_retry_gateway/api/analytics/reasoning`,
      ).then((response) => response.json());
      const terminationClientTimingSample = (
        terminationClientTimingAnalytics.recent_samples || []
      ).find((sample) =>
        `${sample.request_payload_excerpt || ""}`.includes(terminationClientTimingKey),
      );
      assert(
        terminationClientTimingResponse.status === 200 &&
          terminationClientTimingResponse.headers.get(
            "x-test-termination-header-copy-stall",
          ) === "1" &&
          terminationClientTimingResponse.text.includes("response.created") &&
          Number.isFinite(terminationClientTimingSample?.client_headers_sent_at_ms) &&
          Number.isFinite(terminationClientTimingSample?.client_first_write_at_ms) &&
          terminationClientTimingSample.client_headers_sent_at_ms -
            terminationClientTimingSample.upstream_fetch_started_at_ms >= 90 &&
          terminationClientTimingSample.client_headers_sent_at_ms <=
            terminationClientTimingSample.client_first_write_at_ms,
        `同步 header copy 后的客户端首写时间不得早于发头时间: ${JSON.stringify({
          response: terminationClientTimingResponse,
          sample: terminationClientTimingSample,
        })}`,
      );

      const inspectionPriorityConfigResponse = await fetch(
        `http://127.0.0.1:${completionDeadlineGatewayPort}/__codex_retry_gateway/api/config`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            intercept_rule_mode: "reasoning_tokens",
            reasoning_match_mode: "formula_518n_minus_2",
            intercept_streaming: true,
            stream_action: "strict_502",
            guard_retry_attempts: 0,
            latency_guard: {
              enabled: true,
              first_progress_timeout_ms: 200,
              first_progress_action: "return_502",
              total_timeout_ms: 0,
            },
          }),
        },
      );
      assert(inspectionPriorityConfigResponse.status === 200, "检查上限优先级配置失败");
      const inspectionPriorityResponse = await readSseUntilClose(
        `http://127.0.0.1:${completionDeadlineGatewayPort}/responses`,
        {
          stream: true,
          test_sequence_key: "inspection-limit-before-late-first-progress",
          test_reasoning_tokens: 516,
          test_stream_only_completed_event: true,
          test_stream_completed_padding_bytes: 1024 * 1024 + 64 * 1024,
          test_stream_response_content_type: "text/plain; charset=utf-8",
          test_stream_chunk_delay_ms: 0,
        },
      );
      assert(
        inspectionPriorityResponse.status === 502 &&
          inspectionPriorityResponse.headers.get("x-codex-retry-gateway-reason") ===
            "response-inspection-limit-exceeded",
        "同一 chunk 同时发生候选超限与延迟 first-progress 时必须先走检查失败",
      );

      const delayedTotalConfigResponse = await fetch(
        `http://127.0.0.1:${completionDeadlineGatewayPort}/__codex_retry_gateway/api/config`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            intercept_rule_mode: "none",
            guard_retry_attempts: 0,
            latency_guard: {
              enabled: true,
              first_progress_timeout_ms: 0,
              first_progress_action: "return_502",
              total_timeout_ms: 70,
            },
          }),
        },
      );
      assert(delayedTotalConfigResponse.status === 200, "延迟 total timer 配置失败");
      const delayedTotalResponse = await fetch(
        `http://127.0.0.1:${completionDeadlineGatewayPort}/responses`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            test_sequence_key: "delayed-total-timer-wall-clock",
            test_json_body_delay_ms: 100,
          }),
        },
      );
      const delayedTotalBody = await delayedTotalResponse.json();
      assert(
        delayedTotalResponse.status === 502 &&
          delayedTotalResponse.headers.get("x-codex-retry-gateway-reason") ===
            "upstream-total-timeout" &&
          delayedTotalBody?.error?.code === "upstream_total_timeout",
        "total timer 回调延迟时 body 完成路径仍必须按墙钟执行硬 deadline",
      );
    } finally {
      await stopGateway(completionDeadlineGateway);
    }

    const bufferLimitGatewayPort = await getFreePort();
    const bufferLimitConfigPath = path.join(tempRoot, "buffer-limit-config.json");
    const bufferLimitLogPath = path.join(tempRoot, "buffer-limit-gateway.log");
    const bufferLimitFaultPath = path.join(tempRoot, "buffer-limit-fault.cjs");
    await writeFile(
      bufferLimitFaultPath,
      [
        "const originalPush = Array.prototype.push;",
        "Array.prototype.push = function guardedPush(...items) {",
        "  if (this.length > 0 && this.every((item) => Buffer.isBuffer(item)) && items.every((item) => Buffer.isBuffer(item))) {",
        "    const bufferedBytes = this.reduce((sum, item) => sum + item.length, 0);",
        "    const incomingBytes = items.reduce((sum, item) => sum + item.length, 0);",
        "    if (bufferedBytes + incomingBytes > 1024 * 1024) {",
        "      throw new Error('pre-progress buffer exceeded hard limit before flush');",
        "    }",
        "  }",
        "  return Reflect.apply(originalPush, this, items);",
        "};",
        "const originalSplit = String.prototype.split;",
        "String.prototype.split = function guardedSplit(separator, ...args) {",
        "  const value = String(this);",
        "  if (separator instanceof RegExp && Buffer.byteLength(value, 'utf8') > 1024 * 1024) {",
        "    throw new Error('SSE parser buffer exceeded hard limit before framing');",
        "  }",
        "  return Reflect.apply(originalSplit, value, [separator, ...args]);",
        "};",
        "const originalByteLength = Buffer.byteLength;",
        "Buffer.byteLength = function guardedByteLength(value, ...args) {",
        "  const length = Reflect.apply(originalByteLength, Buffer, [value, ...args]);",
        "  if (length > 1024 * 1024 && new Error().stack.includes('parseSsePayloads')) {",
        "    throw new Error('SSE parser state exceeded hard limit before discard');",
        "  }",
        "  return length;",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      bufferLimitConfigPath,
      JSON.stringify(
        {
          ...config,
          listen_port: bufferLimitGatewayPort,
          intercept_rule_mode: "none",
          latency_guard: {
            enabled: true,
            first_progress_timeout_ms: 5000,
            first_progress_action: "return_502",
            total_timeout_ms: 0,
          },
          active_probe: { enabled: false },
        },
        null,
        2,
      ),
      "utf8",
    );
    let bufferLimitGateway = null;
    try {
      bufferLimitGateway = startGateway(
        bufferLimitConfigPath,
        bufferLimitLogPath,
        { nodeArgs: ["--require", bufferLimitFaultPath] },
      );
      await waitForHealth(
        `http://127.0.0.1:${bufferLimitGatewayPort}${config.health_path}`,
        { gateway: bufferLimitGateway, logPath: bufferLimitLogPath },
      );
      const bufferLimitKey = "latency-pre-progress-buffer-hard-limit";
      const bufferLimitResponse = await readSseUntilClose(
        `http://127.0.0.1:${bufferLimitGatewayPort}/responses`,
        {
          stream: true,
          test_sequence_key: bufferLimitKey,
          test_include_stream_lifecycle: true,
          test_stream_pre_progress_metadata_bytes: 1024 * 1024 + 64 * 1024,
          test_stream_text: "buffer-limit-ok",
        },
      );
      assert(
        bufferLimitResponse.status === 200 &&
          bufferLimitResponse.text.includes("buffer-limit-ok"),
        `首 progress 前导缓冲不得瞬时越过 1 MiB 硬上限: status=${bufferLimitResponse.status} body=${bufferLimitResponse.text.slice(0, 200)}`,
      );
      const bufferLimitAnalytics = await fetch(
        `http://127.0.0.1:${bufferLimitGatewayPort}/__codex_retry_gateway/api/analytics/reasoning`,
      ).then((response) => response.json());
      const bufferLimitSample = (bufferLimitAnalytics.recent_samples || []).find((sample) =>
        `${sample.request_payload_excerpt || ""}`.includes(bufferLimitKey),
      );
      assert(
        bufferLimitSample?.timeout_response_control_lost === true &&
          bufferLimitSample?.response_forwarding_started === true &&
          bufferLimitSample?.failure_summary?.code === "response_inspection_limit_exceeded",
        `触及前导缓冲上限后应记录响应控制权已交给客户端: ${JSON.stringify(bufferLimitSample)}`,
      );
    } finally {
      await stopGateway(bufferLimitGateway);
    }

    await configureLatencyGuard({ totalTimeoutMs: 80 });
    const nonStreamBodyTimeoutKey = "latency-non-stream-body-stall";
    const nonStreamBodyTimeoutResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          test_sequence_key: nonStreamBodyTimeoutKey,
          test_reasoning_tokens: 128,
          test_json_body_delay_ms: 250,
        }),
      },
    );
    const nonStreamBodyTimeoutBody = await nonStreamBodyTimeoutResponse.json();
    assert(
      nonStreamBodyTimeoutResponse.status === 502 &&
        nonStreamBodyTimeoutResponse.headers.get("x-codex-retry-gateway-reason") ===
          "upstream-total-timeout" &&
        nonStreamBodyTimeoutBody?.error?.code === "upstream_total_timeout",
      "非流式 body stall 未被总 deadline 取消",
    );

    await configureLatencyGuard({
      guardRetryAttempts: 3,
      firstProgressTimeoutMs: 60,
      firstProgressAction: "retry_then_502",
      totalTimeoutMs: 100,
    });
    const crossRetryDeadlineKey = "latency-total-deadline-cross-retry";
    const crossRetryDeadlineResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        stream: true,
        test_sequence_key: crossRetryDeadlineKey,
        test_reasoning_sequence: [128, 128, 128],
        test_stream_initial_delay_ms_sequence: [180, 180, 0],
      },
    );
    assert(
      crossRetryDeadlineResponse.status === 502 &&
        crossRetryDeadlineResponse.headers.get("x-codex-retry-gateway-reason") ===
          "upstream-total-timeout" &&
        upstream.responseRequests.filter(
          (entry) => entry.body?.test_sequence_key === crossRetryDeadlineKey,
        ).length === 2,
      "总 deadline 被内部重试重置，或 deadline 后仍创建了新 attempt",
    );

    await configureLatencyGuard({ totalTimeoutMs: 100 });
    const forwardedTimeoutKey = "latency-timeout-after-forward";
    const forwardedTimeoutResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        stream: true,
        test_sequence_key: forwardedTimeoutKey,
        test_reasoning_tokens: 128,
        test_stream_text: "forwarded-before-timeout",
        test_stream_pause_after_output_ms: 350,
        test_stream_chunk_delay_ms: 10,
      },
    );
    assert(
      forwardedTimeoutResponse.status === 200 &&
        forwardedTimeoutResponse.text.includes("forwarded-before-timeout") &&
        forwardedTimeoutResponse.closedByError &&
        upstream.responseRequests.filter(
          (entry) => entry.body?.test_sequence_key === forwardedTimeoutKey,
        ).length === 1,
      "已透传后总超时只能断连，不能重试或改写 502",
    );
    const forwardedTimeoutAnalytics = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning`,
    ).then((response) => response.json());
    const forwardedTimeoutSample = (forwardedTimeoutAnalytics.recent_samples || []).find((sample) =>
      `${sample.request_payload_excerpt || ""}`.includes(forwardedTimeoutKey),
    );
    assert(
      forwardedTimeoutSample?.final_action === "timeout_disconnected_after_forward" &&
        forwardedTimeoutSample?.timeout_phase === "total" &&
        forwardedTimeoutSample?.response_forwarding_started === true,
      `已透传后的超时样本未明确记录断连事实: ${JSON.stringify(forwardedTimeoutSample)}`,
    );

    const clientDisconnectConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_rule_mode: "none",
          latency_guard: {
            enabled: false,
            first_progress_timeout_ms: 0,
            first_progress_action: "return_502",
            total_timeout_ms: 0,
          },
        }),
      },
    );
    assert(clientDisconnectConfigResponse.status === 200, "客户端断连场景配置失败");
    const clientDisconnectKey = "client-disconnect-after-first-output";
    const clientDisconnectController = new AbortController();
    const clientDisconnectResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stream: true,
          test_sequence_key: clientDisconnectKey,
          test_stream_text: "client-will-disconnect",
          test_stream_pause_after_output_ms: 350,
        }),
        signal: clientDisconnectController.signal,
      },
    );
    const clientDisconnectReader = clientDisconnectResponse.body.getReader();
    const clientDisconnectFirstRead = await clientDisconnectReader.read();
    assert(
      !clientDisconnectFirstRead.done && clientDisconnectFirstRead.value?.length > 0,
      "客户端断连测试未先收到首个输出",
    );
    clientDisconnectController.abort();
    try {
      await clientDisconnectReader.read();
    } catch {
      // AbortController 主动取消后 reader 抛 AbortError 属于预期。
    }
    let clientDisconnectSample = null;
    const clientDisconnectSampleDeadline = Date.now() + 3000;
    while (!clientDisconnectSample && Date.now() < clientDisconnectSampleDeadline) {
      const payload = await fetch(
        `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning`,
      ).then((response) => response.json());
      clientDisconnectSample = (payload.recent_samples || []).find((sample) =>
        `${sample.request_payload_excerpt || ""}`.includes(clientDisconnectKey),
      );
      if (!clientDisconnectSample) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert(
      clientDisconnectSample?.final_action === "client_disconnected" &&
        clientDisconnectSample?.response_forwarding_started === true &&
        upstream.responseRequests.filter(
          (entry) => entry.body?.test_sequence_key === clientDisconnectKey,
        ).length === 1,
      `客户端主动断连未被独立收口: ${JSON.stringify(clientDisconnectSample)}`,
    );

    const observedDisconnectConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_rule_mode: "reasoning_tokens",
          reasoning_match_mode: "formula_518n_minus_2",
          intercept_streaming: false,
          stream_action: "disconnect",
          latency_guard: {
            enabled: false,
            first_progress_timeout_ms: 0,
            first_progress_action: "return_502",
            total_timeout_ms: 0,
          },
        }),
      },
    );
    assert(observedDisconnectConfigResponse.status === 200, "observe-only 断连场景配置失败");
    const observedDisconnectKey = "observed-rule-match-client-disconnect";
    const observedDisconnectController = new AbortController();
    const observedDisconnectResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stream: true,
          test_sequence_key: observedDisconnectKey,
          test_reasoning_tokens: 516,
          test_stream_reasoning_in_output_chunk: true,
          test_stream_text: "observed-match-before-disconnect",
          test_stream_pause_after_output_ms: 350,
        }),
        signal: observedDisconnectController.signal,
      },
    );
    const observedDisconnectReader = observedDisconnectResponse.body.getReader();
    const observedDisconnectFirstRead = await observedDisconnectReader.read();
    assert(
      !observedDisconnectFirstRead.done && observedDisconnectFirstRead.value?.length > 0,
      "observe-only 断连测试未先收到规则命中 chunk",
    );
    observedDisconnectController.abort();
    try {
      await observedDisconnectReader.read();
    } catch {
      // 主动取消后 reader 抛错属于预期。
    }
    let observedDisconnectSample = null;
    const observedDisconnectDeadline = Date.now() + 3000;
    while (!observedDisconnectSample && Date.now() < observedDisconnectDeadline) {
      const payload = await fetch(
        `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning`,
      ).then((response) => response.json());
      observedDisconnectSample = (payload.recent_samples || []).find((sample) =>
        `${sample.request_payload_excerpt || ""}`.includes(observedDisconnectKey),
      );
      if (!observedDisconnectSample) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert(
      observedDisconnectSample?.final_action === "client_disconnected" &&
        observedDisconnectSample?.matched_current_rule === true &&
        observedDisconnectSample?.blocked_by_gateway === false,
      `observe-only 命中后断连样本必须保留命中事实: ${JSON.stringify(observedDisconnectSample)}`,
    );
    const restoreInterceptAfterObservedDisconnectResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_streaming: true,
          stream_action: "strict_502",
        }),
      },
    );
    assert(
      restoreInterceptAfterObservedDisconnectResponse.status === 200,
      "observe-only 断连用例后恢复流式拦截配置失败",
    );

    const strictParserConfig = {
      intercept_rule_mode: "reasoning_tokens",
      reasoning_match_mode: "formula_518n_minus_2",
      intercept_streaming: true,
      intercept_non_streaming: true,
      stream_action: "strict_502",
      guard_retry_attempts: 0,
      latency_guard: {
        enabled: false,
        first_progress_timeout_ms: 0,
        first_progress_action: "return_502",
        total_timeout_ms: 0,
      },
    };
    const strictParserConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(strictParserConfig),
      },
    );
    assert(strictParserConfigResponse.status === 200, "严格 SSE parser 场景配置失败");

    const mislabeledSseKey = "mislabeled-sse-reasoning-516";
    const mislabeledSseResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        stream: true,
        test_sequence_key: mislabeledSseKey,
        test_reasoning_tokens: 516,
        test_stream_reasoning_in_output_chunk: true,
        test_stream_response_content_type: "text/plain; charset=utf-8",
      },
    );
    assert(
      mislabeledSseResponse.status === 502 &&
        upstream.responseRequests.filter(
          (entry) => entry.body?.test_sequence_key === mislabeledSseKey,
        ).length === 1,
      `误标为 text/plain 的合法 SSE 不得绕过 516: status=${mislabeledSseResponse.status}`,
    );

    const bomSseKey = "bom-sse-reasoning-516";
    const bomSseResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        stream: true,
        test_sequence_key: bomSseKey,
        test_reasoning_tokens: 516,
        test_stream_only_completed_event: true,
        test_stream_prepend_bom: true,
      },
    );
    assert(
      bomSseResponse.status === 502,
      `UTF-8 BOM 后的首个 SSE 事件不得绕过 516: status=${bomSseResponse.status}`,
    );

    const mixedNewlineSseKey = "mixed-newline-sse-reasoning-516";
    const mixedNewlineSseResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        stream: true,
        test_sequence_key: mixedNewlineSseKey,
        test_reasoning_tokens: 516,
        test_stream_event_separator: "\n\r\n",
      },
    );
    assert(
      mixedNewlineSseResponse.status === 502,
      `混合换行 SSE 边界不得绕过 516: status=${mixedNewlineSseResponse.status}`,
    );

    const terminalCrSseKey = "terminal-cr-sse-reasoning-516";
    const terminalCrSseResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        stream: true,
        test_sequence_key: terminalCrSseKey,
        test_reasoning_tokens: 516,
        test_stream_only_completed_event: true,
        test_stream_event_separator: "\r\r",
      },
    );
    assert(
      terminalCrSseResponse.status === 502,
      `纯 CR 终态 SSE 在 EOF 时不得绕过 516: status=${terminalCrSseResponse.status}`,
    );

    const oversizedProtectedSseKey = "oversized-protected-sse-event";
    const oversizedProtectedSseResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        stream: true,
        test_sequence_key: oversizedProtectedSseKey,
        test_reasoning_tokens: 516,
        test_stream_completed_padding_bytes: 1024 * 1024 + 64 * 1024,
      },
    );
    let oversizedProtectedSseBody = null;
    try {
      oversizedProtectedSseBody = JSON.parse(oversizedProtectedSseResponse.text);
    } catch {
      oversizedProtectedSseBody = null;
    }
    assert(
      oversizedProtectedSseResponse.status === 502 &&
        oversizedProtectedSseResponse.headers.get("x-codex-retry-gateway-reason") ===
          "response-inspection-limit-exceeded" &&
        oversizedProtectedSseBody?.error?.code === "response_inspection_limit_exceeded",
      `严格保护下超大 SSE 事件不得静默放行: status=${oversizedProtectedSseResponse.status} body=${oversizedProtectedSseResponse.text.slice(0, 200)}`,
    );
    const oversizedProtectedAnalytics = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning`,
    ).then((response) => response.json());
    const oversizedProtectedSample = (oversizedProtectedAnalytics.recent_samples || []).find((sample) =>
      `${sample.request_payload_excerpt || ""}`.includes(oversizedProtectedSseKey),
    );
    assert(
      oversizedProtectedSample?.final_action === "response_inspection_limit_exceeded" &&
        oversizedProtectedSample?.blocked_by_gateway === true,
      `超大 SSE 检查失败必须详细落盘: ${JSON.stringify(oversizedProtectedSample)}`,
    );

    const mislabeledOversizedProtectedKey = "mislabeled-oversized-protected-sse-event";
    const mislabeledOversizedProtectedResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        stream: true,
        test_sequence_key: mislabeledOversizedProtectedKey,
        test_reasoning_tokens: 516,
        test_stream_only_completed_event: true,
        test_stream_completed_padding_bytes: 1024 * 1024 + 64 * 1024,
        test_stream_response_content_type: "text/plain; charset=utf-8",
      },
    );
    assert(
      mislabeledOversizedProtectedResponse.status === 502 &&
        mislabeledOversizedProtectedResponse.headers.get(
          "x-codex-retry-gateway-reason",
        ) === "response-inspection-limit-exceeded",
      "误标 Content-Type 的首个超大 SSE 事件也必须 fail-closed",
    );

    const disconnectInspectionConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...strictParserConfig,
          stream_action: "disconnect",
        }),
      },
    );
    assert(disconnectInspectionConfigResponse.status === 200, "disconnect 超大事件配置失败");

    const disconnectTerminalCrKey = "disconnect-terminal-cr-sse-reasoning-516";
    const disconnectTerminalCrResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        stream: true,
        test_sequence_key: disconnectTerminalCrKey,
        test_reasoning_tokens: 516,
        test_stream_only_completed_event: true,
        test_stream_event_separator: "\r\r",
      },
    );
    assert(
      disconnectTerminalCrResponse.status === 200 &&
        disconnectTerminalCrResponse.closedByError,
      "disconnect 模式在 EOF flush 后命中 516 时必须断连，不能降成 observe-only",
    );

    const disconnectFinalOnlyConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...strictParserConfig,
          intercept_rule_mode: "final_answer_only_high_xhigh",
          stream_action: "disconnect",
        }),
      },
    );
    assert(disconnectFinalOnlyConfigResponse.status === 200, "disconnect final-only 配置失败");
    const disconnectFinalOnlyKey = "disconnect-terminal-final-answer-only";
    const disconnectFinalOnlyResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        model: "gpt-5.5",
        reasoning: { effort: "high" },
        stream: true,
        test_sequence_key: disconnectFinalOnlyKey,
        test_reasoning_tokens: 18,
        test_include_final_answer_only: true,
        test_stream_only_completed_event: true,
        test_stream_event_separator: "\r\r",
      },
    );
    assert(
      disconnectFinalOnlyResponse.status === 200 &&
        disconnectFinalOnlyResponse.closedByError,
      "disconnect 模式在 EOF 才确认 final answer only 时必须断连",
    );
    const disconnectEofAnalytics = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning`,
    ).then((response) => response.json());
    for (const key of [disconnectTerminalCrKey, disconnectFinalOnlyKey]) {
      const sample = (disconnectEofAnalytics.recent_samples || []).find((entry) =>
        `${entry.request_payload_excerpt || ""}`.includes(key),
      );
      assert(
        sample?.final_action === "disconnect" &&
          sample?.matched_current_rule === true &&
          sample?.blocked_by_gateway === true,
        `EOF disconnect 命中必须按拦截事实落盘: ${key} ${JSON.stringify(sample)}`,
      );
    }
    const restoreDisconnectReasoningConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...strictParserConfig, stream_action: "disconnect" }),
      },
    );
    assert(
      restoreDisconnectReasoningConfigResponse.status === 200,
      "disconnect final-only 用例后恢复 reasoning 规则失败",
    );

    const disconnectInspectionKey = "disconnect-oversized-protected-sse-event";
    const disconnectInspectionResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        stream: true,
        test_sequence_key: disconnectInspectionKey,
        test_reasoning_tokens: 516,
        test_stream_completed_padding_bytes: 1024 * 1024 + 64 * 1024,
      },
    );
    assert(
      disconnectInspectionResponse.status === 200 && disconnectInspectionResponse.closedByError,
      "disconnect 模式已写响应后遇到 protected 超大 SSE 必须 fail-closed 断连",
    );
    let disconnectInspectionSample = null;
    const disconnectInspectionSampleDeadline = Date.now() + 3000;
    while (!disconnectInspectionSample && Date.now() < disconnectInspectionSampleDeadline) {
      const payload = await fetch(
        `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning`,
      ).then((response) => response.json());
      disconnectInspectionSample = (payload.recent_samples || []).find((sample) =>
        `${sample.request_payload_excerpt || ""}`.includes(disconnectInspectionKey),
      );
      if (!disconnectInspectionSample) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert(
      disconnectInspectionSample?.final_action ===
          "response_inspection_limit_disconnected_after_forward" &&
        disconnectInspectionSample?.blocked_by_gateway === true,
      `disconnect 超大事件断连必须详细落盘: ${JSON.stringify(disconnectInspectionSample)}`,
    );

    const observedTimeoutConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...strictParserConfig,
          intercept_streaming: false,
          stream_action: "disconnect",
          latency_guard: {
            enabled: true,
            first_progress_timeout_ms: 0,
            first_progress_action: "return_502",
            total_timeout_ms: 100,
          },
        }),
      },
    );
    assert(observedTimeoutConfigResponse.status === 200, "observe-only 命中后 timeout 配置失败");
    const observedTimeoutKey = "observed-rule-match-total-timeout";
    const observedTimeoutResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        stream: true,
        test_sequence_key: observedTimeoutKey,
        test_reasoning_tokens: 516,
        test_stream_reasoning_in_output_chunk: true,
        test_stream_text: "observed-before-timeout",
        test_stream_pause_after_output_ms: 350,
      },
    );
    assert(
      observedTimeoutResponse.status === 200 && observedTimeoutResponse.closedByError,
      "observe-only 命中后总超时应在已透传状态下断开连接",
    );
    let observedTimeoutSample = null;
    const observedTimeoutSampleDeadline = Date.now() + 3000;
    while (!observedTimeoutSample && Date.now() < observedTimeoutSampleDeadline) {
      const payload = await fetch(
        `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning`,
      ).then((response) => response.json());
      observedTimeoutSample = (payload.recent_samples || []).find((sample) =>
        `${sample.request_payload_excerpt || ""}`.includes(observedTimeoutKey),
      );
      if (!observedTimeoutSample) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert(
      observedTimeoutSample?.final_action === "timeout_disconnected_after_forward" &&
        observedTimeoutSample?.matched_current_rule === true,
      `observe-only 命中后 timeout 必须保留命中事实: ${JSON.stringify(observedTimeoutSample)}`,
    );

    const restoreStrictParserConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(strictParserConfig),
      },
    );
    assert(restoreStrictParserConfigResponse.status === 200, "parser 反例后恢复严格配置失败");
    const layeredPolicyMetrics = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      layeredPolicyMetrics.metrics.capacity_trigger_count >= 8 &&
        layeredPolicyMetrics.metrics.capacity_retry_count >= 4 &&
        layeredPolicyMetrics.metrics.capacity_pass_through_count >= 2 &&
        layeredPolicyMetrics.metrics.capacity_return_502_count >= 2,
      `Capacity 分项计数不完整: ${JSON.stringify(layeredPolicyMetrics.metrics)}`,
    );
    assert(
      layeredPolicyMetrics.metrics.http_429_trigger_count >= 11 &&
        layeredPolicyMetrics.metrics.http_429_retry_count >= 6 &&
        layeredPolicyMetrics.metrics.http_429_pass_through_count >= 2 &&
        layeredPolicyMetrics.metrics.http_429_return_502_count >= 3,
      `HTTP 429 分项计数不完整: ${JSON.stringify(layeredPolicyMetrics.metrics)}`,
    );
    assert(
      layeredPolicyMetrics.metrics.first_progress_timeout_count >= 4 &&
        layeredPolicyMetrics.metrics.total_timeout_count >= 3 &&
        layeredPolicyMetrics.metrics.timeout_retry_count >= 2 &&
        layeredPolicyMetrics.metrics.timeout_return_502_count >= 4 &&
        layeredPolicyMetrics.metrics.timeout_disconnect_after_forward_count >= 1,
      `timeout 分项计数不完整: ${JSON.stringify(layeredPolicyMetrics.metrics)}`,
    );
    assert(
      layeredPolicyMetrics.metrics.total_proxy_request_count ===
        layeredPolicyMetrics.metrics.inspected_response_count +
          layeredPolicyMetrics.metrics.bypassed_proxy_request_count +
          layeredPolicyMetrics.metrics.failed_proxy_request_count +
          layeredPolicyMetrics.metrics.active_proxy_request_count &&
        layeredPolicyMetrics.metrics.blocked_response_count <=
          layeredPolicyMetrics.metrics.inspected_response_count,
      `分层策略执行后代理计数恒等式失效: ${JSON.stringify(layeredPolicyMetrics.metrics)}`,
    );

    const layeredPolicyJsonExport = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning/export?format=json`,
    ).then((response) => response.json());
    const exportedForwardedTimeoutSample = (layeredPolicyJsonExport.samples || []).find((sample) =>
      `${sample.request_payload_excerpt || ""}`.includes(forwardedTimeoutKey),
    );
    const exportedCapacityPassThroughSample = (layeredPolicyJsonExport.samples || []).find((sample) =>
      `${sample.request_payload_excerpt || ""}`.includes("capacity-action-pass-through"),
    );
    assert(
      exportedCapacityPassThroughSample?.policy_trigger === "capacity" &&
        exportedCapacityPassThroughSample?.policy_action === "pass_through" &&
        Number.isFinite(exportedCapacityPassThroughSample?.client_headers_sent_at_ms) &&
        Number.isFinite(exportedCapacityPassThroughSample?.client_first_write_at_ms) &&
        exportedCapacityPassThroughSample?.response_forwarding_started === true,
      `非流式策略透传未记录客户端写回时序: ${JSON.stringify(exportedCapacityPassThroughSample)}`,
    );
    for (const field of [
      "policy_trigger",
      "policy_action",
      "retry_trigger",
      "retry_delay_ms",
      "retry_after_raw",
      "retry_after_ms",
      "retry_budget_used",
      "retry_budget_remaining",
      "first_progress_at",
      "first_progress_at_ms",
      "time_to_first_progress_ms",
      "client_headers_sent_at",
      "client_headers_sent_at_ms",
      "client_first_write_at",
      "client_first_write_at_ms",
      "time_to_client_first_write_ms",
      "timeout_phase",
      "timeout_limit_ms",
      "timeout_response_control_lost",
      "response_forwarding_started",
    ]) {
      assert(
        exportedForwardedTimeoutSample && Object.hasOwn(exportedForwardedTimeoutSample, field),
        `JSON 导出缺少策略采集字段 ${field}`,
      );
    }
    const layeredPolicyCsvExport = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning/export?format=csv`,
    ).then((response) => response.text());
    const layeredPolicyCsvHeader = layeredPolicyCsvExport.split(/\r?\n/, 1)[0];
    for (const field of [
      "policy_trigger",
      "policy_action",
      "retry_trigger",
      "retry_delay_ms",
      "retry_after_raw",
      "retry_after_ms",
      "retry_budget_used",
      "retry_budget_remaining",
      "first_progress_at_ms",
      "time_to_first_progress_ms",
      "client_headers_sent_at_ms",
      "client_first_write_at_ms",
      "time_to_client_first_write_ms",
      "timeout_phase",
      "timeout_limit_ms",
      "timeout_response_control_lost",
      "response_forwarding_started",
    ]) {
      assert(layeredPolicyCsvHeader.includes(field), `CSV 导出缺少策略采集列 ${field}`);
    }

    const restoreLegacyCapacityConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_rule_mode: "reasoning_tokens",
          reasoning_match_mode: "manual",
          guard_retry_attempts: 1,
          retry_upstream_capacity_errors: true,
          http_429_action: "pass_through",
          latency_guard: {
            enabled: false,
            first_progress_timeout_ms: 0,
            first_progress_action: "return_502",
            total_timeout_ms: 0,
          },
        }),
      },
    );
    assert(restoreLegacyCapacityConfigResponse.status === 200, "恢复旧 Capacity 配置失败");

    const capacityRetryKey = "upstream-capacity-then-ok";
    const capacityRetryResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.4",
          test_sequence_key: capacityRetryKey,
          test_capacity_error_once: true,
        }),
      },
    );
    const capacityRetryBody = await capacityRetryResponse.json();
    assert(
      capacityRetryResponse.status === 200,
      `开启 capacity 错误内重试后应恢复为 200: ${capacityRetryResponse.status}`,
    );
    assert(
      capacityRetryBody?.usage?.output_tokens_details?.reasoning_tokens === 128,
      "capacity 错误内重试后未返回第二次正常响应",
    );
    assert(
      upstream.responseRequests.filter(
        (entry) => entry.body?.test_sequence_key === capacityRetryKey,
      ).length === 2,
      "capacity 错误内重试应向上游请求 2 次",
    );
    const capacityRetryLogs = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/logs`,
    ).then((response) => response.json());
    assert(
      capacityRetryLogs.entries.some((entry) =>
        `${entry.message || ""}`.includes(
          "[upstream-capacity] non-stream path=/responses status=429 action=internal_retry remaining=1",
        ),
      ),
      "capacity 错误内重试日志应标记为 internal_retry",
    );

    const disableCapacityRetryResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          retry_upstream_capacity_errors: false,
        }),
      },
    );
    assert(
      disableCapacityRetryResponse.status === 200,
      `关闭 capacity 错误内重试失败: ${disableCapacityRetryResponse.status}`,
    );
    const disabledCapacityStatus = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      disabledCapacityStatus.config?.retry_upstream_capacity_errors === false,
      "关闭 capacity 错误内重试后状态接口未生效",
    );
    const capacityPassthroughKey = "upstream-capacity-passthrough";
    const capacityPassthroughResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          test_sequence_key: capacityPassthroughKey,
          test_capacity_error_once: true,
        }),
      },
    );
    const capacityPassthroughBody = await capacityPassthroughResponse.json();
    assert(
      capacityPassthroughResponse.status === 429,
      `关闭 capacity 错误内重试后应透传上游状态: ${capacityPassthroughResponse.status}`,
    );
    assert(
      capacityPassthroughBody?.error?.message ===
        "Selected model is at capacity. Please try a different model.",
      "关闭 capacity 错误内重试后响应体应原样透传",
    );
    assert(
      upstream.responseRequests.filter(
        (entry) => entry.body?.test_sequence_key === capacityPassthroughKey,
      ).length === 1,
      "关闭 capacity 错误内重试后不应追加上游请求",
    );
    const restoreCapacityRetryResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          retry_upstream_capacity_errors: true,
        }),
      },
    );
    assert(
      restoreCapacityRetryResponse.status === 200,
      `恢复 capacity 错误内重试失败: ${restoreCapacityRetryResponse.status}`,
    );

    const statusBeforeExceededGuardRetry = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    const exceededRetryKey = "non-stream-516-then-516";
    const exceededRetryResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          test_sequence_key: exceededRetryKey,
          test_reasoning_sequence: [516, 516],
        }),
      },
    );
    const exceededRetryBody = await exceededRetryResponse.json();
    assert(
      exceededRetryResponse.status === 502,
      `非流式连续命中超过上限后应返回拦截状态: ${exceededRetryResponse.status}`,
    );
    assert(
      exceededRetryBody?.error?.code === "reasoning_guard_triggered",
      "非流式连续命中超过上限后返回体不正确",
    );
    assert(
      upstream.responseRequests.filter(
        (entry) => entry.body?.test_sequence_key === exceededRetryKey,
      ).length === 2,
      "非流式连续命中超过上限时应只请求 2 次上游",
    );
    const exceededRetryLogs = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/logs`,
    ).then((response) => response.json());
    assert(
      exceededRetryLogs.entries.some((entry) =>
        `${entry.message || ""}`.includes(
          "[match] non-stream path=/responses reasoning_tokens=516 action=internal_retry remaining=1",
        ),
      ),
      "非流式连续命中超过上限的第一次命中日志应标记为 internal_retry",
    );
    assert(
      exceededRetryLogs.entries.some((entry) =>
        `${entry.message || ""}`.includes(
          "[match] non-stream path=/responses reasoning_tokens=516 action=return_status_502",
        ),
      ),
      "非流式连续命中超过上限的最终命中日志应标记为 return_status_502",
    );
    const statusAfterExceededGuardRetry = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      statusAfterExceededGuardRetry.metrics.total_proxy_request_count ===
        statusBeforeExceededGuardRetry.metrics.total_proxy_request_count + 2,
      "非流式连续命中超过上限时代理请求总数应增加 2",
    );
    assert(
      statusAfterExceededGuardRetry.metrics.inspected_response_count ===
        statusBeforeExceededGuardRetry.metrics.inspected_response_count + 2,
      "非流式连续命中超过上限时被检查响应总数应增加 2",
    );
    assert(
      statusAfterExceededGuardRetry.metrics.matched_response_count ===
        statusBeforeExceededGuardRetry.metrics.matched_response_count + 2,
      "非流式连续命中超过上限时规则命中总数应增加 2",
    );
    assert(
      statusAfterExceededGuardRetry.metrics.blocked_response_count ===
        statusBeforeExceededGuardRetry.metrics.blocked_response_count + 2,
      "非流式连续命中超过上限时实际拦截总数应增加 2",
    );

    const statusBeforeStreamGuardRetry = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    const streamRetryKey = "stream-516-then-128";
    const streamRetryResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        stream: true,
        test_sequence_key: streamRetryKey,
        test_reasoning_sequence: [516, 128],
      },
    );
    assert(
      streamRetryResponse.status === 200,
      `流式命中后应由网关内部重试恢复为 200: ${streamRetryResponse.status}`,
    );
    assert(
      streamRetryResponse.text.includes("[DONE]"),
      "流式内部重试未返回第二次正常 SSE",
    );
    assert(
      !streamRetryResponse.text.includes("reasoning_guard_triggered"),
      "流式内部重试不应暴露首次拦截体",
    );
    assert(
      upstream.responseRequests.filter(
        (entry) => entry.body?.test_sequence_key === streamRetryKey,
      ).length === 2,
      "流式命中后内部重试应向上游请求 2 次",
    );
    const streamRetryLogs = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/logs`,
    ).then((response) => response.json());
    assert(
      streamRetryLogs.entries.some((entry) =>
        `${entry.message || ""}`.includes(
          "[match] stream path=/responses reasoning_tokens=516 action=internal_retry remaining=1",
        ),
      ),
      "流式内部重试日志应标记为 internal_retry",
    );
    const statusAfterStreamGuardRetry = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      statusAfterStreamGuardRetry.metrics.total_proxy_request_count ===
        statusBeforeStreamGuardRetry.metrics.total_proxy_request_count + 2,
      "流式内部重试应按每次上游尝试计入代理请求总数",
    );
    assert(
      statusAfterStreamGuardRetry.metrics.inspected_response_count ===
        statusBeforeStreamGuardRetry.metrics.inspected_response_count + 2,
      "流式内部重试应按每次响应计入被检查响应总数",
    );
    assert(
      statusAfterStreamGuardRetry.metrics.matched_response_count ===
        statusBeforeStreamGuardRetry.metrics.matched_response_count + 1,
      "流式内部重试首次命中应计入当前规则命中总数",
    );
    assert(
      statusAfterStreamGuardRetry.metrics.blocked_response_count ===
        statusBeforeStreamGuardRetry.metrics.blocked_response_count + 1,
      "流式内部重试首次吞掉响应应计入实际拦截总数",
    );

    const continuationConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_rule_mode: "reasoning_tokens",
          reasoning_equals: [516, 1034, 18],
          stream_action: "continuation_recovery",
          intercept_streaming: true,
          intercept_non_streaming: false,
          guard_retry_attempts: 1,
        }),
      },
    );
    assert(
      continuationConfigResponse.status === 200,
      `切换续写恢复模式失败: ${continuationConfigResponse.status}`,
    );
    const continuationStatus = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      continuationStatus.config?.intercept_rule_mode === "reasoning_tokens" &&
        continuationStatus.config?.stream_action === "continuation_recovery",
      "reasoning_tokens 规则 + 续写恢复流式动作未在状态接口生效",
    );

    const continuationStreamingDisabledKey = "continuation-streaming-disabled-no-include";
    const continuationStreamingDisabledConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_rule_mode: "reasoning_tokens",
          reasoning_equals: [516, 1034, 18],
          stream_action: "continuation_recovery",
          intercept_streaming: false,
          intercept_non_streaming: true,
          guard_retry_attempts: 1,
        }),
      },
    );
    assert(
      continuationStreamingDisabledConfigResponse.status === 200,
      `关闭流式拦截时保存续写恢复配置失败: ${continuationStreamingDisabledConfigResponse.status}`,
    );
    const continuationStreamingDisabledResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        model: "gpt-5.5",
        stream: true,
        input: "关闭流式拦截时不应改写 include",
        test_sequence_key: continuationStreamingDisabledKey,
        test_reasoning_sequence: [128],
      },
    );
    assert(
      continuationStreamingDisabledResponse.status === 200,
      `关闭流式拦截时普通流式请求应透传: ${continuationStreamingDisabledResponse.status}`,
    );
    const continuationStreamingDisabledRequests = upstream.responseRequests.filter(
      (entry) => entry.body?.test_sequence_key === continuationStreamingDisabledKey,
    );
    assert(
      continuationStreamingDisabledRequests.length === 1 &&
        !(
          Array.isArray(continuationStreamingDisabledRequests[0].body?.include) &&
          continuationStreamingDisabledRequests[0].body.include.includes("reasoning.encrypted_content")
        ),
      "关闭流式拦截时续写恢复不应自动给上游请求补 encrypted include",
    );

    const continuationBypassKey = "continuation-endpoint-bypass-no-include";
    const continuationBypassConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_rule_mode: "reasoning_tokens",
          reasoning_equals: [516, 1034, 18],
          stream_action: "continuation_recovery",
          intercept_streaming: true,
          intercept_non_streaming: true,
          endpoints: ["/v1/chat/completions"],
          guard_retry_attempts: 1,
        }),
      },
    );
    assert(
      continuationBypassConfigResponse.status === 200,
      `排除 /responses 端点时保存续写恢复配置失败: ${continuationBypassConfigResponse.status}`,
    );
    const continuationBypassResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        model: "gpt-5.5",
        stream: true,
        input: "未纳入 endpoints 时不应改写 include",
        test_sequence_key: continuationBypassKey,
        test_reasoning_sequence: [128],
      },
    );
    assert(
      continuationBypassResponse.status === 200,
      `未纳入 endpoints 的 /responses 应旁路透传: ${continuationBypassResponse.status}`,
    );
    assert(
      !continuationBypassResponse.text.includes("encrypted_content"),
      "未纳入 endpoints 的 /responses 不应因续写恢复向客户端暴露 encrypted_content",
    );
    const continuationBypassRequests = upstream.responseRequests.filter(
      (entry) => entry.body?.test_sequence_key === continuationBypassKey,
    );
    assert(
      continuationBypassRequests.length === 1 &&
        !(
          Array.isArray(continuationBypassRequests[0].body?.include) &&
          continuationBypassRequests[0].body.include.includes("reasoning.encrypted_content")
        ),
      "未纳入 endpoints 的 /responses 不应自动给上游请求补 encrypted include",
    );

    const continuationRestoreConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_rule_mode: "reasoning_tokens",
          reasoning_equals: [516, 1034, 18],
          stream_action: "continuation_recovery",
          intercept_streaming: true,
          intercept_non_streaming: false,
          endpoints: ["/responses", "/chat/completions", "/v1/responses", "/v1/chat/completions"],
          guard_retry_attempts: 1,
        }),
      },
    );
    assert(
      continuationRestoreConfigResponse.status === 200,
      `恢复续写恢复端点配置失败: ${continuationRestoreConfigResponse.status}`,
    );

    const continuationCapacitySecret = "continuation-capacity-encrypted-secret";
    const continuationCapacityPassConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_rule_mode: "reasoning_tokens",
          reasoning_equals: [516, 1034, 18],
          stream_action: "continuation_recovery",
          intercept_streaming: true,
          intercept_non_streaming: false,
          endpoints: ["/responses", "/chat/completions", "/v1/responses", "/v1/chat/completions"],
          guard_retry_attempts: 1,
          capacity_error_action: "pass_through",
        }),
      },
    );
    assert(continuationCapacityPassConfigResponse.status === 200, "续写 Capacity 透传脱敏配置失败");
    const continuationCapacityPassKey = "continuation-capacity-pass-through-redaction";
    const continuationCapacityPassResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.5",
          stream: true,
          input: "续写安全模式错误策略透传不应泄露 encrypted reasoning",
          test_sequence_key: continuationCapacityPassKey,
          test_capacity_error_attempts: 1,
          test_capacity_error_payload: {
            error: {
              type: "rate_limit_error",
              code: "model_at_capacity",
              message: "Selected model is at capacity. Please try a different model.",
              encrypted_content: continuationCapacitySecret,
            },
          },
        }),
      },
    );
    const continuationCapacityPassText = await continuationCapacityPassResponse.text();
    assert(
      continuationCapacityPassResponse.status === 429 &&
        !continuationCapacityPassText.includes("encrypted_content") &&
        !continuationCapacityPassText.includes(continuationCapacitySecret),
      `续写安全模式 Capacity pass-through 不得透出 encrypted_content: ${continuationCapacityPassText}`,
    );

    const continuationCapacityRetryConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_rule_mode: "reasoning_tokens",
          reasoning_equals: [516, 1034, 18],
          stream_action: "continuation_recovery",
          intercept_streaming: true,
          intercept_non_streaming: false,
          endpoints: ["/responses", "/chat/completions", "/v1/responses", "/v1/chat/completions"],
          guard_retry_attempts: 1,
          capacity_error_action: "retry_then_pass_through",
        }),
      },
    );
    assert(continuationCapacityRetryConfigResponse.status === 200, "续写 Capacity 重试耗尽脱敏配置失败");
    const continuationCapacityRetrySecret = "continuation-capacity-retry-encrypted-secret";
    const continuationCapacityRetryKey = "continuation-capacity-retry-exhausted-redaction";
    const continuationCapacityRetryResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.5",
          stream: true,
          input: "续写安全模式策略重试耗尽仍不应泄露 encrypted reasoning",
          test_sequence_key: continuationCapacityRetryKey,
          test_capacity_error_attempts: 10,
          test_retry_after: "0",
          test_capacity_error_payload: {
            error: {
              type: "rate_limit_error",
              code: "model_at_capacity",
              message: "Selected model is at capacity. Please try a different model.",
              encrypted_content: continuationCapacityRetrySecret,
            },
          },
        }),
      },
    );
    const continuationCapacityRetryText = await continuationCapacityRetryResponse.text();
    assert(
      continuationCapacityRetryResponse.status === 429 &&
        !continuationCapacityRetryText.includes("encrypted_content") &&
        !continuationCapacityRetryText.includes(continuationCapacityRetrySecret) &&
        upstream.responseRequests.filter(
          (entry) => entry.body?.test_sequence_key === continuationCapacityRetryKey,
        ).length === 2,
      `续写安全模式 retry_then_pass_through 耗尽不得透出 encrypted_content: ${continuationCapacityRetryText}`,
    );

    const continuationCompactionKey = "continuation-context-compaction-no-include";
    const continuationCompactionResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        model: "gpt-5.5",
        reasoning: { effort: "xhigh" },
        stream: true,
        input: [{ role: "user", content: "compact the current conversation" }],
        test_sequence_key: continuationCompactionKey,
        test_reasoning_sequence: [0],
        test_include_final_answer_only: true,
      },
      {
        headers: {
          "x-codex-beta-features": "remote_compaction_v2",
          "x-codex-request-kind": "context_compaction",
        },
      },
    );
    assert(
      continuationCompactionResponse.status === 200,
      `续写恢复模式下 context_compaction reasoning_tokens=0 应继续透明透传: ${continuationCompactionResponse.status}`,
    );
    assert(
      !continuationCompactionResponse.text.includes("encrypted_content"),
      "续写恢复模式下 context_compaction 不应向客户端暴露 encrypted_content",
    );
    const continuationCompactionRequests = upstream.responseRequests.filter(
      (entry) => entry.body?.test_sequence_key === continuationCompactionKey,
    );
    assert(
      continuationCompactionRequests.length === 1 &&
        !(
          Array.isArray(continuationCompactionRequests[0].body?.include) &&
          continuationCompactionRequests[0].body.include.includes("reasoning.encrypted_content")
        ),
      "续写恢复模式下 context_compaction 不应自动给上游请求补 encrypted include",
    );

    const continuationCleanKey = "continuation-normal-128";
    const cleanContinuationResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        model: "gpt-5.5",
        stream: true,
        input: "正常请求不应暴露 encrypted_content",
        test_sequence_key: continuationCleanKey,
        test_reasoning_sequence: [128],
      },
    );
    assert(
      cleanContinuationResponse.status === 200,
      `续写恢复模式下普通 128 流式请求应透传成功: ${cleanContinuationResponse.status}`,
    );
    assert(
      !cleanContinuationResponse.text.includes("encrypted_content"),
      "续写恢复安全模式下普通透传响应不应向客户端暴露 encrypted_content",
    );
    const cleanContinuationRequests = upstream.responseRequests.filter(
      (entry) => entry.body?.test_sequence_key === continuationCleanKey,
    );
    assert(
      cleanContinuationRequests.length === 1 &&
        !(
          Array.isArray(cleanContinuationRequests[0].body?.include) &&
          cleanContinuationRequests[0].body.include.includes("reasoning.encrypted_content")
        ),
      "续写恢复普通 128 第一轮不应自动补 encrypted include",
    );

    const continuationCleanExplicitIncludeKey = "continuation-explicit-include-clean-128";
    const cleanExplicitIncludeResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        model: "gpt-5.5",
        stream: true,
        include: ["reasoning.encrypted_content"],
        input: "显式 include 但未命中时也不应暴露 encrypted_content",
        test_sequence_key: continuationCleanExplicitIncludeKey,
        test_reasoning_sequence: [128],
        test_include_stream_escaped_encrypted_content: true,
        test_include_stream_malformed_encrypted_content: true,
      },
    );
    assert(
      cleanExplicitIncludeResponse.status === 200,
      `显式 include encrypted_content 的普通 128 流式请求应透传成功: ${cleanExplicitIncludeResponse.status}`,
    );
    assert(
      !cleanExplicitIncludeResponse.text.includes("encrypted_content") &&
        !cleanExplicitIncludeResponse.text.includes("encrypted-test-content") &&
        !cleanExplicitIncludeResponse.text.includes("escaped-encrypted-test-content") &&
        !cleanExplicitIncludeResponse.text.includes("malformed-encrypted-test-content"),
      `续写恢复安全模式下显式 include 的普通透传响应不应暴露 encrypted_content: ${cleanExplicitIncludeResponse.text}`,
    );
    const cleanExplicitIncludeRequests = upstream.responseRequests.filter(
      (entry) => entry.body?.test_sequence_key === continuationCleanExplicitIncludeKey,
    );
    assert(
      cleanExplicitIncludeRequests.length === 1 &&
        Array.isArray(cleanExplicitIncludeRequests[0].body?.include) &&
        cleanExplicitIncludeRequests[0].body.include.includes("reasoning.encrypted_content"),
      "显式 include encrypted_content 的普通 128 第一轮请求应保留用户显式 include",
    );

    const continuationJsonFallbackKey = "continuation-stream-json-128";
    const continuationJsonFallbackResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.5",
          stream: true,
          input: "流式请求遇到 JSON 响应时也不应暴露 encrypted_content",
          test_sequence_key: continuationJsonFallbackKey,
          test_reasoning_sequence: [128],
          test_force_json_for_stream: true,
        }),
      },
    );
    const continuationJsonFallbackText = await continuationJsonFallbackResponse.text();
    assert(
      continuationJsonFallbackResponse.status === 200,
      `续写恢复模式下 stream:true JSON fallback 应透传成功: ${continuationJsonFallbackResponse.status}`,
    );
    assert(
      !continuationJsonFallbackText.includes("encrypted_content") &&
        !continuationJsonFallbackText.includes("json-encrypted-test-content"),
      `stream:true JSON fallback 不应向客户端暴露 encrypted_content: ${continuationJsonFallbackText}`,
    );
    const continuationJsonFallbackRequests = upstream.responseRequests.filter(
      (entry) => entry.body?.test_sequence_key === continuationJsonFallbackKey,
    );
    assert(
      continuationJsonFallbackRequests.length === 1 &&
        !(
          Array.isArray(continuationJsonFallbackRequests[0].body?.include) &&
          continuationJsonFallbackRequests[0].body.include.includes("reasoning.encrypted_content")
        ),
      "stream:true JSON fallback 不应自动补 encrypted include",
    );

    const continuationMalformedJsonKey = "continuation-stream-malformed-json-redaction";
    const continuationMalformedJsonResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.5",
          stream: true,
          include: ["reasoning.encrypted_content"],
          input: "流式请求遇到畸形 JSON 响应时也不应暴露 encrypted_content",
          test_sequence_key: continuationMalformedJsonKey,
          test_reasoning_sequence: [128],
          test_force_malformed_json_for_stream: true,
        }),
      },
    );
    const continuationMalformedJsonText = await continuationMalformedJsonResponse.text();
    assert(
      continuationMalformedJsonResponse.status === 200,
      `续写恢复模式下 stream:true 畸形 JSON fallback 应透传状态: ${continuationMalformedJsonResponse.status}`,
    );
    assert(
      !continuationMalformedJsonText.includes("encrypted_content") &&
        !continuationMalformedJsonText.includes("malformed-json-encrypted-secret"),
      `stream:true 畸形 JSON fallback 不应向客户端暴露 encrypted_content: ${continuationMalformedJsonText}`,
    );

    const continuationTextFallbackSecret = "plain-text-fallback-encrypted-secret";
    const continuationTextFallbackResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.5",
          stream: true,
          include: ["reasoning.encrypted_content"],
          input: "流式请求遇到 text/plain 响应时也不应暴露 encrypted_content",
          test_sequence_key: "continuation-stream-text-redaction",
          test_reasoning_sequence: [128],
          test_force_text_for_stream: true,
          test_plain_text_secret: continuationTextFallbackSecret,
        }),
      },
    );
    const continuationTextFallbackText = await continuationTextFallbackResponse.text();
    assert(
      continuationTextFallbackResponse.status === 200,
      `续写恢复模式下 stream:true text/plain fallback 应透传状态: ${continuationTextFallbackResponse.status}`,
    );
    assert(
      !continuationTextFallbackText.includes("encrypted_content") &&
        !continuationTextFallbackText.includes(continuationTextFallbackSecret),
      `stream:true text/plain fallback 不应向客户端暴露 encrypted_content: ${continuationTextFallbackText}`,
    );

    const continuationMetadataLineSecret = "metadata-line-encrypted-secret-redaction";
    const continuationMetadataLineResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        model: "gpt-5.5",
        stream: true,
        include: ["reasoning.encrypted_content"],
        input: "流式 SSE metadata 行不应暴露 encrypted_content",
        test_sequence_key: "continuation-stream-sensitive-metadata-line",
        test_reasoning_sequence: [128],
        test_include_stream_sensitive_metadata_line: true,
        test_stream_metadata_secret: continuationMetadataLineSecret,
      },
    );
    assert(
      continuationMetadataLineResponse.status === 200,
      `续写恢复模式下 stream:true metadata line 应透传状态: ${continuationMetadataLineResponse.status}`,
    );
    assert(
      continuationMetadataLineResponse.text.includes("metadata-clean") &&
        !continuationMetadataLineResponse.text.includes("encrypted_content") &&
        !continuationMetadataLineResponse.text.includes(continuationMetadataLineSecret),
      `stream:true SSE metadata 行不应向客户端暴露 encrypted_content: ${continuationMetadataLineResponse.text}`,
    );

    const continuationNonStreamResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.5",
          test_reasoning_tokens: 516,
        }),
      },
    );
    const continuationNonStreamBody = await continuationNonStreamResponse.json();
    assert(
      continuationNonStreamResponse.status === 200,
      `续写恢复流式动作不应影响已关闭非流式拦截的 Responses: ${continuationNonStreamResponse.status}`,
    );
    assert(
      continuationNonStreamBody?.usage?.output_tokens_details?.reasoning_tokens === 516,
      "续写恢复模式下非流式 Responses 应保留上游响应体",
    );

    const continuationNonStreamRetryConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_rule_mode: "reasoning_tokens",
          reasoning_equals: [516, 1034, 18],
          stream_action: "continuation_recovery",
          intercept_streaming: true,
          intercept_non_streaming: true,
          endpoints: ["/responses", "/chat/completions", "/v1/responses", "/v1/chat/completions"],
          guard_retry_attempts: 1,
        }),
      },
    );
    assert(
      continuationNonStreamRetryConfigResponse.status === 200,
      `开启非流式拦截时保存续写恢复配置失败: ${continuationNonStreamRetryConfigResponse.status}`,
    );
    const continuationNonStreamRetryKey = "continuation-non-stream-516-then-128";
    const continuationNonStreamRetryResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.5",
          stream: false,
          test_sequence_key: continuationNonStreamRetryKey,
          test_reasoning_sequence: [516, 128],
        }),
      },
    );
    const continuationNonStreamRetryBody = await continuationNonStreamRetryResponse.json();
    assert(
      continuationNonStreamRetryResponse.status === 200,
      `续写恢复流式动作不应接管非流式，应继续使用既有内部重试: ${continuationNonStreamRetryResponse.status}`,
    );
    assert(
      continuationNonStreamRetryBody?.usage?.output_tokens_details?.reasoning_tokens === 128,
      "非流式命中 516 后应通过既有内部重试拿到第二轮 128 响应",
    );
    const continuationNonStreamRetryRequests = upstream.responseRequests.filter(
      (entry) => entry.body?.test_sequence_key === continuationNonStreamRetryKey,
    );
    assert(
      continuationNonStreamRetryRequests.length === 2 &&
        !continuationNonStreamRetryRequests.some(
          (entry) =>
            Array.isArray(entry.body?.include) &&
            entry.body.include.includes("reasoning.encrypted_content"),
        ),
      "非流式内部重试不应被续写恢复改写为 encrypted include 续写请求",
    );

    const continuationStreamOnlyRestoreResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_rule_mode: "reasoning_tokens",
          reasoning_equals: [516, 1034, 18],
          stream_action: "continuation_recovery",
          intercept_streaming: true,
          intercept_non_streaming: false,
          endpoints: ["/responses", "/chat/completions", "/v1/responses", "/v1/chat/completions"],
          guard_retry_attempts: 1,
        }),
      },
    );
    assert(
      continuationStreamOnlyRestoreResponse.status === 200,
      `恢复仅流式续写恢复配置失败: ${continuationStreamOnlyRestoreResponse.status}`,
    );

    const continuationChatKey = "continuation-chat-completions-no-responses-recovery";
    const continuationChatStream = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/v1/chat/completions`,
      {
        model: "gpt-5.5",
        stream: true,
        test_sequence_key: continuationChatKey,
        test_reasoning_tokens: 516,
      },
    );
    assert(
      continuationChatStream.status === 502,
      `续写恢复流式动作不应对 Chat Completions 做 Responses 续写，应回到严格拦截语义: ${continuationChatStream.status}`,
    );
    assert(
      continuationChatStream.text.includes("reasoning_guard_triggered"),
      "续写恢复流式动作下 Chat Completions 命中规则时应返回严格拦截体",
    );
    const continuationChatRequests = upstream.chatCompletionRequests.filter(
      (entry) => entry.body?.test_sequence_key === continuationChatKey,
    );
    assert(
      continuationChatRequests.length === 2,
      `Chat Completions 命中后应只走旧 internal retry，不应超过 2 次请求: ${continuationChatRequests.length}`,
    );
    assert(
      continuationChatRequests.every(
        (entry) =>
          !(
            Array.isArray(entry.body?.include) &&
            entry.body.include.includes("reasoning.encrypted_content")
          ),
      ),
      "Chat Completions 不应被续写恢复补 encrypted include",
    );
    assert(
      continuationChatRequests.every((entry) => {
        const serialized = JSON.stringify(entry.body || {});
        return (
          !serialized.includes("encrypted-test-content") &&
          !serialized.includes('"phase":"commentary"')
        );
      }),
      "Chat Completions 不应被续写恢复改写为 Responses commentary 续写请求",
    );
    const continuationChatLogSnapshot = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/logs`,
    ).then((response) => response.json());
    assert(
      !continuationChatLogSnapshot.entries.some((entry) =>
        `${entry.message || ""}`.includes("[match] stream path=/v1/chat/completions") &&
        `${entry.message || ""}`.includes(" action=continuation_recovery"),
      ),
      "Chat Completions 命中规则时不应记录 continuation_recovery 动作",
    );

    const statusBeforeContinuationRecovery = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());

    const continuationKey = "continuation-516-then-128";
    const continuationResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        model: "gpt-5.5",
        stream: true,
        input: "请继续完成任务",
        previous_response_id: "resp_prev_continuation",
        test_sequence_key: continuationKey,
        test_reasoning_sequence: [516, 128],
        test_include_stream_reasoning_item: [true, false],
      },
    );
    assert(
      continuationResponse.status === 200,
      `续写恢复命中 516 后应恢复为 200: ${continuationResponse.status}; body=${continuationResponse.text}`,
    );
    assert(
      continuationResponse.text.includes("[DONE]"),
      "续写恢复应返回最终一轮完整 SSE",
    );
    assert(
      !continuationResponse.text.includes("reasoning_guard_triggered"),
      "续写恢复不应向客户端暴露 516 拦截体",
    );
    const continuationRequests = upstream.responseRequests.filter(
      (entry) => entry.body?.test_sequence_key === continuationKey,
    );
    assertContinuationRequestShape(continuationRequests, "续写恢复 516", {
      expectedOriginalText: "请继续完成任务",
    });
    assert(
      continuationRequests[1].body?.previous_response_id === undefined,
      "续写恢复第二轮请求应删除 previous_response_id，续写状态由显式 input replay 承载",
    );
    const continuationLogs = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/logs`,
    ).then((response) => response.json());
    assert(
      continuationLogs.entries.some((entry) =>
        `${entry.message || ""}`.includes("[match] stream path=/responses") &&
        `${entry.message || ""}`.includes("reasoning_tokens=516") &&
        `${entry.message || ""}`.includes("action=continuation_recovery remaining=1") &&
        `${entry.message || ""}`.includes("mode=reasoning_tokens"),
      ),
      "续写恢复日志应明确标记 continuation_recovery",
    );
    const foldedContinuationKey = "continuation-fold-516-then-128";
    const foldedContinuationResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        model: "gpt-5.5",
        stream: true,
        input: "测试续写折叠输出",
        test_sequence_key: foldedContinuationKey,
        test_reasoning_sequence: [516, 128],
        test_include_stream_reasoning_item: [true, false],
        test_stream_text_sequence: ["fold-part-a", "fold-part-b"],
        test_include_stream_function_call: [true, false],
        test_include_stream_message_item: [true, false],
        test_stream_message_item_text: "tentative-message",
        test_include_stream_lifecycle: true,
      },
    );
    assert(
      foldedContinuationResponse.status === 200,
      `续写折叠输出应返回 200: ${foldedContinuationResponse.status}`,
    );
    assert(
      !foldedContinuationResponse.closedByError,
      `续写折叠输出不应在最终 [DONE] 后异常断流: ${foldedContinuationResponse.text}`,
    );
    assert(
      !foldedContinuationResponse.text.includes("fold-part-a") &&
        foldedContinuationResponse.text.includes("fold-part-b"),
      `语义级续写折叠应丢弃截断轮 tentative final，只透出干净续写轮输出: ${foldedContinuationResponse.text}`,
    );
    assert(
      foldedContinuationResponse.text.includes("[DONE]"),
      "续写折叠输出应保留最终 [DONE]",
    );
    assert(
      !foldedContinuationResponse.text.includes("function_call") &&
        !foldedContinuationResponse.text.includes("call_test_1") &&
        !foldedContinuationResponse.text.includes("\\\"cmd\\\":\\\"ls\\\""),
      `语义级续写折叠应丢弃截断轮 tentative tool call: ${foldedContinuationResponse.text}`,
    );
    assert(
      !foldedContinuationResponse.text.includes("\"type\":\"reasoning\"") &&
        !foldedContinuationResponse.text.includes("rs_test_1"),
      `安全续写不应向客户端透出命中轮 reasoning item: ${foldedContinuationResponse.text}`,
    );
    assert(
      !foldedContinuationResponse.text.includes("msg_test_1") &&
        !foldedContinuationResponse.text.includes("tentative-message"),
      `语义级续写折叠应丢弃截断轮 standalone message: ${foldedContinuationResponse.text}`,
    );
    assertSingleFinalSseEnvelope(foldedContinuationResponse.text, "续写折叠输出");
    assert(
      foldedContinuationResponse.text.indexOf("response.created") <
        foldedContinuationResponse.text.indexOf("fold-part-b"),
      `语义级续写折叠应保持 lifecycle -> 干净续写输出 的顺序: ${foldedContinuationResponse.text}`,
    );
    const foldedContinuationRequests = upstream.responseRequests.filter(
      (entry) => entry.body?.test_sequence_key === foldedContinuationKey,
    );
    assertContinuationRequestShape(foldedContinuationRequests, "续写折叠输出", {
      expectedOriginalText: "测试续写折叠输出",
    });

    const statusAfterContinuationRecovery = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      statusAfterContinuationRecovery.metrics.continuation_recovery_count ===
        statusBeforeContinuationRecovery.metrics.continuation_recovery_count + 2,
      "续写恢复命中后应计入本段触发的续写次数",
    );
    assert(
      statusAfterContinuationRecovery.metrics.continuation_recovery_success_count ===
        statusBeforeContinuationRecovery.metrics.continuation_recovery_success_count + 2,
      "续写恢复最终透传成功后应计入本段成功次数",
    );
    assert(
      statusAfterContinuationRecovery.metrics.continuation_recovery_success_ratio ===
        statusAfterContinuationRecovery.metrics.continuation_recovery_success_count /
          statusAfterContinuationRecovery.metrics.continuation_recovery_count,
      "续写成功率应按成功透传的客户端请求数 / 续写尝试次数计算",
    );

    const multiHopContinuationConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_rule_mode: "reasoning_tokens",
          reasoning_match_mode: "manual",
          reasoning_equals: [516, 1034, 18],
          stream_action: "continuation_recovery",
          endpoints: ["/responses", "/chat/completions", "/v1/responses", "/v1/chat/completions"],
          intercept_streaming: true,
          intercept_non_streaming: false,
          guard_retry_attempts: 2,
        }),
      },
    );
    assert(
      multiHopContinuationConfigResponse.status === 200,
      `开启连续安全续写测试配置失败: ${multiHopContinuationConfigResponse.status}`,
    );
    const multiHopConfigStatus = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      multiHopConfigStatus.config?.intercept_rule_mode === "reasoning_tokens" &&
        multiHopConfigStatus.config?.reasoning_match_mode === "manual" &&
        Array.isArray(multiHopConfigStatus.config?.reasoning_equals) &&
        [516, 1034, 18].every((value) => multiHopConfigStatus.config.reasoning_equals.includes(value)) &&
        multiHopConfigStatus.config?.stream_action === "continuation_recovery" &&
        Array.isArray(multiHopConfigStatus.config?.endpoints) &&
        multiHopConfigStatus.config.endpoints.includes("/responses") &&
        multiHopConfigStatus.config?.guard_retry_attempts === 2,
      `连续安全续写测试配置应显式生效，避免依赖前序状态: ${JSON.stringify(multiHopConfigStatus.config)}`,
    );
    const multiHopContinuationKey = "continuation-fold-516-1034-then-128";
    const multiHopLogsBefore = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/logs`,
    ).then((response) => response.json());
    const multiHopContinuationResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        model: "gpt-5.5",
        stream: true,
        previous_response_id: "resp_prev_multi",
        input: "测试命中后连续安全续写",
        test_sequence_key: multiHopContinuationKey,
        test_reasoning_sequence: [516, 1034, 128],
        test_include_stream_reasoning_item: [true, false, false],
        test_stream_text_sequence: ["multi-hop-a", "multi-hop-b", "multi-hop-clean"],
        test_response_id_sequence: ["resp_cut_1", "resp_cut_2", "resp_clean_3"],
        test_stream_models_sequence: [["gpt-cut-516"], ["gpt-cut-1034"], ["gpt-clean-128"]],
        test_stream_final_model_sequence: ["gpt-cut-516", "gpt-cut-1034", "gpt-clean-128"],
        test_include_stream_lifecycle: true,
      },
    );
    assert(
      multiHopContinuationResponse.status === 200,
      `连续安全续写应最终返回 200: ${multiHopContinuationResponse.status}; body=${multiHopContinuationResponse.text}`,
    );
    assert(
      !multiHopContinuationResponse.closedByError,
      `连续安全续写不应在最终 [DONE] 后异常断流: ${multiHopContinuationResponse.text}`,
    );
    assert(
      !multiHopContinuationResponse.text.includes("multi-hop-a") &&
        !multiHopContinuationResponse.text.includes("multi-hop-b") &&
        multiHopContinuationResponse.text.includes("multi-hop-clean"),
      `连续安全续写应丢弃所有截断轮 tentative final: ${multiHopContinuationResponse.text}`,
    );
    assert(
      !multiHopContinuationResponse.text.includes("gpt-cut-516") &&
        !multiHopContinuationResponse.text.includes("gpt-cut-1034") &&
        multiHopContinuationResponse.text.includes("gpt-clean-128"),
      `连续安全续写不应混入截断轮 model: ${multiHopContinuationResponse.text}`,
    );
    assertSseEnvelopeIdentity(multiHopContinuationResponse.text, "连续安全续写", {
      expectedId: "resp_clean_3",
      expectedModel: "gpt-clean-128",
    });
    assert(
      !multiHopContinuationResponse.text.includes("\"type\":\"reasoning\"") &&
        !multiHopContinuationResponse.text.includes("rs_test_1"),
      `连续安全续写不应向客户端透出命中轮 reasoning item: ${multiHopContinuationResponse.text}`,
    );
    const multiHopRequests = upstream.responseRequests.filter(
      (entry) => entry.body?.test_sequence_key === multiHopContinuationKey,
    );
    assert(multiHopRequests.length === 3, "连续安全续写应向上游请求 3 次");
    for (const [requestIndex, requestEntry] of multiHopRequests.entries()) {
      if (requestIndex === 0) {
        continue;
      }
      const serializedBody = JSON.stringify(requestEntry.body || {});
      assert(
        !(
          Array.isArray(requestEntry.body?.include) &&
          requestEntry.body.include.includes("reasoning.encrypted_content")
        ) &&
          !serializedBody.includes("encrypted_content") &&
          !serializedBody.includes("encrypted-test-content"),
        `安全续写后的第 ${requestIndex + 1} 次上游请求不应继续请求或 replay encrypted reasoning: ${serializedBody}`,
      );
      assert(
        requestEntry.body?.previous_response_id === undefined,
        `安全续写后的第 ${requestIndex + 1} 次上游请求应删除 previous_response_id: ${serializedBody}`,
      );
      assert(
        countContinuationMarkers(requestEntry.body?.input) === 1,
        `安全续写后的第 ${requestIndex + 1} 次上游请求应基于原始 input 且只有一个 commentary marker: ${serializedBody}`,
      );
      assert(
        inputContainsText(requestEntry.body?.input, "测试命中后连续安全续写"),
        `安全续写后的第 ${requestIndex + 1} 次上游请求应保留原始用户输入: ${serializedBody}`,
      );
    }
    const multiHopLogsAfter = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/logs`,
    ).then((response) => response.json());
    const multiHopNewLogs = multiHopLogsAfter.entries.slice(
      Array.isArray(multiHopLogsBefore.entries) ? multiHopLogsBefore.entries.length : 0,
    );
    assert(
      multiHopNewLogs.some((entry) =>
        `${entry.message || ""}`.includes("reasoning_tokens=516") &&
        `${entry.message || ""}`.includes("action=continuation_recovery remaining=2"),
      ) &&
        multiHopNewLogs.some((entry) =>
          `${entry.message || ""}`.includes("reasoning_tokens=1034") &&
          `${entry.message || ""}`.includes("action=continuation_recovery remaining=1"),
        ),
      `安全续写后再次命中时应继续安全续写直到次数耗尽: ${JSON.stringify(multiHopNewLogs)}`,
    );
    const exhaustedContinuationKey = "continuation-exhaust-516-1034-18";
    const exhaustedLogsBefore = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/logs`,
    ).then((response) => response.json());
    const exhaustedContinuationResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        model: "gpt-5.5",
        stream: true,
        previous_response_id: "resp_prev_exhaust",
        input: "测试连续安全续写耗尽后返回 502",
        test_sequence_key: exhaustedContinuationKey,
        test_reasoning_sequence: [516, 1034, 18],
        test_include_stream_reasoning_item: [true, false, false],
        test_stream_text_sequence: ["exhaust-a", "exhaust-b", "exhaust-c"],
        test_response_id_sequence: ["resp_exhaust_1", "resp_exhaust_2", "resp_exhaust_3"],
        test_stream_models_sequence: [["gpt-exhaust-516"], ["gpt-exhaust-1034"], ["gpt-exhaust-18"]],
        test_stream_final_model_sequence: ["gpt-exhaust-516", "gpt-exhaust-1034", "gpt-exhaust-18"],
        test_include_stream_lifecycle: true,
      },
    );
    assert(
      exhaustedContinuationResponse.status === 502,
      `连续安全续写耗尽后仍命中应返回 502: ${exhaustedContinuationResponse.status}; body=${exhaustedContinuationResponse.text}`,
    );
    assert(
      !exhaustedContinuationResponse.text.includes("exhaust-a") &&
        !exhaustedContinuationResponse.text.includes("exhaust-b") &&
        !exhaustedContinuationResponse.text.includes("exhaust-c") &&
        !exhaustedContinuationResponse.text.includes("resp_exhaust_") &&
        !exhaustedContinuationResponse.text.includes("gpt-exhaust-") &&
        !exhaustedContinuationResponse.text.includes("rs_test_1") &&
        !exhaustedContinuationResponse.text.includes("encrypted-test-content") &&
        !exhaustedContinuationResponse.text.includes("data:"),
      `连续安全续写耗尽返回 502 时不应透出任何中间轮 SSE 或 tentative final: ${exhaustedContinuationResponse.text}`,
    );
    assert(
      exhaustedContinuationResponse.headers.get("x-codex-retry-gateway-reason") === "reasoning-guard-triggered",
      `连续安全续写耗尽 502 应带 reasoning guard header: ${JSON.stringify(Object.fromEntries(exhaustedContinuationResponse.headers.entries()))}`,
    );
    const exhaustedBlockedBody = JSON.parse(exhaustedContinuationResponse.text);
    assert(
      exhaustedBlockedBody?.error?.code === "reasoning_guard_triggered" &&
        exhaustedBlockedBody?.error?.reasoning_tokens === 18,
      `连续安全续写耗尽 502 返回体应明确 reasoning_guard_triggered 和最终命中 reasoning=18: ${exhaustedContinuationResponse.text}`,
    );
    const exhaustedRequests = upstream.responseRequests.filter(
      (entry) => entry.body?.test_sequence_key === exhaustedContinuationKey,
    );
    assert(exhaustedRequests.length === 3, "连续安全续写耗尽应向上游请求 3 次");
    for (const [requestIndex, requestEntry] of exhaustedRequests.entries()) {
      if (requestIndex === 0) {
        continue;
      }
      const serializedBody = JSON.stringify(requestEntry.body || {});
      assert(
        !(Array.isArray(requestEntry.body?.include) && requestEntry.body.include.includes("reasoning.encrypted_content")) &&
          !serializedBody.includes("encrypted_content") &&
          !serializedBody.includes("encrypted-test-content"),
        `连续安全续写第 ${requestIndex + 1} 次请求不应请求或 replay encrypted reasoning: ${serializedBody}`,
      );
      assert(
        requestEntry.body?.previous_response_id === undefined,
        `连续安全续写耗尽第 ${requestIndex + 1} 次请求应删除 previous_response_id: ${serializedBody}`,
      );
      assert(
        countContinuationMarkers(requestEntry.body?.input) === 1,
        `连续安全续写耗尽第 ${requestIndex + 1} 次请求也应基于原始 input 且只有一个 commentary marker: ${serializedBody}`,
      );
      assert(
        inputContainsText(requestEntry.body?.input, "测试连续安全续写耗尽后返回 502"),
        `连续安全续写耗尽第 ${requestIndex + 1} 次请求应保留原始用户输入: ${serializedBody}`,
      );
    }
    const exhaustedLogsAfter = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/logs`,
    ).then((response) => response.json());
    const exhaustedNewLogs = exhaustedLogsAfter.entries.slice(
      Array.isArray(exhaustedLogsBefore.entries) ? exhaustedLogsBefore.entries.length : 0,
    );
    assert(
      exhaustedNewLogs.some((entry) =>
        `${entry.message || ""}`.includes("reasoning_tokens=516") &&
        `${entry.message || ""}`.includes("action=continuation_recovery remaining=2"),
      ) &&
        exhaustedNewLogs.some((entry) =>
          `${entry.message || ""}`.includes("reasoning_tokens=1034") &&
          `${entry.message || ""}`.includes("action=continuation_recovery remaining=1"),
        ) &&
        exhaustedNewLogs.some((entry) =>
          `${entry.message || ""}`.includes("reasoning_tokens=18") &&
          `${entry.message || ""}`.includes("action=return_status_502"),
        ),
      `连续安全续写耗尽后仍命中应返回 502: ${JSON.stringify(exhaustedNewLogs)}`,
    );

    const restoreSingleHopContinuationConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ guard_retry_attempts: 1 }),
      },
    );
    const restoreSingleHopContinuationConfigBody =
      await restoreSingleHopContinuationConfigResponse.text();
    assert(
      restoreSingleHopContinuationConfigResponse.status === 200,
      `恢复单跳续写测试配置失败: status=${restoreSingleHopContinuationConfigResponse.status} body=${restoreSingleHopContinuationConfigBody}`,
    );

    const continuationSnapshotMixedKey = "continuation-output-snapshot-mixed-516-then-128";
    const snapshotMixedContinuationResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        model: "gpt-5.5",
        stream: true,
        input: [{ type: "message", role: "user", content: "测试 mixed response.output_snapshot" }],
        test_sequence_key: continuationSnapshotMixedKey,
        test_reasoning_sequence: [516, 128],
        test_stream_reasoning_item_location: "response_output",
        test_stream_snapshot_output_text_sequence: ["snapshot-tentative-final", null],
        test_stream_text_sequence: ["snapshot-delta-a", "snapshot-clean-b"],
      },
    );
    assert(
      snapshotMixedContinuationResponse.status === 200,
      `mixed output_snapshot 续写恢复应返回 200: ${snapshotMixedContinuationResponse.status}; body=${snapshotMixedContinuationResponse.text}`,
    );
    assert(
      !snapshotMixedContinuationResponse.closedByError,
      `mixed output_snapshot 续写恢复不应在最终 [DONE] 后异常断流: ${snapshotMixedContinuationResponse.text}`,
    );
    assert(
      !snapshotMixedContinuationResponse.text.includes("snapshot-tentative-final") &&
        !snapshotMixedContinuationResponse.text.includes("snapshot-delta-a") &&
        snapshotMixedContinuationResponse.text.includes("snapshot-clean-b"),
      `mixed output_snapshot 应丢弃截断轮 convenience final 字段: ${snapshotMixedContinuationResponse.text}`,
    );

    const continuationResponseOutputKey = "continuation-response-output-item-516-then-128";
    const responseOutputContinuationResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        model: "gpt-5.5",
        stream: true,
        input: [{ type: "message", role: "user", content: "测试 response.output reasoning item" }],
        test_sequence_key: continuationResponseOutputKey,
        test_reasoning_sequence: [516, 128],
        test_stream_reasoning_item_location: "response_output",
      },
    );
    assert(
      responseOutputContinuationResponse.status === 200,
      `response.output_snapshot 命中也应触发安全续写且不 replay encrypted reasoning item: ${responseOutputContinuationResponse.status}`,
    );
    const responseOutputContinuationRequests = upstream.responseRequests.filter(
      (entry) => entry.body?.test_sequence_key === continuationResponseOutputKey,
    );
    assertContinuationRequestShape(
      responseOutputContinuationRequests,
      "续写恢复 response.output reasoning item",
    );

    const continuationEncryptedInputKey = "continuation-client-encrypted-input-516-then-128";
    const continuationEncryptedInputResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        model: "gpt-5.5",
        stream: true,
        input: [
          { type: "message", role: "user", content: "测试原始 input 自带 encrypted_content" },
          {
            id: "rs_client_input_1",
            type: "reasoning",
            encrypted_content: "client-origin-encrypted-secret",
            summary: [],
          },
        ],
        test_sequence_key: continuationEncryptedInputKey,
        test_reasoning_sequence: [516, 128],
      },
    );
    assert(
      continuationEncryptedInputResponse.status === 200,
      `原始 input 自带 encrypted_content 的续写恢复应返回 200: ${continuationEncryptedInputResponse.status}`,
    );
    assert(
      !continuationEncryptedInputResponse.text.includes("client-origin-encrypted-secret"),
      `原始 input 自带 encrypted_content 时不应向客户端回显该内容: ${continuationEncryptedInputResponse.text}`,
    );
    const continuationEncryptedInputRequests = upstream.responseRequests.filter(
      (entry) => entry.body?.test_sequence_key === continuationEncryptedInputKey,
    );
    assertContinuationRequestShape(
      continuationEncryptedInputRequests,
      "原始 input 自带 encrypted_content 的续写恢复",
      { expectedOriginalText: "测试原始 input 自带 encrypted_content" },
    );
    const encryptedInputAnalytics = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning`,
    ).then((response) => response.json());
    const encryptedInputSample = (encryptedInputAnalytics.recent_samples || []).find((sample) =>
      `${sample.request_payload_excerpt || ""}`.includes(continuationEncryptedInputKey),
    );
    const encryptedInputExcerpt = `${encryptedInputSample?.request_payload_excerpt || ""}`;
    const encryptedInputExcerptPayload = JSON.parse(encryptedInputExcerpt || "{}");
    assert(
      encryptedInputSample &&
        !objectHasKeyDeep(encryptedInputExcerptPayload, "encrypted_content") &&
        !encryptedInputExcerpt.includes("client-origin-encrypted-secret"),
      `原始请求摘要不应落盘 encrypted_content 字段或值: ${JSON.stringify(encryptedInputSample)}`,
    );

    const continuationTierTwoKey = "continuation-1034-then-128";
    const tierTwoLogsBefore = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/logs`,
    ).then((response) => response.json());
    const tierTwoResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        model: "gpt-5.5",
        stream: true,
        input: [{ type: "message", role: "user", content: "测试 n=2 截断" }],
        test_sequence_key: continuationTierTwoKey,
        test_reasoning_sequence: [1034, 128],
      },
    );
    assert(
      tierTwoResponse.status === 200,
      `续写恢复命中 1034 后应恢复为 200: ${tierTwoResponse.status}`,
    );
    assert(
      upstream.responseRequests.filter(
        (entry) => entry.body?.test_sequence_key === continuationTierTwoKey,
      ).length === 2,
      "续写恢复 1034 应向上游请求 2 次",
    );
    const tierTwoRequests = upstream.responseRequests.filter(
      (entry) => entry.body?.test_sequence_key === continuationTierTwoKey,
    );
    assertContinuationRequestShape(tierTwoRequests, "续写恢复 1034");
    const tierTwoLogsAfter = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/logs`,
    ).then((response) => response.json());
    const tierTwoNewLogs = tierTwoLogsAfter.entries.slice(
      Array.isArray(tierTwoLogsBefore.entries) ? tierTwoLogsBefore.entries.length : 0,
    );
    assert(
      tierTwoNewLogs.some((entry) =>
        `${entry.message || ""}`.includes("reasoning_tokens=1034") &&
        `${entry.message || ""}`.includes("action=continuation_recovery remaining=1"),
      ),
      "续写恢复 1034 日志应标记 continuation_recovery",
    );

    const continuationCustomKey = "continuation-custom-18-then-128";
    const customContinuationLogsBefore = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/logs`,
    ).then((response) => response.json());
    const customContinuationResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        model: "gpt-5.5",
        stream: true,
        input: [{ type: "message", role: "user", content: "测试自定义流式命中续写" }],
        test_sequence_key: continuationCustomKey,
        test_reasoning_sequence: [18, 128],
      },
    );
    assert(
      customContinuationResponse.status === 200,
      `续写恢复应覆盖所有配置进规则的流式命中，reasoning_tokens=18 也应可续写: ${customContinuationResponse.status}`,
    );
    const customContinuationRequests = upstream.responseRequests.filter(
      (entry) => entry.body?.test_sequence_key === continuationCustomKey,
    );
    assertContinuationRequestShape(customContinuationRequests, "续写恢复自定义 reasoning_tokens=18");
    const customContinuationLogsAfter = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/logs`,
    ).then((response) => response.json());
    const customContinuationNewLogs = customContinuationLogsAfter.entries.slice(
      Array.isArray(customContinuationLogsBefore.entries)
        ? customContinuationLogsBefore.entries.length
        : 0,
    );
    assert(
      customContinuationNewLogs.some((entry) =>
        `${entry.message || ""}`.includes("reasoning_tokens=18") &&
        `${entry.message || ""}`.includes("action=continuation_recovery remaining=1"),
      ),
      "续写恢复自定义 reasoning_tokens=18 日志应标记 continuation_recovery",
    );

    const continuationV1Key = "continuation-v1-516-then-128";
    const continuationV1Response = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/v1/responses`,
      {
        model: "gpt-5.5",
        stream: true,
        input: [{ type: "message", role: "user", content: "测试 v1 续写" }],
        test_sequence_key: continuationV1Key,
        test_reasoning_sequence: [516, 128],
      },
    );
    assert(
      continuationV1Response.status === 200,
      `续写恢复 /v1/responses 命中 516 后应恢复为 200: ${continuationV1Response.status}`,
    );
    assert(
      upstream.responseRequests.filter(
        (entry) => entry.body?.test_sequence_key === continuationV1Key,
      ).length === 2,
      "续写恢复 /v1/responses 应向上游请求 2 次",
    );
    const continuationV1Requests = upstream.responseRequests.filter(
      (entry) => entry.body?.test_sequence_key === continuationV1Key,
    );
    assertContinuationRequestShape(continuationV1Requests, "续写恢复 /v1/responses");

    const continuationExplicitIncludeKey = "continuation-explicit-include-516-then-128";
    const continuationExplicitIncludeResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        model: "gpt-5.5",
        stream: true,
        include: ["reasoning.encrypted_content"],
        input: [{ type: "message", role: "user", content: "测试显式 include 后续写" }],
        test_sequence_key: continuationExplicitIncludeKey,
        test_reasoning_sequence: [516, 128],
      },
    );
    assert(
      continuationExplicitIncludeResponse.status === 200,
      `显式 include encrypted_content 的续写恢复请求命中 516 后应恢复为 200: ${continuationExplicitIncludeResponse.status}`,
    );
    assert(
      !continuationExplicitIncludeResponse.text.includes("encrypted_content"),
      "续写恢复最终响应不应向客户端透出 encrypted_content，即使原请求显式 include",
    );
    assert(
      !continuationExplicitIncludeResponse.text.includes("encrypted-test-content"),
      "续写恢复最终响应不应向客户端透出 encrypted reasoning 内容值",
    );
    const continuationExplicitIncludeRequests = upstream.responseRequests.filter(
      (entry) => entry.body?.test_sequence_key === continuationExplicitIncludeKey,
    );
    assertContinuationRequestShape(
      continuationExplicitIncludeRequests,
      "显式 include encrypted_content 的续写恢复请求",
      { expectFirstEncryptedInclude: true },
    );
    const continuationExplicitIncludeLogs = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/logs`,
    ).then((response) => response.json());
    assert(
      continuationExplicitIncludeLogs.entries.some((entry) =>
        `${entry.message || ""}`.includes("reasoning_tokens=516") &&
        `${entry.message || ""}`.includes("action=continuation_recovery"),
      ),
      "显式 include encrypted_content 的续写恢复日志应标记 continuation_recovery",
    );

    const finalOnlyContinuationConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_rule_mode: "final_answer_only_high_xhigh",
          stream_action: "continuation_recovery",
          intercept_streaming: true,
          intercept_non_streaming: true,
          guard_retry_attempts: 1,
        }),
      },
    );
    assert(
      finalOnlyContinuationConfigResponse.status === 200,
      `final answer only + 续写恢复配置保存失败: ${finalOnlyContinuationConfigResponse.status}`,
    );
    const finalOnlyContinuationKey = "final-only-continuation-no-auto-include";
    const finalOnlyContinuationResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        model: "gpt-5.5",
        reasoning: { effort: "high" },
        stream: true,
        test_sequence_key: finalOnlyContinuationKey,
        test_reasoning_sequence: [85],
        test_include_final_answer_only: true,
      },
    );
    assert(
      finalOnlyContinuationResponse.status === 502,
      `final answer only 规则下选择续写恢复不应破坏原拦截: ${finalOnlyContinuationResponse.status}`,
    );
    const finalOnlyContinuationRequests = upstream.responseRequests.filter(
      (entry) => entry.body?.test_sequence_key === finalOnlyContinuationKey,
    );
    assert(
      finalOnlyContinuationRequests.length === 2 &&
        finalOnlyContinuationRequests.every(
          (entry) =>
            !(Array.isArray(entry.body?.include) && entry.body.include.includes("reasoning.encrypted_content")),
        ),
      `final answer only 规则可按 guard_retry_attempts 内部重试，但不应补 encrypted include: ${JSON.stringify(finalOnlyContinuationRequests.map((entry) => entry.body?.include))}`,
    );
    const finalOnlyContinuationLogs = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/logs`,
    ).then((response) => response.json());
    assert(
      finalOnlyContinuationLogs.entries.some((entry) =>
        `${entry.message || ""}`.includes("[match] stream path=/responses") &&
        `${entry.message || ""}`.includes("mode=final_answer_only_high_xhigh") &&
        `${entry.message || ""}`.includes("action=internal_retry remaining=1"),
      ) &&
        finalOnlyContinuationLogs.entries.some((entry) =>
          `${entry.message || ""}`.includes("[match] stream path=/responses") &&
          `${entry.message || ""}`.includes("mode=final_answer_only_high_xhigh") &&
          `${entry.message || ""}`.includes("action=return_status_502"),
        ),
      "final answer only 规则在有续写额度时应走内部重试，耗尽后仍命中才返回 502",
    );
    assert(
      !finalOnlyContinuationLogs.entries.some((entry) =>
        `${entry.message || ""}`.includes("[match]") &&
        `${entry.message || ""}`.includes("mode=final_answer_only_high_xhigh") &&
        `${entry.message || ""}`.includes("action=continuation_recovery"),
      ),
      "final answer only 规则不应被续写安全模式误触续写恢复",
    );

    const restoreReasoningModeAfterContinuationResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_rule_mode: "reasoning_tokens",
          reasoning_equals: [516],
          stream_action: "strict_502",
          intercept_streaming: true,
          intercept_non_streaming: true,
          guard_retry_attempts: 3,
        }),
      },
    );
    assert(
      restoreReasoningModeAfterContinuationResponse.status === 200,
      `续写恢复测试后恢复默认规则失败: ${restoreReasoningModeAfterContinuationResponse.status}`,
    );

    const restoreDefaultGuardRetryConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          guard_retry_attempts: 3,
        }),
      },
    );
    assert(
      restoreDefaultGuardRetryConfigResponse.status === 200,
      `恢复 guard_retry_attempts=3 失败: ${restoreDefaultGuardRetryConfigResponse.status}`,
    );

    const policyFetchFailureConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_rule_mode: "none",
          guard_retry_attempts: 1,
          http_429_action: "retry_then_502",
          latency_guard: {
            enabled: false,
            first_progress_timeout_ms: 0,
            first_progress_action: "return_502",
            total_timeout_ms: 0,
          },
        }),
      },
    );
    assert(policyFetchFailureConfigResponse.status === 200, "policy retry 后 fetch failure 配置失败");
    const policyFetchFailureMetricsBefore = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    const policyFetchFailureKey = "policy-retry-then-fetch-failure";
    const policyFetchFailureResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          test_sequence_key: policyFetchFailureKey,
          test_http_429_attempts: 1,
          test_fail_before_response_from_attempt: 2,
        }),
      },
    );
    await policyFetchFailureResponse.arrayBuffer();
    const policyFetchFailureMetricsAfter = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    const policyFailureBefore = policyFetchFailureMetricsBefore.metrics;
    const policyFailureAfter = policyFetchFailureMetricsAfter.metrics;
    assert(
      policyFetchFailureResponse.status === 502 &&
        policyFailureAfter.total_proxy_request_count ===
          policyFailureBefore.total_proxy_request_count + 2 &&
        policyFailureAfter.inspected_response_count ===
          policyFailureBefore.inspected_response_count + 1 &&
        policyFailureAfter.failed_proxy_request_count ===
          policyFailureBefore.failed_proxy_request_count + 1 &&
        policyFailureAfter.total_proxy_request_count ===
          policyFailureAfter.inspected_response_count +
            policyFailureAfter.bypassed_proxy_request_count +
            policyFailureAfter.failed_proxy_request_count +
            policyFailureAfter.active_proxy_request_count,
      `policy retry 后 fetch failure 必须保持 attempt 计数恒等式: before=${JSON.stringify(policyFailureBefore)} after=${JSON.stringify(policyFailureAfter)}`,
    );
    const restoreReasoningAfterPolicyFailureResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_rule_mode: "reasoning_tokens",
          reasoning_match_mode: "formula_518n_minus_2",
          reasoning_equals: [516],
          stream_action: "strict_502",
          intercept_streaming: true,
          intercept_non_streaming: true,
          guard_retry_attempts: 3,
        }),
      },
    );
    assert(
      restoreReasoningAfterPolicyFailureResponse.status === 200,
      "policy fetch failure 用例后恢复 reasoning 规则失败",
    );

    const recoveredResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ test_fail_before_response_once: true }),
      },
    );
    const recoveredBody = await recoveredResponse.json();
    assert(
      recoveredResponse.status === 200,
      `首次 fetch failed 后未自动恢复: ${recoveredResponse.status}`,
    );
    assert(
      recoveredBody?.retry_attempt === 2,
      "首次 fetch failed 后未命中第二次上游请求",
    );

    const transientRetryConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_rule_mode: "reasoning_tokens",
          reasoning_match_mode: "formula_518n_minus_2",
          reasoning_equals: [516],
          stream_action: "strict_502",
          intercept_streaming: true,
          intercept_non_streaming: true,
          guard_retry_attempts: 0,
          transient_retry: {
            enabled: true,
            initial_delay_ms: 0,
            max_delay_ms: 0,
          },
        }),
      },
    );
    assert(
      transientRetryConfigResponse.status === 200 &&
        transientRetryConfigResponse.ok,
      `临时故障自动恢复配置失败: ${transientRetryConfigResponse.status}`,
    );

    const invalidTransientRetryConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          transient_retry: {
            enabled: true,
            initial_delay_ms: 1000,
            max_delay_ms: 600001,
          },
        }),
      },
    );
    assert(
      invalidTransientRetryConfigResponse.status === 400,
      `临时重试最大退避超过 10 分钟必须被拒绝: ${invalidTransientRetryConfigResponse.status}`,
    );

    for (const status of [429, 500, 502, 503, 504]) {
      const transientHttpKey = `transient-http-${status}-then-ok`;
      const transientHttpResponse = await fetch(
        `http://127.0.0.1:${gatewayPort}/responses`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            test_sequence_key: transientHttpKey,
            test_transient_error_attempts: 1,
            test_transient_error_status: status,
          }),
        },
      );
      assert(
        transientHttpResponse.status === 200 &&
          upstream.responseRequests.filter(
            (entry) => entry.body?.test_sequence_key === transientHttpKey,
          ).length === 2,
        `临时 HTTP ${status} 应在同一客户端连接内自动恢复: ${transientHttpResponse.status}`,
      );
    }

    const quotaRetryKey = "structured-quota-429-then-ok";
    const quotaRetryResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          test_sequence_key: quotaRetryKey,
          test_transient_error_attempts: 2,
          test_transient_error_status: 429,
          test_transient_error_payload: {
            error: {
              type: "insufficient_quota",
              code: "billing_hard_limit_reached",
              message: "You exceeded your current quota and token budget.",
            },
          },
        }),
      },
    );
    assert(
      quotaRetryResponse.status === 200 &&
        upstream.responseRequests.filter(
          (entry) => entry.body?.test_sequence_key === quotaRetryKey,
        ).length === 3,
      `结构化额度或 token budget 429 应自动恢复: ${quotaRetryResponse.status}`,
    );

    const plainTextQuotaRetryKey = "plain-text-quota-400-then-ok";
    const plainTextQuotaRetryResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          test_sequence_key: plainTextQuotaRetryKey,
          test_transient_error_attempts: 1,
          test_transient_error_status: 400,
          test_transient_error_content_type: "text/plain; charset=utf-8",
          test_transient_error_raw_body: "insufficient_quota: token budget exceeded",
        }),
      },
    );
    assert(
      plainTextQuotaRetryResponse.status === 200 &&
        upstream.responseRequests.filter(
          (entry) => entry.body?.test_sequence_key === plainTextQuotaRetryKey,
        ).length === 2,
      `纯文本额度或 token budget 错误应自动恢复: ${plainTextQuotaRetryResponse.status}`,
    );

    const quotaEnvelopeRetryKey = "structured-quota-200-envelope-then-ok";
    const quotaEnvelopeRetryResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          test_sequence_key: quotaEnvelopeRetryKey,
          test_transient_error_attempts: 1,
          test_transient_error_status: 200,
          test_transient_error_payload: {
            error: {
              type: "insufficient_quota",
              code: "token_budget_exceeded",
              message: "Your token budget and available balance are exhausted.",
            },
          },
        }),
      },
    );
    assert(
      quotaEnvelopeRetryResponse.status === 200 &&
        upstream.responseRequests.filter(
          (entry) => entry.body?.test_sequence_key === quotaEnvelopeRetryKey,
        ).length === 2,
      `HTTP 200 的结构化额度或 token budget 错误包络应自动恢复: ${quotaEnvelopeRetryResponse.status}`,
    );

    const normalBudgetMentionKey = "normal-200-output-mentions-token-budget";
    const normalBudgetMentionResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          test_sequence_key: normalBudgetMentionKey,
          test_response_output_text_sequence: [
            "A normal model response can mention token budget without indicating an API error.",
            "unexpected retry",
          ],
        }),
      },
    );
    const normalBudgetMentionBody = await normalBudgetMentionResponse.json();
    assert(
      normalBudgetMentionResponse.status === 200 &&
        normalBudgetMentionBody?.output_text?.includes("token budget") &&
        upstream.responseRequests.filter(
          (entry) => entry.body?.test_sequence_key === normalBudgetMentionKey,
        ).length === 1,
      `正常回答提及 token budget 不应触发临时重试: ${JSON.stringify(normalBudgetMentionBody)}`,
    );

    const nonQuotaErrorBudgetMentionKey = "non-quota-error-body-mentions-token-budget";
    const nonQuotaErrorBudgetMentionResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          test_sequence_key: nonQuotaErrorBudgetMentionKey,
          test_error_status: 400,
          test_error_payload: {
            error: {
              type: "invalid_request_error",
              code: "invalid_parameter",
              message: "The request contains an invalid parameter.",
            },
            detail: "This documentation discusses token budget but is not a quota failure.",
          },
        }),
      },
    );
    assert(
      nonQuotaErrorBudgetMentionResponse.status === 400 &&
        upstream.responseRequests.filter(
          (entry) => entry.body?.test_sequence_key === nonQuotaErrorBudgetMentionKey,
        ).length === 1,
      `非额度结构化错误即使其它字段提到 token budget 也不应重试: status=${nonQuotaErrorBudgetMentionResponse.status}`,
    );

    const nonCapacityErrorMentionKey = "non-capacity-error-body-mentions-capacity";
    const nonCapacityErrorMentionResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          test_sequence_key: nonCapacityErrorMentionKey,
          test_transient_error_attempts: 1,
          test_transient_error_status: 200,
          test_transient_error_payload: {
            error: {
              type: "invalid_request_error",
              code: "invalid_parameter",
              message: "The request contains an invalid parameter.",
            },
            detail: "This documentation mentions selected model is at capacity but is not an API capacity failure.",
          },
        }),
      },
    );
    const nonCapacityErrorMentionBody = await nonCapacityErrorMentionResponse.json();
    assert(
      nonCapacityErrorMentionResponse.status === 200 &&
        nonCapacityErrorMentionBody?.error?.code === "invalid_parameter" &&
        upstream.responseRequests.filter(
          (entry) => entry.body?.test_sequence_key === nonCapacityErrorMentionKey,
        ).length === 1,
      `非容量结构化错误即使其它字段提到 capacity 也不应重试: ${JSON.stringify(nonCapacityErrorMentionBody)}`,
    );

    const jsonStringCapacityMentionKey = "json-string-mentions-capacity-without-error-envelope";
    const jsonStringCapacityMentionResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          test_sequence_key: jsonStringCapacityMentionKey,
          test_transient_error_attempts: 1,
          test_transient_error_status: 400,
          test_transient_error_content_type: "application/json; charset=utf-8",
          test_transient_error_raw_body: JSON.stringify(
            "Documentation mentions selected model is at capacity, but this is not an error envelope.",
          ),
        }),
      },
    );
    const jsonStringCapacityMentionBody = await jsonStringCapacityMentionResponse.text();
    assert(
      jsonStringCapacityMentionResponse.status === 400 &&
        jsonStringCapacityMentionBody.includes("not an error envelope") &&
        upstream.responseRequests.filter(
          (entry) => entry.body?.test_sequence_key === jsonStringCapacityMentionKey,
        ).length === 1,
      `可解析 JSON 字符串提及 capacity 不应触发临时重试: status=${jsonStringCapacityMentionResponse.status} body=${jsonStringCapacityMentionBody}`,
    );

    const nestedCapacityDetailMentionKey = "structured-error-detail-mentions-capacity";
    const nestedCapacityDetailMentionResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          test_sequence_key: nestedCapacityDetailMentionKey,
          test_transient_error_attempts: 1,
          test_transient_error_status: 400,
          test_transient_error_payload: {
            error: {
              type: "invalid_request_error",
              code: "invalid_parameter",
              message: "The request contains an invalid parameter.",
              details: "This detail mentions selected model is at capacity but is not a capacity failure.",
            },
          },
        }),
      },
    );
    const nestedCapacityDetailMentionBody = await nestedCapacityDetailMentionResponse.json();
    assert(
      nestedCapacityDetailMentionResponse.status === 400 &&
        nestedCapacityDetailMentionBody?.error?.code === "invalid_parameter" &&
        upstream.responseRequests.filter(
          (entry) => entry.body?.test_sequence_key === nestedCapacityDetailMentionKey,
        ).length === 1,
      `结构化 error 的非标准 details 提及 capacity 不应触发临时重试: ${JSON.stringify(nestedCapacityDetailMentionBody)}`,
    );

    const connectionRetryKey = "connection-interrupted-twice-then-ok";
    const connectionRetryResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          test_sequence_key: connectionRetryKey,
          test_fail_before_response_attempts: 2,
        }),
      },
    );
    assert(
      connectionRetryResponse.status === 200 &&
        upstream.responseRequests.filter(
          (entry) => entry.body?.test_sequence_key === connectionRetryKey,
        ).length === 3,
      `连接中断两次后应自动恢复，不应中断客户端请求: ${connectionRetryResponse.status}`,
    );

    const streamTerminationRetryKey = "stream-terminated-before-forward-then-ok";
    const streamTerminationRetryResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        stream: true,
        test_sequence_key: streamTerminationRetryKey,
        test_force_terminate_before_progress_attempts: 2,
      },
    );
    assert(
      streamTerminationRetryResponse.status === 200 &&
        streamTerminationRetryResponse.text.includes("[DONE]") &&
        !streamTerminationRetryResponse.closedByError &&
        upstream.responseRequests.filter(
          (entry) => entry.body?.test_sequence_key === streamTerminationRetryKey,
        ).length === 3,
      `未向客户端首写前的流式中断应自动恢复: ${JSON.stringify(streamTerminationRetryResponse)}`,
    );

    const streamModelUnavailablePolicyConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_rule_mode: "none",
          guard_retry_attempts: 1,
          transient_retry: {
            enabled: false,
            initial_delay_ms: 0,
            max_delay_ms: 0,
          },
          model_unavailable_error_action: "retry_then_pass_through",
          error_message_fallback_action: "retry_then_pass_through",
        }),
      },
    );
    assert(
      streamModelUnavailablePolicyConfigResponse.status === 200,
      "流式模型未配置/不可用策略配置失败",
    );
    const streamModelUnavailablePolicyKey =
      "stream-model-unavailable-before-forward-then-ok";
    const streamModelUnavailablePolicyResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        stream: true,
        model: "policy-test-model",
        test_response_model: "policy-test-model",
        test_sequence_key: streamModelUnavailablePolicyKey,
        test_stream_transient_error_attempts: 1,
        test_stream_transient_error_payload: "模型 'gpt-5.6-sol' 未配置或不可用",
      },
    );
    assert(
      streamModelUnavailablePolicyResponse.status === 200 &&
        streamModelUnavailablePolicyResponse.text.includes("[DONE]") &&
        !streamModelUnavailablePolicyResponse.text.includes("未配置或不可用") &&
        !streamModelUnavailablePolicyResponse.closedByError &&
        upstream.responseRequests.filter(
          (entry) => entry.body?.test_sequence_key === streamModelUnavailablePolicyKey,
        ).length === 2,
      `首写前的流式模型未配置/不可用错误应由策略重试恢复: ${JSON.stringify(streamModelUnavailablePolicyResponse)}`,
    );
    const streamCompletedErrorPayloadKey =
      "stream-completed-error-message-must-not-retry";
    const streamCompletedErrorPayloadResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        stream: true,
        test_sequence_key: streamCompletedErrorPayloadKey,
        test_stream_completed_error_payload: {
          message: "completed metadata is not a retryable failure",
        },
      },
    );
    assert(
      streamCompletedErrorPayloadResponse.status === 200 &&
        streamCompletedErrorPayloadResponse.text.includes("[DONE]") &&
        upstream.responseRequests.filter(
          (entry) => entry.body?.test_sequence_key === streamCompletedErrorPayloadKey,
        ).length === 1,
      `非失败终态携带 error.message 不得触发重试: ${JSON.stringify(streamCompletedErrorPayloadResponse)}`,
    );
    const restoreTransientRetryAfterStreamPolicyResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_rule_mode: "reasoning_tokens",
          reasoning_match_mode: "formula_518n_minus_2",
          reasoning_equals: [516],
          stream_action: "strict_502",
          intercept_streaming: true,
          intercept_non_streaming: true,
          guard_retry_attempts: 0,
          transient_retry: {
            enabled: true,
            initial_delay_ms: 0,
            max_delay_ms: 0,
          },
          model_unavailable_error_action: "pass_through",
          error_message_fallback_action: "pass_through",
        }),
      },
    );
    assert(
      restoreTransientRetryAfterStreamPolicyResponse.status === 200,
      "流式模型未配置/不可用策略用例后恢复瞬态重试失败",
    );

    const streamQuotaRetryKey = "stream-structured-quota-before-forward-then-ok";
    const streamQuotaRetryResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        stream: true,
        test_sequence_key: streamQuotaRetryKey,
        test_stream_transient_error_attempts: 1,
      },
    );
    assert(
      streamQuotaRetryResponse.status === 200 &&
        streamQuotaRetryResponse.text.includes("[DONE]") &&
        !streamQuotaRetryResponse.text.includes("insufficient_quota") &&
        !streamQuotaRetryResponse.closedByError &&
        upstream.responseRequests.filter(
          (entry) => entry.body?.test_sequence_key === streamQuotaRetryKey,
        ).length === 2,
      `首写前的流式结构化额度错误应自动恢复: ${JSON.stringify(streamQuotaRetryResponse)}`,
    );

    const transientRetryTotalDeadlineConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          transient_retry: {
            enabled: true,
            initial_delay_ms: 400,
            max_delay_ms: 400,
          },
          latency_guard: {
            enabled: true,
            first_progress_timeout_ms: 0,
            first_progress_action: "return_502",
            total_timeout_ms: 180,
          },
        }),
      },
    );
    assert(
      transientRetryTotalDeadlineConfigResponse.status === 200,
      "临时重试总 deadline 配置失败",
    );
    const transientRetryTotalDeadlineKey =
      "transient-retry-total-deadline-before-next-attempt";
    const transientRetryTotalDeadlineResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          test_sequence_key: transientRetryTotalDeadlineKey,
          test_transient_error_attempts: 1,
          test_transient_error_status: 503,
        }),
      },
    );
    const transientRetryTotalDeadlineBody =
      await transientRetryTotalDeadlineResponse.json();
    assert(
      transientRetryTotalDeadlineResponse.status === 502 &&
        transientRetryTotalDeadlineResponse.headers.get("x-codex-retry-gateway-reason") ===
          "upstream-total-timeout" &&
        transientRetryTotalDeadlineBody?.error?.code === "upstream_total_timeout" &&
        upstream.responseRequests.filter(
          (entry) => entry.body?.test_sequence_key === transientRetryTotalDeadlineKey,
        ).length === 1,
      `临时重试到达总 deadline 后不得派发新 attempt: status=${transientRetryTotalDeadlineResponse.status} body=${JSON.stringify(transientRetryTotalDeadlineBody)}`,
    );

    const transientRetryFirstProgressConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          transient_retry: {
            enabled: true,
            initial_delay_ms: 120,
            max_delay_ms: 120,
          },
          latency_guard: {
            enabled: true,
            first_progress_timeout_ms: 60,
            first_progress_action: "return_502",
            total_timeout_ms: 0,
          },
        }),
      },
    );
    assert(
      transientRetryFirstProgressConfigResponse.status === 200,
      "临时重试与首 progress 边界配置失败",
    );

    const connectionRetryWithFirstProgressKey =
      "connection-interrupted-before-progress-waits-then-ok";
    const connectionRetryWithFirstProgressResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          test_sequence_key: connectionRetryWithFirstProgressKey,
          test_fail_before_response_attempts: 1,
        }),
      },
    );
    assert(
      connectionRetryWithFirstProgressResponse.status === 200 &&
        upstream.responseRequests.filter(
          (entry) => entry.body?.test_sequence_key === connectionRetryWithFirstProgressKey,
        ).length === 2,
      `建连中断后的临时退避不应被首 progress timer 取消: ${connectionRetryWithFirstProgressResponse.status}`,
    );

    const streamQuotaRetryWithFirstProgressKey =
      "stream-quota-before-progress-waits-then-ok";
    const streamQuotaRetryWithFirstProgressResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        stream: true,
        test_sequence_key: streamQuotaRetryWithFirstProgressKey,
        test_stream_transient_error_attempts: 1,
      },
    );
    assert(
      streamQuotaRetryWithFirstProgressResponse.status === 200 &&
        streamQuotaRetryWithFirstProgressResponse.text.includes("[DONE]") &&
        !streamQuotaRetryWithFirstProgressResponse.closedByError &&
        upstream.responseRequests.filter(
          (entry) => entry.body?.test_sequence_key === streamQuotaRetryWithFirstProgressKey,
        ).length === 2,
      `流式结构化额度故障的临时退避不应被首 progress timer 取消: ${JSON.stringify(streamQuotaRetryWithFirstProgressResponse)}`,
    );

    const disableTransientRetryConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          transient_retry: {
            enabled: false,
            initial_delay_ms: 0,
            max_delay_ms: 0,
          },
          latency_guard: {
            enabled: false,
          },
          guard_retry_attempts: 3,
        }),
      },
    );
    assert(
      disableTransientRetryConfigResponse.status === 200,
      `临时故障自动恢复测试后关闭策略失败: ${disableTransientRetryConfigResponse.status}`,
    );

    const failedResponsesProxy = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ test_fail_before_response_always: true }),
      },
    );
    const failedResponsesProxyBody = await failedResponsesProxy.json();
    assert(
      failedResponsesProxy.status === 502,
      `连续上游 fetch failed 后应返回 502: ${failedResponsesProxy.status}`,
    );
    assert(
      failedResponsesProxyBody?.error?.type === "upstream_error" &&
        failedResponsesProxyBody?.error?.code === "upstream_fetch_failed",
      `连续上游 fetch failed 后应返回 upstream_error 摘要: ${JSON.stringify(failedResponsesProxyBody)}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    const failedResponsesProxyLogText = await readFile(logPath, "utf8");
    assert(
      failedResponsesProxyLogText.includes(
        "[upstream-error] fetch failed after retry path=/responses",
      ),
      "连续 /responses 上游 fetch failed 应记录 upstream-error 摘要日志",
    );
    assert(
      !failedResponsesProxyLogText.includes("[error] TypeError: fetch failed"),
      "连续 /responses 上游 fetch failed 不应记录 gateway 内部 error 堆栈",
    );

    const familyMatchedResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.4",
          test_response_model: "gpt-5.4",
        }),
      },
    );
    assert(
      familyMatchedResponse.status === 200,
      `gpt-5.4 一致声明请求失败: ${familyMatchedResponse.status}`,
    );

    const familyMatched55Response = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.5",
          test_response_model: "gpt-5.5",
        }),
      },
    );
    assert(
      familyMatched55Response.status === 200,
      `gpt-5.5 一致声明请求失败: ${familyMatched55Response.status}`,
    );

    const gpt56Models = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
    const observedReasoningEfforts = [
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ];
    const gpt56Cases = gpt56Models.flatMap((model) =>
      observedReasoningEfforts.map((effort) => ({ model, effort })),
    );
    for (const testCase of gpt56Cases) {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: testCase.model,
          reasoning: { effort: testCase.effort },
          test_response_model: testCase.model,
          test_reasoning_tokens: 128,
        }),
      });
      assert(response.status === 200, `${testCase.model}/${testCase.effort} 请求失败: ${response.status}`);
    }

    for (const testCase of [
      {
        model: "gpt-5.6-sol-2026-07-13",
        expectedFamily: "gpt-5.6-sol",
      },
      {
        model: "gpt-5.6-solar",
        expectedFamily: "other",
      },
      {
        model: "gpt-5.6-terrain",
        expectedFamily: "other",
      },
      {
        model: "gpt-5.6-lunatic",
        expectedFamily: "other",
      },
    ]) {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: testCase.model,
          reasoning: { effort: "medium" },
          test_response_model: testCase.model,
          test_reasoning_tokens: 128,
        }),
      });
      assert(response.status === 200, `${testCase.model} 模型边界请求失败: ${response.status}`);
    }

    const gpt56Analytics = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning`,
    ).then((response) => response.json());
    for (const testCase of gpt56Cases) {
      assert(
        gpt56Analytics.by_model_family?.some((entry) => entry.model_family === testCase.model),
        `reasoning analytics 未区分 ${testCase.model}`,
      );
      assert(
        gpt56Analytics.by_model_family_and_effort?.some(
          (entry) => entry.group_key === `${testCase.model}|${testCase.effort}`,
        ),
        `reasoning analytics 未保留 ${testCase.model}/${testCase.effort} 分桶`,
      );
    }
    assert(
      gpt56Analytics.by_reasoning_effort?.some((entry) => entry.reasoning_effort === "max") &&
        gpt56Analytics.by_reasoning_effort?.some((entry) => entry.reasoning_effort === "ultra"),
      "reasoning analytics 未区分 max/ultra 思考等级",
    );
    const gpt56MismatchResponse = await fetch(`http://127.0.0.1:${gatewayPort}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        reasoning: { effort: "max" },
        test_response_model: "gpt-5.6-terra",
        test_reasoning_tokens: 128,
      }),
    });
    assert(gpt56MismatchResponse.status === 200, `GPT-5.6 跨变体 mismatch 请求失败: ${gpt56MismatchResponse.status}`);

    const gpt56ExportJson = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning/export?format=json`,
    ).then((response) => response.json());
    for (const testCase of gpt56Cases) {
      assert(
        gpt56ExportJson.samples?.some(
          (sample) =>
            sample.request_model === testCase.model &&
            sample.request_reasoning_effort === testCase.effort,
        ),
        `reasoning JSON 导出缺少 ${testCase.model}/${testCase.effort}`,
      );
    }
    for (const [model, expectedFamily] of [
      ["gpt-5.6-sol-2026-07-13", "gpt-5.6-sol"],
      ["gpt-5.6-solar", "other"],
      ["gpt-5.6-terrain", "other"],
      ["gpt-5.6-lunatic", "other"],
    ]) {
      assert(
        gpt56ExportJson.samples?.some(
          (sample) =>
            sample.request_model === model &&
            sample.request_model_family === expectedFamily,
        ),
        `reasoning JSON 导出的模型边界归类错误: ${model} -> ${expectedFamily}`,
      );
    }
    const gpt56ExportCsv = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning/export?format=csv`,
    ).then((response) => response.text());
    for (const value of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "max", "ultra"]) {
      assert(gpt56ExportCsv.includes(value), `reasoning CSV 导出缺少 ${value}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
    const gpt56DayFiles = (await readdir(path.join(tempRoot, "analytics"))).filter(
      (name) => name.startsWith("reasoning-behavior-") && name.endsWith(".json"),
    );
    const persistedGpt56Samples = (
      await Promise.all(
        gpt56DayFiles.map(async (name) =>
          JSON.parse(await readFile(path.join(tempRoot, "analytics", name), "utf8")),
        ),
      )
    ).flatMap((payload) => payload.samples || []);
    for (const testCase of gpt56Cases) {
      assert(
        persistedGpt56Samples.some(
          (sample) =>
            sample.request_model === testCase.model &&
            sample.request_reasoning_effort === testCase.effort,
        ),
        `reasoning 日文件缺少 ${testCase.model}/${testCase.effort}`,
      );
    }

    const familyMismatchResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.4",
          test_response_model: "gpt-5.4-mini",
        }),
      },
    );
    assert(
      familyMismatchResponse.status === 200,
      `模型声明不一致请求失败: ${familyMismatchResponse.status}`,
    );

    const lowContextResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.4",
          test_error_status: 400,
          test_error_payload: {
            error: {
              code: "context_length_exceeded",
              message: "request too large for 400000 context window",
            },
          },
        }),
      },
    );
    assert(
      lowContextResponse.status === 400,
      `400K 家族异常未保留上游状态: ${lowContextResponse.status}`,
    );

    for (const streamPath of [
      "/responses",
      "/v1/responses",
      "/chat/completions",
      "/v1/chat/completions",
    ]) {
      const blockedStream = await readSseUntilClose(
        `http://127.0.0.1:${gatewayPort}${streamPath}`,
        { stream: true, test_reasoning_tokens: 516 },
      );
      assert(
        blockedStream.status === 502,
        `${streamPath} 516 未返回 502: ${blockedStream.status}`,
      );
      assert(
        !blockedStream.text.includes("hello"),
        `${streamPath} 严格 502 模式不应先透传正常 chunk`,
      );
      assert(
        !blockedStream.text.includes("[DONE]"),
        `${streamPath} 严格 502 模式不应回放 DONE`,
      );
      const blockedStreamBody = JSON.parse(blockedStream.text);
      assert(
        blockedStreamBody?.error?.code === "reasoning_guard_triggered",
        `${streamPath} 流式 516 返回体不正确`,
      );

      const okStream = await readSseUntilClose(
        `http://127.0.0.1:${gatewayPort}${streamPath}`,
        { stream: true, test_reasoning_tokens: 128 },
      );
      assert(
        okStream.status === 200,
        `${streamPath} 128 首状态异常: ${okStream.status}`,
      );
      assert(
        okStream.text.includes("[DONE]"),
        `${streamPath} 流式 128 未完整结束`,
      );
      assert(!okStream.closedByError, `${streamPath} 流式 128 不应异常断开`);
    }

    const blockedStreamWithEventIds = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        model: "gpt-5.4",
        stream: true,
        test_reasoning_tokens: 516,
        test_stream_models: ["gpt-5.4", "gpt-5.4"],
        test_stream_fingerprints: ["fp_same", "fp_same"],
        test_response_ids: ["resp_same", "resp_same"],
        test_stream_event_ids: ["evt_same_1", "evt_same_2"],
        test_stream_delta_omit_response_id: true,
      },
    );
    assert(
      blockedStreamWithEventIds.status === 502,
      `带事件 id 的 516 流式请求未返回 502: ${blockedStreamWithEventIds.status}`,
    );
    const statusAfterBlockedStream = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      statusAfterBlockedStream.model_insights.single_request_anomalies
        ?.rebuild_suspected_count === 0,
      "正常拦截 516 不应计入疑似请求内重建/重试",
    );
    assert(
      !statusAfterBlockedStream.model_insights.suspicious_samples?.some(
        (sample) =>
          sample.path === "/responses" &&
          sample.anomaly_type === "single_request_rebuild_suspected",
      ),
      "正常拦截 516 不应生成 single_request_rebuild_suspected 可疑样本",
    );

    const driftedStream = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        model: "gpt-5.5",
        stream: true,
        test_reasoning_tokens: 128,
        test_stream_models: ["gpt-5.5", "gpt-5.4-mini"],
        test_stream_fingerprints: ["fp_stream_a", "fp_stream_b"],
      },
    );
    assert(
      driftedStream.status === 200,
      `单请求模型漂移流未透传成功: ${driftedStream.status}`,
    );

    const rebuildSuspectedStream = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/chat/completions`,
      {
        model: "gpt-5.5",
        stream: true,
        test_reasoning_tokens: 128,
        test_stream_models: ["gpt-5.5", "gpt-5.5"],
        test_stream_fingerprints: ["fp_chat_a", "fp_chat_b"],
      },
    );
    assert(
      rebuildSuspectedStream.status === 200,
      `疑似请求内重建流未透传成功: ${rebuildSuspectedStream.status}`,
    );

    const terminatedStream = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      { stream: true, test_force_terminate: true },
    );
    assert(
      terminatedStream.status === 502,
      `/responses 上游半路断流未返回 502: ${terminatedStream.status}`,
    );

    const statusWithModelInsights = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      statusWithModelInsights.model_insights,
      "status 缺少 model_insights",
    );
    assert(
      statusWithModelInsights.model_insights.consistency?.matched >= 2,
      "模型一致性 matched 统计未记录 gpt-5.4 / gpt-5.5 一致请求",
    );
    assert(
      statusWithModelInsights.model_insights.consistency?.mismatched >= 1,
      "模型一致性 mismatched 统计未记录声明不一致请求",
    );
    assert(
      Math.abs(
        statusWithModelInsights.model_insights.consistency?.match_ratio -
          statusWithModelInsights.model_insights.consistency?.matched /
            (statusWithModelInsights.model_insights.consistency?.matched +
              statusWithModelInsights.model_insights.consistency?.mismatched),
      ) < 1e-9,
      "声明一致率应只按 matched / (matched + mismatched) 计算，不应把 unknown 计入分母",
    );
    assert(
      statusWithModelInsights.model_insights.anomalies
        ?.low_context_family_count >= 1,
      "400K 家族异常统计未记录",
    );
    assert(
      statusWithModelInsights.model_insights.single_request_anomalies
        ?.model_drift_count >= 1,
      "单请求模型漂移统计未记录",
    );
    assert(
      statusWithModelInsights.model_insights.single_request_anomalies
        ?.rebuild_suspected_count >= 1,
      "疑似请求内重建/重试统计未记录",
    );
    assert(
      Array.isArray(
        statusWithModelInsights.model_insights.suspicious_samples,
      ) &&
        statusWithModelInsights.model_insights.suspicious_samples.length >= 3,
      "可疑样本未保留",
    );
    assert(
      statusWithModelInsights.model_insights.suspicious_samples.some(
        (sample) =>
          Array.isArray(sample.evidence_logs) &&
          sample.evidence_logs.length > 0,
      ),
      "可疑样本未保留日志证据",
    );
    const familyBreakdown =
      statusWithModelInsights.model_insights.family_breakdown;
    assert(familyBreakdown, "status 缺少 family_breakdown");
    for (const testCase of gpt56Cases) {
      assert(
        familyBreakdown[testCase.model]?.consistency?.matched >= 1,
        `模型一致性统计未记录 ${testCase.model}: ${JSON.stringify(familyBreakdown[testCase.model])}`,
      );
    }
    assert(
      familyBreakdown["gpt-5.6-sol"]?.consistency?.mismatched >= 1,
      "模型一致性未把 gpt-5.6-sol -> gpt-5.6-terra 记为跨变体 mismatch",
    );
    assert(
      familyBreakdown["gpt-5.4"]?.consistency?.total_checked === 20,
      `gpt-5.4 家族 total_checked 统计不正确: ${familyBreakdown["gpt-5.4"]?.consistency?.total_checked}`,
    );
    assert(
      familyBreakdown["gpt-5.4"]?.consistency?.matched === 17,
      `gpt-5.4 家族 matched 统计不正确: ${familyBreakdown["gpt-5.4"]?.consistency?.matched}`,
    );
    assert(
      familyBreakdown["gpt-5.4"]?.consistency?.mismatched === 1,
      "gpt-5.4 家族 mismatched 统计不正确",
    );
    assert(
      familyBreakdown["gpt-5.4"]?.consistency?.unknown === 2,
      "gpt-5.4 家族 unknown 统计不正确",
    );
    assert(
      Math.abs(familyBreakdown["gpt-5.4"]?.consistency?.match_ratio - 17 / 18) <
        1e-9,
      "gpt-5.4 家族声明一致率应排除 unknown",
    );
    assert(
      familyBreakdown["gpt-5.4"]?.anomalies?.low_context_family_count === 1,
      "gpt-5.4 家族 400K 异常统计不正确",
    );
    assert(
      familyBreakdown["gpt-5.4"]?.single_request_anomalies
        ?.model_drift_count === 0,
      "gpt-5.4 家族 model_drift_count 统计不正确",
    );
    assert(
      familyBreakdown["gpt-5.4"]?.single_request_anomalies
        ?.fingerprint_drift_count === 0,
      "gpt-5.4 家族 fingerprint_drift_count 统计不正确",
    );
    assert(
      familyBreakdown["gpt-5.4"]?.single_request_anomalies
        ?.rebuild_suspected_count === 0,
      "gpt-5.4 家族 rebuild_suspected_count 统计不正确",
    );
    const family55Consistency = familyBreakdown["gpt-5.5"]?.consistency || {};
    assert(
      family55Consistency.total_checked >= 36,
      `gpt-5.5 家族 total_checked 应包含续写恢复新增样本: ${family55Consistency.total_checked}`,
    );
    assert(
      Number.isInteger(family55Consistency.matched) &&
        Number.isInteger(family55Consistency.mismatched) &&
        Number.isInteger(family55Consistency.unknown) &&
        family55Consistency.matched >= 0 &&
        family55Consistency.mismatched >= 0 &&
        family55Consistency.unknown >= 0,
      `gpt-5.5 家族 consistency 计数应为非负整数: ${JSON.stringify(family55Consistency)}`,
    );
    assert(
      family55Consistency.matched >= 1 &&
        family55Consistency.mismatched >= 1 &&
        family55Consistency.unknown >= 1,
      `gpt-5.5 家族应保留既有 matched / mismatch / unknown 分类信号: ${JSON.stringify(family55Consistency)}`,
    );
    assert(
      family55Consistency.matched +
        family55Consistency.mismatched +
        family55Consistency.unknown ===
        family55Consistency.total_checked,
      "gpt-5.5 家族 total_checked 应等于 matched+mismatched+unknown",
    );
    assert(
      Math.abs(
        family55Consistency.match_ratio -
          family55Consistency.matched /
            (family55Consistency.matched + family55Consistency.mismatched),
      ) < 1e-9,
      "gpt-5.5 家族声明一致率应排除 unknown",
    );
    assert(
      familyBreakdown["gpt-5.5"]?.anomalies?.low_context_family_count === 0,
      "gpt-5.5 家族 400K 异常统计不正确",
    );
    assert(
      familyBreakdown["gpt-5.5"]?.single_request_anomalies
        ?.model_drift_count === 1,
      "gpt-5.5 家族 model_drift_count 统计不正确",
    );
    assert(
      familyBreakdown["gpt-5.5"]?.single_request_anomalies
        ?.fingerprint_drift_count === 1,
      "gpt-5.5 家族 fingerprint_drift_count 统计不正确",
    );
    assert(
      familyBreakdown["gpt-5.5"]?.single_request_anomalies
        ?.rebuild_suspected_count === 1,
      "gpt-5.5 家族 rebuild_suspected_count 统计不正确",
    );

    await mkdir(probeConfigDir, { recursive: true });
    await writeFile(
      probeCodexConfigPath,
      'model = "gpt-5.5"\n[model_providers.fake]\nrequires_openai_auth = true\n',
      "utf8",
    );
    await writeFile(
      path.join(probeConfigDir, "state.json"),
      `${JSON.stringify({ codex_config_path: probeCodexConfigPath, provider_name: "fake" }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(probeConfigDir, "auth.json"),
      `${JSON.stringify({ OPENAI_API_KEY: "sk-probe-test" }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(tempRoot, "auth.json"),
      `${JSON.stringify({ OPENAI_API_KEY: "sk-probe-test" }, null, 2)}\n`,
      "utf8",
    );
    const probeConfig = {
      ...config,
      listen_port: probeGatewayPort,
      active_probe: {
        enabled: true,
        interval_ms: 60 * 60 * 1000,
        startup_delay_ms: 20,
        timeout_ms: 3000,
        target_families: ["gpt-5.5"],
        endpoint_candidates: ["/responses"],
        image_input: {
          enabled: true,
        },
        response_structure: {
          enabled: false,
          repeat_count: 2,
        },
        identity_consistency: {
          enabled: false,
          repeat_count: 2,
        },
        knowledge_cutoff: {
          enabled: false,
          max_questions: 3,
        },
        long_context: {
          enabled: true,
          target_input_tokens: 450000,
        },
      },
    };
    await writeFile(
      probeConfigPath,
      JSON.stringify(probeConfig, null, 2),
      "utf8",
    );
    probeGateway = startGateway(probeConfigPath, probeLogPath);
    await waitForHealth(
      `http://127.0.0.1:${probeGatewayPort}${config.health_path}`,
      { gateway: probeGateway, logPath: probeLogPath },
    );
    const probeStatus = await waitForStatusCondition(
      `http://127.0.0.1:${probeGatewayPort}/__codex_retry_gateway/api/status`,
      (payload) =>
        Number(payload?.active_probe?.total_runs) >= 1 &&
        Number(payload?.active_probe?.violation_count) >= 2,
      5000,
    );
    assert(
      probeStatus.active_probe.total_runs === 1,
      `主动探针首轮 total_runs 不正确: ${probeStatus.active_probe.total_runs}`,
    );
    assert(
      probeStatus.active_probe.violation_count === 2,
      `主动长上下文探针未计入 violation_count: ${probeStatus.active_probe.violation_count}`,
    );
    assert(
      probeStatus.active_probe.transport_error_count === 0,
      `主动探针不应把鉴权成功后的请求记成 transport_error: ${probeStatus.active_probe.transport_error_count}`,
    );
    assert(
      probeStatus.active_probe.violation_type_counts
        ?.probe_low_context_family_violation === 1,
      "主动长上下文探针未记录 probe_low_context_family_violation",
    );
    assert(
      probeStatus.active_probe.violation_type_counts
        ?.probe_image_input_violation === 1,
      "主动图片输入探针未记录 probe_image_input_violation",
    );
    assert(
      probeStatus.active_probe.last_target_model === "gpt-5.5",
      `主动探针目标模型不正确: ${probeStatus.active_probe.last_target_model}`,
    );
    assert(
      probeStatus.active_probe.last_target_family === "gpt-5.5",
      `主动探针目标家族不正确: ${probeStatus.active_probe.last_target_family}`,
    );
    assert(
      probeStatus.metrics.total_proxy_request_count === 0,
      `主动探针不应污染普通代理统计: ${probeStatus.metrics.total_proxy_request_count}`,
    );
    assert(
      Array.isArray(probeStatus.active_probe.recent_samples) &&
        probeStatus.active_probe.recent_samples.some(
          (sample) =>
            sample.probe_type === "long_context" &&
            sample.result_type === "probe_low_context_family_violation",
        ),
      "主动长上下文探针未保留违约样本",
    );
    const longContextProbeSample = probeStatus.active_probe.recent_samples.find(
      (sample) => sample.probe_type === "long_context",
    );
    assert(longContextProbeSample, "主动长上下文探针缺少样本");
    assert(
      longContextProbeSample.requested_input_tokens === 450000,
      `主动长上下文探针未记录 requested_input_tokens: ${longContextProbeSample.requested_input_tokens}`,
    );
    assert(
      longContextProbeSample.token_budget_source === "response_usage",
      `主动长上下文探针 token_budget_source 不正确: ${longContextProbeSample.token_budget_source}`,
    );
    assert(
      longContextProbeSample.evidence_logs.some((entry) =>
        `${entry.message || ""}`.includes("target_input_tokens=450000"),
      ),
      "主动长上下文探针未保留 token budget 证据",
    );
    assert(
      probeStatus.active_probe.recent_samples.some(
        (sample) =>
          sample.probe_type === "image_input" &&
          sample.result_type === "probe_image_input_violation",
      ),
      "主动图片输入探针未保留违约样本",
    );
    const initialLongContextProbeRequests = upstream.probeRequests.filter(
      (entry) => entry.probeType === "long_context",
    );
    assert(
      initialLongContextProbeRequests.length >= 3,
      `主动长上下文探针首轮请求数过少: ${initialLongContextProbeRequests.length}`,
    );
    const initialBudgetProbeRequests = initialLongContextProbeRequests.filter(
      (entry) => `${entry.phase || ""}`.startsWith("budget"),
    );
    assert(
      initialBudgetProbeRequests.length >= 1,
      "主动长上下文探针首轮缺少预算请求",
    );
    assert(
      initialBudgetProbeRequests.every(
        (entry) => Number(entry.units) >= 400000,
      ),
      `主动长上下文探针预算请求 unit_count 过小: ${JSON.stringify(initialBudgetProbeRequests.map((entry) => entry.units))}`,
    );
    assert(
      initialLongContextProbeRequests.every(
        (entry) =>
          typeof entry.headers.userAgent === "string" &&
          entry.headers.userAgent.trim() !== "" &&
          !/^node$/i.test(entry.headers.userAgent.trim()),
      ),
      `主动探针缺少明确 User-Agent: ${JSON.stringify(initialLongContextProbeRequests.map((entry) => entry.headers.userAgent))}`,
    );
    assert(
      initialLongContextProbeRequests.every(
        (entry) => entry.body?.reasoning?.effort === "medium",
      ),
      `主动探针默认 reasoning.effort 不正确: ${JSON.stringify(initialLongContextProbeRequests.map((entry) => entry.body?.reasoning?.effort ?? null))}`,
    );
    const primedProbeUserAgent = "CodexDesktop/active-probe-test";
    const primedResponse = await fetch(
      `http://127.0.0.1:${probeGatewayPort}/responses`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": primedProbeUserAgent,
          "openai-beta": "responses=v1",
          "x-stainless-lang": "js",
        },
        body: JSON.stringify({
          model: "gpt-5.6-terra",
          reasoning: {
            effort: "ultra",
          },
          test_reasoning_tokens: 128,
        }),
      },
    );
    assert(
      primedResponse.status === 200,
      `主动探针画像预热请求失败: ${primedResponse.status}`,
    );
    const probeRequestCountBeforeManualDualRun = upstream.probeRequests.length;
    const manualDualProbeResponse = await fetch(
      `http://127.0.0.1:${probeGatewayPort}/__codex_retry_gateway/api/probe/run`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          active_probe: {
            enabled: false,
            interval_ms: 5 * 60 * 1000,
            target_families: [
              "gpt-5.4",
              "gpt-5.5",
              "gpt-5.6-sol",
              "gpt-5.6-terra",
              "gpt-5.6-luna",
            ],
          },
        }),
      },
    );
    assert(
      manualDualProbeResponse.status === 202,
      `双模型手动探针触发失败: ${manualDualProbeResponse.status}`,
    );
    const manualDualProbePayload = await manualDualProbeResponse.json();
    assert(manualDualProbePayload.ok === true, "双模型手动探针响应 ok 不正确");
    assert(
      manualDualProbePayload.active_probe?.running === true,
      "双模型手动探针触发后应立即进入 running 状态",
    );
    const dualProbeStatus = await waitForStatusCondition(
      `http://127.0.0.1:${probeGatewayPort}/__codex_retry_gateway/api/status`,
      (payload) =>
        Number(payload?.active_probe?.total_runs) >= 2 &&
        payload?.active_probe?.running === false &&
        Array.isArray(payload?.active_probe?.recent_samples) &&
        payload.active_probe.recent_samples.length >= 10,
      5000,
    );
    assert(
      dualProbeStatus.active_probe.total_runs === 2,
      `双模型手动探针 total_runs 不正确: ${dualProbeStatus.active_probe.total_runs}`,
    );
    const dualProbeSamples = dualProbeStatus.active_probe.recent_samples.slice(
      0,
      10,
    );
    assert(
      dualProbeSamples.length === 10,
      `五模型手动探针最近样本应为 10 条，实际 ${dualProbeSamples.length}`,
    );
    assert(
      dualProbeSamples.filter(
        (sample) =>
          sample.target_model === "gpt-5.4" &&
          sample.probe_type === "long_context",
      ).length === 1,
      "双模型手动探针缺少 gpt-5.4 long_context 样本",
    );
    assert(
      dualProbeSamples.filter(
        (sample) =>
          sample.target_model === "gpt-5.4" &&
          sample.probe_type === "image_input",
      ).length === 1,
      "双模型手动探针缺少 gpt-5.4 image_input 样本",
    );
    assert(
      dualProbeSamples.filter(
        (sample) =>
          sample.target_model === "gpt-5.5" &&
          sample.probe_type === "long_context",
      ).length === 1,
      "双模型手动探针缺少 gpt-5.5 long_context 样本",
    );
    assert(
      dualProbeSamples.filter(
        (sample) =>
          sample.target_model === "gpt-5.5" &&
          sample.probe_type === "image_input",
      ).length === 1,
      "双模型手动探针缺少 gpt-5.5 image_input 样本",
    );
    for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      for (const probeType of ["long_context", "image_input"]) {
        assert(
          dualProbeSamples.filter(
            (sample) => sample.target_model === model && sample.probe_type === probeType,
          ).length === 1,
          `五模型手动探针缺少 ${model} ${probeType} 样本`,
        );
      }
    }
    assert(
      dualProbeSamples.every((sample) => sample.http_status === 400),
      `双模型手动探针状态码应为 400 违约，实际 ${JSON.stringify(dualProbeSamples.map((sample) => sample.http_status))}`,
    );
    assert(
      dualProbeSamples.every((sample) => sample.confidence === "high"),
      `双模型手动探针违约 confidence 应为 high，实际 ${JSON.stringify(dualProbeSamples.map((sample) => sample.confidence))}`,
    );
    const inheritedProbeRequests = upstream.probeRequests.slice(
      probeRequestCountBeforeManualDualRun,
    );
    assert(
      inheritedProbeRequests.length >= 20,
      `五模型手动探针请求数过少: ${inheritedProbeRequests.length}`,
    );
    assert(
      inheritedProbeRequests.every(
        (entry) => entry.headers.userAgent === primedProbeUserAgent,
      ),
      `主动探针未继承最近真实请求的 User-Agent: ${JSON.stringify(inheritedProbeRequests.map((entry) => entry.headers.userAgent))}`,
    );
    const expectedProbeEffortByModel = {
      "gpt-5.4": "xhigh",
      "gpt-5.5": "xhigh",
      "gpt-5.6-sol": "ultra",
      "gpt-5.6-terra": "ultra",
      "gpt-5.6-luna": "max",
    };
    assert(
      inheritedProbeRequests.every(
        (entry) =>
          entry.body?.reasoning?.effort === expectedProbeEffortByModel[entry.body?.model],
      ),
      `主动探针未按目标模型能力约束继承的 reasoning.effort: ${JSON.stringify(
        inheritedProbeRequests.map((entry) => ({
          model: entry.body?.model ?? null,
          effort: entry.body?.reasoning?.effort ?? null,
        })),
      )}`,
    );
    const inheritedBudgetProbeRequests = inheritedProbeRequests.filter(
      (entry) =>
        entry.probeType === "long_context" &&
        `${entry.phase || ""}`.startsWith("budget"),
    );
    assert(
      inheritedBudgetProbeRequests.length >= 5,
      "五模型手动探针缺少长上下文预算请求",
    );
    assert(
      inheritedBudgetProbeRequests.every(
        (entry) => Number(entry.units) >= 400000,
      ),
      `双模型手动探针预算请求 unit_count 过小: ${JSON.stringify(inheritedBudgetProbeRequests.map((entry) => entry.units))}`,
    );

    const minimalPrimingResponse = await fetch(
      `http://127.0.0.1:${probeGatewayPort}/responses`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": primedProbeUserAgent,
        },
        body: JSON.stringify({
          model: "gpt-5.6-terra",
          reasoning: { effort: "minimal" },
          test_reasoning_tokens: 128,
        }),
      },
    );
    assert(minimalPrimingResponse.status === 200, "主动探针 minimal 画像预热请求失败");
    const probeRequestCountBeforeMinimalRun = upstream.probeRequests.length;
    const minimalProbeResponse = await fetch(
      `http://127.0.0.1:${probeGatewayPort}/__codex_retry_gateway/api/probe/run`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          active_probe: {
            enabled: false,
            interval_ms: 5 * 60 * 1000,
            target_families: Object.keys(expectedProbeEffortByModel),
          },
        }),
      },
    );
    assert(minimalProbeResponse.status === 202, "主动探针 minimal 下限裁剪运行未启动");
    await waitForStatusCondition(
      `http://127.0.0.1:${probeGatewayPort}/__codex_retry_gateway/api/status`,
      (payload) => Number(payload?.active_probe?.total_runs) >= 3 && payload?.active_probe?.running === false,
      5000,
    );
    const minimalProbeRequests = upstream.probeRequests.slice(probeRequestCountBeforeMinimalRun);
    assert(minimalProbeRequests.length >= 20, "主动探针 minimal 下限裁剪请求数不足");
    assert(
      minimalProbeRequests.every((entry) => entry.body?.reasoning?.effort === "low"),
      `主动探针未把 minimal 按目标模型下限裁剪为 low: ${JSON.stringify(
        minimalProbeRequests.map((entry) => ({
          model: entry.body?.model ?? null,
          effort: entry.body?.reasoning?.effort ?? null,
        })),
      )}`,
    );

    await mkdir(warningProbeConfigDir, { recursive: true });
    await writeFile(
      warningProbeCodexConfigPath,
      'model = "gpt-5.5"\n[model_providers.fake]\nrequires_openai_auth = true\n',
      "utf8",
    );
    await writeFile(
      path.join(warningProbeRoot, "state.json"),
      `${JSON.stringify({ codex_config_path: warningProbeCodexConfigPath, provider_name: "fake" }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(warningProbeConfigDir, "auth.json"),
      `${JSON.stringify({ OPENAI_API_KEY: "sk-probe-test" }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(warningProbeRoot, "auth.json"),
      `${JSON.stringify({ OPENAI_API_KEY: "sk-probe-test" }, null, 2)}\n`,
      "utf8",
    );
    const warningProbeConfig = {
      ...config,
      listen_port: warningProbeGatewayPort,
      active_probe: {
        enabled: true,
        interval_ms: 60 * 60 * 1000,
        startup_delay_ms: 20,
        timeout_ms: 3000,
        target_families: ["gpt-5.5"],
        endpoint_candidates: ["/responses"],
        image_input: {
          enabled: false,
        },
        response_structure: {
          enabled: true,
          repeat_count: 2,
        },
        identity_consistency: {
          enabled: true,
          repeat_count: 2,
        },
        knowledge_cutoff: {
          enabled: true,
          max_questions: 3,
        },
        long_context: {
          enabled: false,
          target_input_tokens: 450000,
        },
      },
    };
    await writeFile(
      warningProbeConfigPath,
      JSON.stringify(warningProbeConfig, null, 2),
      "utf8",
    );
    warningProbeGateway = startGateway(
      warningProbeConfigPath,
      warningProbeLogPath,
    );
    await waitForHealth(
      `http://127.0.0.1:${warningProbeGatewayPort}${config.health_path}`,
      { gateway: warningProbeGateway, logPath: warningProbeLogPath },
    );
    const warningProbeStatus = await waitForStatusCondition(
      `http://127.0.0.1:${warningProbeGatewayPort}/__codex_retry_gateway/api/status`,
      (payload) =>
        Number(payload?.active_probe?.total_runs) >= 1 &&
        Number(payload?.active_probe?.warning_count) >= 3,
      5000,
    );
    assert(
      warningProbeStatus.active_probe.total_runs === 1,
      `辅助探针首轮 total_runs 不正确: ${warningProbeStatus.active_probe.total_runs}`,
    );
    assert(
      warningProbeStatus.active_probe.warning_count === 3,
      `辅助探针 warning_count 不正确: ${warningProbeStatus.active_probe.warning_count}`,
    );
    assert(
      warningProbeStatus.active_probe.violation_count === 0,
      `辅助探针不应计入 violation_count: ${warningProbeStatus.active_probe.violation_count}`,
    );
    assert(
      warningProbeStatus.active_probe.warning_type_counts
        ?.probe_response_structure_warning === 1,
      "响应结构辅助探针未记录 probe_response_structure_warning",
    );
    assert(
      warningProbeStatus.active_probe.warning_type_counts
        ?.probe_identity_consistency_warning === 1,
      "身份一致性辅助探针未记录 probe_identity_consistency_warning",
    );
    assert(
      warningProbeStatus.active_probe.warning_type_counts
        ?.probe_knowledge_cutoff_warning === 1,
      "训练截止日期辅助探针未记录 probe_knowledge_cutoff_warning",
    );
    assert(
      warningProbeStatus.metrics.total_proxy_request_count === 0,
      `辅助探针不应污染普通代理统计: ${warningProbeStatus.metrics.total_proxy_request_count}`,
    );
    assert(
      warningProbeStatus.active_probe.recent_samples.some(
        (sample) =>
          sample.probe_type === "response_structure" &&
          sample.result === "warning" &&
          sample.result_type === "probe_response_structure_warning",
      ),
      "响应结构辅助探针未保留 warning 样本",
    );
    assert(
      warningProbeStatus.active_probe.recent_samples.some(
        (sample) =>
          sample.probe_type === "identity_consistency" &&
          sample.result === "warning" &&
          sample.result_type === "probe_identity_consistency_warning",
      ),
      "身份一致性辅助探针未保留 warning 样本",
    );
    assert(
      warningProbeStatus.active_probe.recent_samples.some(
        (sample) =>
          sample.probe_type === "knowledge_cutoff" &&
          sample.result === "warning" &&
          sample.result_type === "probe_knowledge_cutoff_warning",
      ),
      "训练截止日期辅助探针未保留 warning 样本",
    );

    const probeAuthPath = path.join(tempRoot, "auth.json");
    const probeAuthBackupContent = await readFile(probeAuthPath, "utf8");
    try {
      await writeFile(
        probeAuthPath,
        `${JSON.stringify({ OPENAI_API_KEY: "sk-probe-blocked" }, null, 2)}\n`,
        "utf8",
      );
      const blockedProbeResponse = await fetch(
        `http://127.0.0.1:${probeGatewayPort}/__codex_retry_gateway/api/probe/run`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            active_probe: {
              enabled: false,
              interval_ms: 5 * 60 * 1000,
              target_families: ["gpt-5.4"],
            },
          }),
        },
      );
      assert(
        blockedProbeResponse.status === 202,
        `上游阻断探针触发失败: ${blockedProbeResponse.status}`,
      );
      const blockedProbeStatus = await waitForStatusCondition(
        `http://127.0.0.1:${probeGatewayPort}/__codex_retry_gateway/api/status`,
        (payload) =>
          Number(payload?.active_probe?.total_runs) >= 3 &&
          payload?.active_probe?.running === false &&
          Number(payload?.active_probe?.transport_error_count) >= 2,
        5000,
      );
      assert(
        blockedProbeStatus.active_probe.transport_error_count === 2,
        `上游阻断探针 transport_error_count 不正确: ${blockedProbeStatus.active_probe.transport_error_count}`,
      );
      const blockedProbeSamples =
        blockedProbeStatus.active_probe.recent_samples.slice(0, 2);
      assert(
        blockedProbeSamples.length === 2,
        `上游阻断探针最近样本应为 2 条，实际 ${blockedProbeSamples.length}`,
      );
      assert(
        blockedProbeSamples.every(
          (sample) => sample.result === "transport_error",
        ),
        "上游阻断探针结果应为 transport_error",
      );
      assert(
        blockedProbeSamples.every((sample) => sample.http_status === 502),
        `上游阻断探针状态码应为 502，实际 ${JSON.stringify(blockedProbeSamples.map((sample) => sample.http_status))}`,
      );
      assert(
        blockedProbeSamples.every((sample) => sample.confidence == null),
        "上游阻断探针 confidence 应为空",
      );
      assert(
        blockedProbeSamples.every(
          (sample) =>
            typeof sample.error_excerpt === "string" &&
            sample.error_excerpt.includes("upstream_error"),
        ),
        "上游阻断探针应保留 upstream_error 摘要",
      );
      assert(
        blockedProbeSamples.every(
          (sample) =>
            Array.isArray(sample.evidence_logs) &&
            sample.evidence_logs.some((entry) =>
              String(entry?.message || "").includes("finish type="),
            ) &&
            sample.evidence_logs.some((entry) =>
              String(entry?.message || "").includes("detail=upstream_error"),
            ),
        ),
        "上游阻断探针样本应保留结束日志和 upstream_error 细节",
      );
    } finally {
      await writeFile(probeAuthPath, probeAuthBackupContent, "utf8");
    }

    const unauthProbeGatewayPort = await getFreePort();
    const unauthProbeConfigDir = path.join(tempRoot, "unauth-probe", "config");
    const unauthProbeConfigPath = path.join(
      unauthProbeConfigDir,
      "config.json",
    );
    const unauthProbeLogPath = path.join(
      tempRoot,
      "unauth-probe",
      "gateway.log",
    );
    const unauthProbeCodexConfigPath = path.join(
      tempRoot,
      "unauth-probe",
      "codex-config.toml",
    );
    const unauthProbeStatePath = path.join(
      tempRoot,
      "unauth-probe",
      "state.json",
    );
    await mkdir(unauthProbeConfigDir, { recursive: true });
    await writeFile(
      unauthProbeCodexConfigPath,
      'model = "gpt-5.5"\n[model_providers.fake]\nrequires_openai_auth = true\n',
      "utf8",
    );
    await writeFile(
      unauthProbeStatePath,
      `${JSON.stringify({ codex_config_path: unauthProbeCodexConfigPath, provider_name: "fake" }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(path.join(tempRoot, "unauth-probe", "auth.json"), "{}\n", "utf8");
    let unauthProbeGateway = null;
    try {
      const unauthProbeConfig = {
        ...config,
        listen_port: unauthProbeGatewayPort,
        active_probe: {
          enabled: true,
          interval_ms: 60 * 60 * 1000,
          startup_delay_ms: 20,
          timeout_ms: 3000,
          target_families: ["gpt-5.5"],
          endpoint_candidates: ["/responses"],
          image_input: {
            enabled: true,
          },
          response_structure: {
            enabled: false,
            repeat_count: 2,
          },
          identity_consistency: {
            enabled: false,
            repeat_count: 2,
          },
          knowledge_cutoff: {
            enabled: false,
            max_questions: 3,
          },
          long_context: {
            enabled: true,
            target_input_tokens: 450000,
          },
        },
      };
      await writeFile(
        unauthProbeConfigPath,
        JSON.stringify(unauthProbeConfig, null, 2),
        "utf8",
      );
      unauthProbeGateway = startGateway(
        unauthProbeConfigPath,
        unauthProbeLogPath,
      );
      await waitForHealth(
        `http://127.0.0.1:${unauthProbeGatewayPort}${config.health_path}`,
        { gateway: unauthProbeGateway, logPath: unauthProbeLogPath },
      );
      const unauthProbeStatus = await waitForStatusCondition(
        `http://127.0.0.1:${unauthProbeGatewayPort}/__codex_retry_gateway/api/status`,
        (payload) =>
          Number(payload?.active_probe?.total_runs) >= 1 &&
          Array.isArray(payload?.active_probe?.recent_samples) &&
          payload.active_probe.recent_samples.length >= 2,
        5000,
      );
      assert(
        unauthProbeStatus.active_probe.recent_samples.every(
          (sample) => sample.http_status === 401,
        ),
        `缺鉴权时主动探针状态码应为 401，实际 ${JSON.stringify(unauthProbeStatus.active_probe.recent_samples.map((sample) => sample.http_status))}`,
      );
      const unauthProbeRequests = upstream.probeRequests.filter(
        (entry) => entry.headers?.authorization === "",
      );
      assert(
        unauthProbeRequests.length >= 2,
        `缺鉴权主动探针不应从真实 home fallback 读取 auth: ${JSON.stringify(upstream.probeRequests.slice(-4).map((entry) => entry.headers?.authorization))}`,
      );
      assert(
        unauthProbeStatus.active_probe.recent_samples.every(
          (sample) => sample.result === "indeterminate",
        ),
        "缺鉴权时主动探针结果应为 indeterminate",
      );
      assert(
        unauthProbeStatus.active_probe.recent_samples.every(
          (sample) => sample.confidence == null,
        ),
        `缺鉴权时主动探针 confidence 应为空，实际 ${JSON.stringify(unauthProbeStatus.active_probe.recent_samples.map((sample) => sample.confidence))}`,
      );
      assert(
        unauthProbeStatus.active_probe.recent_samples.every(
          (sample) =>
            typeof sample.error_excerpt === "string" &&
            sample.error_excerpt.includes("authorization"),
        ),
        "缺鉴权时主动探针应保留错误摘要",
      );
      assert(
        unauthProbeStatus.active_probe.recent_samples.every(
          (sample) =>
            Array.isArray(sample.evidence_logs) &&
            sample.evidence_logs.some((entry) =>
              String(entry?.message || "").includes("finish type="),
            ) &&
            sample.evidence_logs.some((entry) =>
              String(entry?.message || "").includes("detail="),
            ),
        ),
        "缺鉴权时主动探针样本应保留结束日志和错误细节",
      );
    } finally {
      await stopGateway(unauthProbeGateway);
    }

    await new Promise((resolve) => setTimeout(resolve, 120));
    const logText = await readFile(logPath, "utf8");
    assert(
      !logText.includes("[error] TypeError: terminated"),
      "上游半路断流后不应记录 terminated error 日志",
    );

    process.stdout.write("PASS codex-retry-gateway e2e\n");
  } finally {
    await Promise.all([
      stopGateway(gateway),
      stopGateway(limitGateway),
      stopGateway(probeGateway),
      stopGateway(warningProbeGateway),
    ]);
    upstream.close();
    await once(upstream, "close");
    await rm(tempRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
