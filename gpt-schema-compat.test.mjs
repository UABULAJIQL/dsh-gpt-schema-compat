import assert from "node:assert/strict";
import test from "node:test";
import { apply } from "./lib/index.js";

function toolCall(id, name, args) {
  return { id, name, args };
}

function streamFor(calls, finishReason = { kind: "tool-calls" }) {
  return (async function* () {
    for (const call of calls) {
      yield {
        type: "block-end",
        index: 0,
        block: {
          type: "tool-call",
          id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.args)
        }
      };
    }
    yield { type: "finish", reason: finishReason };
  })();
}

async function collect(source) {
  const chunks = [];
  for await (const chunk of source) chunks.push(chunk);
  return chunks;
}

function createHarness({ mode = "workspace-write", agentModel = "gpt-5.6-terra", approvalPolicy = "ask" } = {}) {
  const handlers = new Map();
  const agent = { session: { id: "session-1" }, options: { model: agentModel } };
  const approval = { effectivePolicy: () => approvalPolicy };
  const ctx = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    get(name) {
      if (name === "sandboxPolicy") return { resolve: () => ({ mode }) };
      if (name === "agents") return new Map([[agent.session.id, agent]]);
      if (name === "approval") return approval;
      return undefined;
    }
  };
  apply(ctx);
  return { agent, handlers };
}

function streamOptions(model = "gpt-5.6-terra") {
  return {
    sessionId: "session-1",
    model,
    tools: [{ name: "write" }, { name: "edit" }, { name: "pwsh" }]
  };
}

async function runStream(handlers, calls, { model = "gpt-5.6-terra", finishReason } = {}) {
  return collect(
    await handlers.get("llm/stream")(streamOptions(model), () => streamFor(calls, finishReason))
  );
}

async function execute(handlers, agent, { callId, name = "pwsh", args, result, parent }) {
  return handlers.get("tools/execute")(
    {
      callId,
      name,
      arguments: args,
      agent,
      ...(parent === undefined ? {} : { parent })
    },
    async () => result
  );
}

function deniedResult(mode) {
  return {
    isError: false,
    value: { kind: "foreground", sandbox: { denied: true, mode } },
    content: []
  };
}

function fileDeniedResult(mode) {
  return {
    isError: true,
    error: {
      info: { code: "FS_SANDBOX_DENIED" },
      message: `[sandbox: file access denied under ${mode} mode]`
    },
    content: []
  };
}

function toolCallArguments(chunks, id) {
  const chunk = chunks.find(
    (candidate) => candidate.type === "block-end" && candidate.block?.type === "tool-call" && candidate.block.id === id
  );
  return JSON.parse(chunk.block.arguments);
}

const JUSTIFICATION =
  "Retry of the exact operation the sandbox just denied: it requires the next wider sandbox mode.";

const BASE_ARGS = {
  command: "Get-Location",
  description: "Show current working directory"
};

test("strips speculative GPT pwsh escalation", async () => {
  const { handlers } = createHarness();
  const args = {
    ...BASE_ARGS,
    sandbox_permissions: "workspace-write",
    justification: "Incorrect model request."
  };

  const chunks = await runStream(handlers, [toolCall("initial", "pwsh", args)]);
  assert.deepEqual(toolCallArguments(chunks, "initial"), BASE_ARGS);
});

test("permits one exact GPT pwsh retry after a workspace-write denial", async () => {
  const { agent, handlers } = createHarness();
  await runStream(handlers, [toolCall("initial", "pwsh", BASE_ARGS)]);
  await execute(handlers, agent, {
    callId: "initial",
    args: BASE_ARGS,
    result: deniedResult("workspace-write")
  });

  const chunks = await runStream(handlers, [toolCall("retry", "pwsh", BASE_ARGS)]);
  assert.deepEqual(toolCallArguments(chunks, "retry"), {
    ...BASE_ARGS,
    sandbox_permissions: "danger-full-access",
    justification: JUSTIFICATION
  });
});

