/**
 * dsh-gpt-schema-compat
 *
 * GPT-specific compatibility for DSH sandbox arguments. It rewrites model tool
 * calls in `llm/stream`, before the agent loop persists and dispatches them.
 *
 * Default policy:
 *   - Only gpt-* and chatgpt-* routes are affected.
 *   - `write`, `edit`, and `pwsh` may use one exact retry only after the
 *     matching operation reports a sandbox denial; DSH owns the approval prompt.
 *   - Speculative GPT escalation arguments are removed before execution.
 */
const name = "gpt-schema-compat";

const DENIAL_CODE = "FS_SANDBOX_DENIED";
const ESCALATION_FIELDS = ["sandbox_permissions", "justification"];
const RETRY_TOOLS = new Set(["write", "edit", "pwsh"]);
const FILE_RETRY_TOOLS = new Set(["write", "edit"]);
const GPT_MODEL_PATTERN = /^(gpt-|chatgpt-)/i;

const FIXED_JUSTIFICATION =
  "Retry of the exact operation the sandbox just denied: it requires the next wider sandbox mode.";

const EDIT_PRECHECK_TEXT =
  "Before every edit call, read the exact target file in this session and build old_string from that current read. If edit reports an unread file, a stale file, a missing file, or an unmatched old_string, read the target again before deciding on a new edit. Do not blindly repeat the same edit call.";

/** Stable identity from arguments that affect a retriable operation. */
function fingerprint(toolName, args) {
  if (toolName === "write") {
    if (typeof args?.file_path !== "string" || typeof args?.content !== "string") return null;
    return JSON.stringify(["write", args.file_path, args.content]);
  }
  if (toolName === "edit") {
    if (
      typeof args?.file_path !== "string" ||
      typeof args?.old_string !== "string" ||
      typeof args?.new_string !== "string"
    ) return null;
    return JSON.stringify(["edit", args.file_path, args.old_string, args.new_string, args.replace_all ?? false]);
  }
  if (toolName === "pwsh") {
    if (typeof args?.command !== "string") return null;
    return JSON.stringify(["pwsh", args.command, args.workdir ?? null, args.timeoutMs ?? null, args.run_in_background ?? false]);
  }
  return null;
}

function pwshSandboxDenialMode(result) {
  const value = result?.value;
  if (value?.kind !== "foreground" || value.sandbox?.denied !== true) return undefined;
  return typeof value.sandbox.mode === "string" ? value.sandbox.mode : undefined;
}

function fileSandboxDenialMode(result) {
  const match = /\[sandbox: file access denied under (read-only|workspace-write|danger-full-access) mode\]/.exec(
    result.error?.message
  );
  return match?.[1];
}

function hasRetryTools(tools) {
  return Array.isArray(tools) && tools.some((tool) => tool != null && RETRY_TOOLS.has(tool.name));
}

function nextEscalationMode(mode) {
  if (mode === "read-only") return "workspace-write";
  if (mode === "workspace-write") return "danger-full-access";
  return undefined;
}

function isGptModel(model) {
  return typeof model === "string" && GPT_MODEL_PATTERN.test(model);
}

function isGptRoute(options) {
  return isGptModel(options.model);
}