test("does not grant a pwsh retry to a different command", async () => {
  const { agent, handlers } = createHarness();
  await runStream(handlers, [toolCall("initial", "pwsh", BASE_ARGS)]);
  await execute(handlers, agent, {
    callId: "initial",
    args: BASE_ARGS,
    result: deniedResult("workspace-write")
  });

  const differentArgs = {
    command: "Get-Process",
    description: "List running processes",
    sandbox_permissions: "danger-full-access",
    justification: "Incorrect model request."
  };
  const chunks = await runStream(handlers, [toolCall("retry", "pwsh", differentArgs)]);
  assert.deepEqual(toolCallArguments(chunks, "retry"), {
    command: "Get-Process",
    description: "List running processes"
  });
});

test("does not rewrite DeepSeek pwsh calls", async () => {
  const { handlers } = createHarness();
  const args = {
    ...BASE_ARGS,
    sandbox_permissions: "workspace-write",
    justification: "Model-provided argument."
  };

  const chunks = await runStream(handlers, [toolCall("deepseek", "pwsh", args)], { model: "deepseek-chat" });
  assert.deepEqual(toolCallArguments(chunks, "deepseek"), args);
});

test("uses the actual GPT stream route instead of the static agent model", async () => {
  const { agent, handlers } = createHarness({ agentModel: "deepseek-chat" });
  await runStream(handlers, [toolCall("initial", "pwsh", BASE_ARGS)]);
  await execute(handlers, agent, {
    callId: "initial",
    args: BASE_ARGS,
    result: deniedResult("workspace-write")
  });

  const chunks = await runStream(handlers, [toolCall("retry", "pwsh", BASE_ARGS)]);
  assert.equal(toolCallArguments(chunks, "retry").sandbox_permissions, "danger-full-access");
});

test("does not create a GPT retry entitlement from a DeepSeek stream", async () => {
  const { agent, handlers } = createHarness({ agentModel: "gpt-5.6-terra" });
  await runStream(handlers, [toolCall("initial", "pwsh", BASE_ARGS)], { model: "deepseek-chat" });
  await execute(handlers, agent, {
    callId: "initial",
    args: BASE_ARGS,
    result: deniedResult("workspace-write")
  });

  const craftedArgs = { ...BASE_ARGS, sandbox_permissions: "danger-full-access", justification: "Incorrect model request." };
  const chunks = await runStream(handlers, [toolCall("retry", "pwsh", craftedArgs)]);
  assert.deepEqual(toolCallArguments(chunks, "retry"), BASE_ARGS);
});

test("does not authorize a top-level retry from a nested pwsh denial", async () => {
  const { agent, handlers } = createHarness();
  await runStream(handlers, [toolCall("initial", "pwsh", BASE_ARGS)]);
  await execute(handlers, agent, {
    callId: "initial",
    args: BASE_ARGS,
    parent: Symbol("run-code"),
    result: deniedResult("workspace-write")
  });

  const craftedArgs = { ...BASE_ARGS, sandbox_permissions: "danger-full-access", justification: "Incorrect model request." };
  const chunks = await runStream(handlers, [toolCall("retry", "pwsh", craftedArgs)]);
  assert.deepEqual(toolCallArguments(chunks, "retry"), BASE_ARGS);
});

test("does not inject an escalation when approval policy is never", async () => {
  const { agent, handlers } = createHarness({ approvalPolicy: "never" });
  await runStream(handlers, [toolCall("initial", "pwsh", BASE_ARGS)]);
  await execute(handlers, agent, {
    callId: "initial",
    args: BASE_ARGS,
    result: deniedResult("workspace-write")
  });

  const craftedArgs = { ...BASE_ARGS, sandbox_permissions: "danger-full-access", justification: "Incorrect model request." };
  const chunks = await runStream(handlers, [toolCall("retry", "pwsh", craftedArgs)]);
  assert.deepEqual(toolCallArguments(chunks, "retry"), BASE_ARGS);
});

test("retains eligibility when an adapter error discards an emitted retry", async () => {
  const { agent, handlers } = createHarness();
  await runStream(handlers, [toolCall("initial", "pwsh", BASE_ARGS)]);
  await execute(handlers, agent, {
    callId: "initial",
    args: BASE_ARGS,
    result: deniedResult("workspace-write")
  });

  const discarded = await runStream(
    handlers,
    [toolCall("discarded", "pwsh", BASE_ARGS)],
    { finishReason: { kind: "error" } }
  );
  assert.equal(toolCallArguments(discarded, "discarded").sandbox_permissions, "danger-full-access");

  const chunks = await runStream(handlers, [toolCall("retry", "pwsh", BASE_ARGS)]);
  assert.equal(toolCallArguments(chunks, "retry").sandbox_permissions, "danger-full-access");
});

test("expires unmatched eligibility after a normal response", async () => {
  const { agent, handlers } = createHarness();
  await runStream(handlers, [toolCall("initial", "pwsh", BASE_ARGS)]);
  await execute(handlers, agent, {
    callId: "initial",
    args: BASE_ARGS,
    result: deniedResult("workspace-write")
  });

  await runStream(handlers, [], { finishReason: { kind: "stop" } });
  const craftedArgs = { ...BASE_ARGS, sandbox_permissions: "danger-full-access", justification: "Incorrect model request." };
  const chunks = await runStream(handlers, [toolCall("retry", "pwsh", craftedArgs)]);
  assert.deepEqual(toolCallArguments(chunks, "retry"), BASE_ARGS);
});

test("preserves one retry for each concurrent identical denied call", async () => {
  const { agent, handlers } = createHarness();
  await runStream(handlers, [
    toolCall("initial-1", "pwsh", BASE_ARGS),
    toolCall("initial-2", "pwsh", BASE_ARGS)
  ]);
  await execute(handlers, agent, {
    callId: "initial-1",
    args: BASE_ARGS,
    result: deniedResult("workspace-write")
  });
  await execute(handlers, agent, {
    callId: "initial-2",
    args: BASE_ARGS,
    result: deniedResult("workspace-write")
  });

  const chunks = await runStream(handlers, [
    toolCall("retry-1", "pwsh", BASE_ARGS),
    toolCall("retry-2", "pwsh", BASE_ARGS)
  ]);
  assert.equal(toolCallArguments(chunks, "retry-1").sandbox_permissions, "danger-full-access");
  assert.equal(toolCallArguments(chunks, "retry-2").sandbox_permissions, "danger-full-access");
});

test("uses the reported denial mode to advance read-only retries", async () => {
  const { agent, handlers } = createHarness({ mode: "read-only" });
  const args = {
    command: "Set-Content -Path C:\\outside\\output.txt -Value ok",
    description: "Write an external output file"
  };
  await runStream(handlers, [toolCall("initial", "pwsh", args)]);
  await execute(handlers, agent, {
    callId: "initial",
    args,
    result: deniedResult("read-only")
  });

  const firstRetry = await runStream(handlers, [toolCall("retry-1", "pwsh", args)]);
  const firstRetryArgs = toolCallArguments(firstRetry, "retry-1");
  assert.equal(firstRetryArgs.sandbox_permissions, "workspace-write");

  await execute(handlers, agent, {
    callId: "retry-1",
    args: firstRetryArgs,
    result: deniedResult("workspace-write")
  });
  const secondRetry = await runStream(handlers, [toolCall("retry-2", "pwsh", args)]);
  assert.deepEqual(toolCallArguments(secondRetry, "retry-2"), {
    ...args,
    sandbox_permissions: "danger-full-access",
    justification: JUSTIFICATION
  });
});

test("uses the reported mode to advance write retries", async () => {
  const { agent, handlers } = createHarness({ mode: "read-only" });
  const args = { file_path: "C:\\outside\\output.txt", content: "ok" };
  await runStream(handlers, [toolCall("initial", "write", args)]);
  await execute(handlers, agent, {
    callId: "initial",
    name: "write",
    args,
    result: fileDeniedResult("read-only")
  });

  const firstRetry = await runStream(handlers, [toolCall("retry-1", "write", args)]);
  const firstRetryArgs = toolCallArguments(firstRetry, "retry-1");
  assert.equal(firstRetryArgs.sandbox_permissions, "workspace-write");

  await execute(handlers, agent, {
    callId: "retry-1",
    name: "write",
    args: firstRetryArgs,
    result: fileDeniedResult("workspace-write")
  });
  const secondRetry = await runStream(handlers, [toolCall("retry-2", "write", args)]);
  assert.equal(toolCallArguments(secondRetry, "retry-2").sandbox_permissions, "danger-full-access");
});