function parseArgumentsObject(raw) {
  try {
    const value = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function retryKey(sessionId, fingerprint) {
  return `${sessionId}\u0000${fingerprint}`;
}

/** Reserve one matching denied operation until its model response finishes normally. */
function reservePendingRetry(denied, reservations, sessionId, fingerprint) {
  const key = retryKey(sessionId, fingerprint);
  const modes = denied.get(key);
  const reserved = reservations.get(key) ?? 0;
  const mode = modes?.[reserved];
  if (mode === undefined) return undefined;
  reservations.set(key, reserved + 1);
  return mode;
}

/** A completed response without matching calls expires this session's eligibility. */
function expirePendingRetries(denied, sessionId) {
  const prefix = `${sessionId}\u0000`;
  for (const key of denied.keys()) if (key.startsWith(prefix)) denied.delete(key);
}

function isNormalFinish(chunk) {
  return chunk.reason?.kind !== "error" && chunk.reason?.kind !== "aborted";
}

async function* expireAfterNormalResponse(source, denied, sessionId) {
  for await (const chunk of source) {
    if (chunk.type === "finish" && isNormalFinish(chunk)) expirePendingRetries(denied, sessionId);
    yield chunk;
  }
}

/** A non-GPT stream supersedes any stale GPT root-call id it reuses. */
async function* unmarkNonGptRootCalls(source, unmarkGptRootCall) {
  for await (const chunk of source) {
    if (
      chunk.type === "block-end" &&
      chunk.block.type === "tool-call" &&
      RETRY_TOOLS.has(chunk.block.name)
    ) {
      unmarkGptRootCall(chunk.block.id);
    }
    yield chunk;
  }
}

/** Keep the assembled message and its durable raw chunk stream consistent. */
async function* rewriteStream(
  source,
  options,
  denied,
  canRequestApproval,
  markGptRootCall,
  unmarkGptRootCall
) {
  const sessionId = options.sessionId;
  const buffers = new Map();
  const reservations = new Map();
  const streamedRootCallIds = new Set();

  for await (const chunk of source) {
    switch (chunk.type) {
      case "tool-call-delta": {
        const list = buffers.get(chunk.index);
        if (list) list.push(chunk);
        else buffers.set(chunk.index, [chunk]);
        break;
      }
      case "block-end": {
        const buffered = buffers.get(chunk.index) ?? [];
        buffers.delete(chunk.index);

        if (chunk.block.type === "tool-call" && RETRY_TOOLS.has(chunk.block.name)) {
          if (sessionId !== undefined) {
            markGptRootCall(chunk.block.id);
            streamedRootCallIds.add(chunk.block.id);
          }
          const args = parseArgumentsObject(chunk.block.arguments);
          if (args !== null) {
            const fp = fingerprint(chunk.block.name, args);
            const deniedMode =
              sessionId === undefined || fp === null
                ? undefined
                : reservePendingRetry(denied, reservations, sessionId, fp);
            const normalized = { ...args };
            const escalationMode =
              deniedMode !== undefined && canRequestApproval(sessionId)
                ? nextEscalationMode(deniedMode)
                : undefined;

            if (escalationMode !== undefined) {
              normalized.sandbox_permissions = escalationMode;
              normalized.justification = FIXED_JUSTIFICATION;
            } else {
              for (const field of ESCALATION_FIELDS) delete normalized[field];
            }

            const argumentsDelta = JSON.stringify(normalized);
            yield {
              type: "tool-call-delta",
              index: chunk.index,
              id: chunk.block.id,
              name: chunk.block.name,
              argumentsDelta
            };
            yield { ...chunk, block: { ...chunk.block, arguments: argumentsDelta } };
            break;
          }
        }

        for (const delta of buffered) yield delta;
        yield chunk;
        break;
      }
      case "finish": {
        for (const list of buffers.values()) for (const delta of list) yield delta;
        buffers.clear();
        const normalFinish = isNormalFinish(chunk);
        if (sessionId !== undefined && normalFinish) expirePendingRetries(denied, sessionId);
        if (!normalFinish || chunk.reason?.kind === "max-tokens") {
          for (const callId of streamedRootCallIds) unmarkGptRootCall(callId);
        }
        yield chunk;
        break;
      }
      default: {
        yield chunk;
      }
    }
  }
}

function apply(ctx) {
  /** `${sessionId}\u0000${fingerprint}` maps to one or more denied modes. */
  const denied = new Map();
  /** Root GPT calls observed in the actual model stream, keyed by session and call id. */
  const gptRootCalls = new Set();

  const agentFor = (sessionId) =>
    sessionId === undefined ? undefined : ctx.get("agents")?.get(sessionId);

  const modeFor = (sessionId) => {
    try {
      const policy = ctx.get("sandboxPolicy");
      if (policy === undefined) return undefined;
      const agent = agentFor(sessionId);
      return policy.resolve(agent === undefined ? {} : { session: agent.session }).mode;
    } catch {
      return undefined;
    }
  };

  const canRequestApproval = (sessionId) => {
    try {
      const agent = agentFor(sessionId);
      const approval = ctx.get("approval");
      return (
        agent !== undefined &&
        approval !== undefined &&
        (typeof approval.effectivePolicy !== "function" || approval.effectivePolicy(agent.session) !== "never")
      );
    } catch {
      return false;
    }
  };

  const markGptRootCall = (sessionId, callId) => gptRootCalls.add(retryKey(sessionId, callId));
  const unmarkGptRootCall = (sessionId, callId) => gptRootCalls.delete(retryKey(sessionId, callId));
  const consumeGptRootCall = (exec) =>
    exec.agent !== undefined && exec.parent === undefined && unmarkGptRootCall(exec.agent.session.id, exec.callId);

  ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
    const assembly = await next();
    if (!isGptModel(context.agent?.options?.model)) return assembly;
    return {
      ...assembly,
      sections: [
        ...assembly.sections,
        { name: "gpt-schema-compat:edit-preflight", text: EDIT_PRECHECK_TEXT }
      ]
    };
  });

  ctx.on("tools/execute", async (exec, next) => {
    const result = await next();
    const fileSandboxDenial =
      result.isError && result.error?.info?.code === DENIAL_CODE && FILE_RETRY_TOOLS.has(exec.name);
    const fileDeniedMode = fileSandboxDenial ? fileSandboxDenialMode(result) : undefined;
    const pwshDeniedMode = exec.name === "pwsh" && !result.isError ? pwshSandboxDenialMode(result) : undefined;
    const pwshSandboxDenial = pwshDeniedMode !== undefined;
    const gptRootCall = consumeGptRootCall(exec);

    if (gptRootCall && (fileSandboxDenial || pwshSandboxDenial)) {
      const fp = fingerprint(exec.name, exec.arguments);
      const denialMode = pwshDeniedMode ?? fileDeniedMode ?? modeFor(exec.agent.session.id);
      const escalationMode = nextEscalationMode(denialMode);
      if (fp !== null && escalationMode !== undefined && canRequestApproval(exec.agent.session.id)) {
        const key = retryKey(exec.agent.session.id, fp);
        const modes = denied.get(key) ?? [];
        modes.push(denialMode);
        denied.set(key, modes);
      }
    }
    return result;
  });

  ctx.on("tools/result", (exec) => {
    if (exec.agent !== undefined && exec.parent === undefined) {
      unmarkGptRootCall(exec.agent.session.id, exec.callId);
    }
  });

  ctx.on(
    "llm/stream",
    (options, next) => {
      if (options.sessionId === undefined || options.purpose !== undefined) return next();
      if (!isGptRoute(options)) {
        return unmarkNonGptRootCalls(
          next(),
          (callId) => unmarkGptRootCall(options.sessionId, callId)
        );
      }
      if (!hasRetryTools(options.tools)) {
        return expireAfterNormalResponse(next(), denied, options.sessionId);
      }
      return rewriteStream(
        next(),
        options,
        denied,
        canRequestApproval,
        (callId) => markGptRootCall(options.sessionId, callId),
        (callId) => unmarkGptRootCall(options.sessionId, callId)
      );
    },
    { global: true }
  );
}

export { name, apply };