test("clears an errored GPT root-call binding before a reused DeepSeek call id", async () => {
  const { agent, handlers } = createHarness();
  await runStream(
    handlers,
    [toolCall("reused", "pwsh", BASE_ARGS)],
    { finishReason: { kind: "error" } }
  );
  await runStream(handlers, [toolCall("reused", "pwsh", BASE_ARGS)], { model: "deepseek-chat" });
  await execute(handlers, agent, {
    callId: "reused",
    args: BASE_ARGS,
    result: deniedResult("workspace-write")
  });

  const craftedArgs = { ...BASE_ARGS, sandbox_permissions: "danger-full-access", justification: "Incorrect model request." };
  const chunks = await runStream(handlers, [toolCall("retry", "pwsh", craftedArgs)]);
  assert.deepEqual(toolCallArguments(chunks, "retry"), BASE_ARGS);
});

test("clears a max-token root-call binding before a reused DeepSeek call id", async () => {
  const { agent, handlers } = createHarness();
  await runStream(
    handlers,
    [toolCall("reused", "pwsh", BASE_ARGS)],
    { finishReason: { kind: "max-tokens" } }
  );
  await runStream(handlers, [toolCall("reused", "pwsh", BASE_ARGS)], { model: "deepseek-chat" });
  await execute(handlers, agent, {
    callId: "reused",
    args: BASE_ARGS,
    result: deniedResult("workspace-write")
  });

  const craftedArgs = { ...BASE_ARGS, sandbox_permissions: "danger-full-access", justification: "Incorrect model request." };
  const chunks = await runStream(handlers, [toolCall("retry", "pwsh", craftedArgs)]);
  assert.deepEqual(toolCallArguments(chunks, "retry"), BASE_ARGS);
});

test("clears a root-call binding when a pre-execution policy produces a result", async () => {
  const { agent, handlers } = createHarness();
  await runStream(handlers, [toolCall("reused", "pwsh", BASE_ARGS)]);
  handlers.get("tools/result")(
    { callId: "reused", agent },
    { isError: true, content: [] }
  );

  await runStream(handlers, [toolCall("reused", "pwsh", BASE_ARGS)], { model: "deepseek-chat" });
  await execute(handlers, agent, {
    callId: "reused",
    args: BASE_ARGS,
    result: deniedResult("workspace-write")
  });

  const craftedArgs = { ...BASE_ARGS, sandbox_permissions: "danger-full-access", justification: "Incorrect model request." };
  const chunks = await runStream(handlers, [toolCall("retry", "pwsh", craftedArgs)]);
  assert.deepEqual(toolCallArguments(chunks, "retry"), BASE_ARGS);
});

test("retains GPT retry eligibility across an unrelated DeepSeek response", async () => {
  const { agent, handlers } = createHarness();
  await runStream(handlers, [toolCall("initial", "pwsh", BASE_ARGS)]);
  await execute(handlers, agent, {
    callId: "initial",
    args: BASE_ARGS,
    result: deniedResult("workspace-write")
  });

  await runStream(handlers, [], { model: "deepseek-chat" });
  const chunks = await runStream(handlers, [toolCall("retry", "pwsh", BASE_ARGS)]);
  assert.equal(toolCallArguments(chunks, "retry").sandbox_permissions, "danger-full-access");
});

test("clears a normal GPT root-call binding before DeepSeek reuses its id", async () => {
  const { agent, handlers } = createHarness();
  await runStream(handlers, [toolCall("reused", "pwsh", BASE_ARGS)]);
  await runStream(handlers, [toolCall("reused", "pwsh", BASE_ARGS)], { model: "deepseek-chat" });
  await execute(handlers, agent, {
    callId: "reused",
    args: BASE_ARGS,
    result: deniedResult("workspace-write")
  });

  const craftedArgs = { ...BASE_ARGS, sandbox_permissions: "danger-full-access", justification: "Incorrect model request." };
  const chunks = await runStream(handlers, [toolCall("retry", "pwsh", craftedArgs)]);
  assert.deepEqual(toolCallArguments(chunks, "retry"), BASE_ARGS);
});
