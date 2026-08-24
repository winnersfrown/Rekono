// The OpenRouter adapter and provider selection (src/llm.js).
//
// openrouter.ai isn't reachable from CI (or from the sandbox this was
// written in), and hitting a paid third-party API from a test suite would
// be the wrong call even where it is -- so `fetch` is stubbed and these
// assert on the exact request the adapter builds and how it reads the
// response back. That's where the provider differences actually live:
// OpenAI-shaped tools, `tool_choice` instead of Gemini's `toolConfig`, and
// tool arguments arriving as a JSON string rather than an object.
import { jest } from "@jest/globals";
import { settings } from "../src/config.js";
import { EmptyLlmResponseError, callTool, generateText, llmConfigurationWarning, llmConfigured, llmProvider } from "../src/llm.js";

const TOOL = {
  name: "record_thing",
  description: "Record a thing",
  parametersJsonSchema: {
    type: "object",
    properties: { name: { type: "string" }, count: { type: "number" } },
    required: ["name"],
  },
};

// settings is a plain object read at call time, so tests can point it at a
// provider without reloading the module graph.
const original = { ...settings };

function useOpenRouter({ model = "vendor/some-model" } = {}) {
  settings.openrouterApiKey = "sk-or-v1-test-key-not-real";
  settings.openrouterModel = model;
  settings.geminiApiKey = "";
  settings.llmProvider = "";
}

function stubFetch(impl) {
  const spy = jest.fn(impl);
  global.fetch = spy;
  return spy;
}

function toolCallResponse(args) {
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        choices: [{ message: { tool_calls: [{ function: { name: TOOL.name, arguments: JSON.stringify(args) } }] } }],
      }),
  };
}

beforeEach(() => {
  Object.assign(settings, original);
});

afterEach(() => {
  Object.assign(settings, original);
  delete global.fetch;
});

describe("provider selection", () => {
  test("reports nothing configured when neither provider has credentials", () => {
    settings.geminiApiKey = "";
    settings.openrouterApiKey = "";
    settings.openrouterModel = "";
    settings.llmProvider = "";

    expect(llmProvider()).toBeNull();
    expect(llmConfigured()).toBe(false);
  });

  test("prefers OpenRouter when both are configured", () => {
    settings.geminiApiKey = "gemini-key";
    settings.openrouterApiKey = "or-key";
    settings.openrouterModel = "vendor/some-model";
    settings.llmProvider = "";

    expect(llmProvider()).toBe("openrouter");
  });

  test("LLM_PROVIDER overrides that preference", () => {
    settings.geminiApiKey = "gemini-key";
    settings.openrouterApiKey = "or-key";
    settings.openrouterModel = "vendor/some-model";
    settings.llmProvider = "gemini";

    expect(llmProvider()).toBe("gemini");
  });

  // A key with no model is the likeliest way to misconfigure this, and
  // silently falling back to heuristic extraction would look like the key
  // simply not working.
  test("an OpenRouter key with no model counts as unconfigured, and says why", () => {
    settings.geminiApiKey = "";
    settings.openrouterApiKey = "or-key";
    settings.openrouterModel = "";
    settings.llmProvider = "";

    expect(llmProvider()).toBeNull();
    expect(llmConfigurationWarning()).toMatch(/OPENROUTER_MODEL/);
  });

  // A typo here falls back to auto-detection rather than disabling the LLM
  // outright -- refusing would quietly degrade every extraction to the
  // heuristic path, which looks like the model getting worse rather than
  // like a config error. The warning is what makes it diagnosable.
  test("an unrecognized LLM_PROVIDER warns loudly but still auto-detects", () => {
    settings.geminiApiKey = "gemini-key";
    settings.openrouterApiKey = "";
    settings.openrouterModel = "";
    settings.llmProvider = "ox-alpha";

    expect(llmProvider()).toBe("gemini");
    expect(llmConfigurationWarning()).toMatch(/isn't a provider this app knows/);
  });
});

describe("callTool against OpenRouter", () => {
  test("sends an OpenAI-shaped tool and forces it via tool_choice", async () => {
    useOpenRouter();
    const spy = stubFetch(async () => toolCallResponse({ name: "widget", count: 2 }));

    await callTool({ prompt: "extract this", tool: TOOL, maxOutputTokens: 512 });

    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer sk-or-v1-test-key-not-real");

    const body = JSON.parse(init.body);
    expect(body.model).toBe("vendor/some-model");
    expect(body.max_tokens).toBe(512);
    expect(body.messages).toEqual([{ role: "user", content: "extract this" }]);
    // The wrapper shape, and the schema passed through untouched.
    expect(body.tools).toEqual([
      { type: "function", function: { name: TOOL.name, description: TOOL.description, parameters: TOOL.parametersJsonSchema } },
    ]);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: TOOL.name } });
  });

  test("parses arguments that arrive as a JSON string", async () => {
    useOpenRouter();
    stubFetch(async () => toolCallResponse({ name: "widget", count: 2 }));

    // Gemini hands back an object here; OpenRouter hands back a string. The
    // callers expect an object either way.
    await expect(callTool({ prompt: "p", tool: TOOL })).resolves.toEqual({ name: "widget", count: 2 });
  });

  test("explains itself when the model returns no tool call at all", async () => {
    useOpenRouter({ model: "vendor/no-tools-model" });
    stubFetch(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: "I can't do that" } }] }),
    }));

    // The likeliest cause is a model that doesn't support tool calling,
    // which is a permanent property of the chosen model rather than a bad
    // roll -- so the message has to point at that.
    await expect(callTool({ prompt: "p", tool: TOOL })).rejects.toThrow(/no tool call.*tool\/function calling/s);
  });

  test("rejects tool arguments that aren't valid JSON", async () => {
    useOpenRouter();
    stubFetch(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: TOOL.name, arguments: "{not json" } }] } }] }),
    }));

    await expect(callTool({ prompt: "p", tool: TOOL })).rejects.toThrow(/aren't valid JSON/);
  });

  test("surfaces an HTTP error instead of returning an empty result", async () => {
    useOpenRouter();
    stubFetch(async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: { message: "No auth credentials found" } }),
    }));

    await expect(callTool({ prompt: "p", tool: TOOL })).rejects.toThrow(/No auth credentials found/);
  });

  // OpenRouter reports some upstream provider failures in the body with a
  // 200, so status alone isn't enough to tell success from failure.
  test("treats a body-level error as a failure even on HTTP 200", async () => {
    useOpenRouter();
    stubFetch(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ error: { message: "upstream provider is down" } }),
    }));

    await expect(callTool({ prompt: "p", tool: TOOL })).rejects.toThrow(/upstream provider is down/);
  });

  test("retries once before giving up", async () => {
    useOpenRouter();
    let calls = 0;
    const spy = stubFetch(async () => {
      calls += 1;
      if (calls === 1) throw new Error("socket hang up");
      return toolCallResponse({ name: "widget" });
    });

    await expect(callTool({ prompt: "p", tool: TOOL })).resolves.toEqual({ name: "widget" });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test("aborts a hung request rather than hanging with it", async () => {
    useOpenRouter();
    // Never settles on its own; only the adapter's abort signal ends it.
    stubFetch(
      (url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        })
    );

    await expect(callTool({ prompt: "p", tool: TOOL, timeoutMs: 30 })).rejects.toThrow(/timed out after 30ms/);
  });
});

describe("generateText against OpenRouter", () => {
  test("puts the system prompt and prior turns in front of the question", async () => {
    useOpenRouter();
    const spy = stubFetch(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: "Four invoices are unpaid." } }] }),
    }));

    const answer = await generateText({
      system: "You are helpful",
      history: [
        { role: "user", content: "how many invoices?" },
        { role: "assistant", content: "Twelve." },
      ],
      prompt: "how many are unpaid?",
    });

    expect(answer).toBe("Four invoices are unpaid.");
    // Roles pass through unchanged here, unlike Gemini's user/model rename.
    expect(JSON.parse(spy.mock.calls[0][1].body).messages).toEqual([
      { role: "system", content: "You are helpful" },
      { role: "user", content: "how many invoices?" },
      { role: "assistant", content: "Twelve." },
      { role: "user", content: "how many are unpaid?" },
    ]);
  });

  // Ask Rekono tells the user to rephrase for this case and to retry for a
  // transport failure, so the two have to stay distinguishable.
  test("an empty completion raises the distinguishable empty-response error", async () => {
    useOpenRouter();
    stubFetch(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: "" } }] }),
    }));

    await expect(generateText({ prompt: "p" })).rejects.toThrow(EmptyLlmResponseError);
    await expect(generateText({ prompt: "p" })).rejects.toMatchObject({ code: "empty_response" });
  });
});

test("both entry points refuse when no provider is configured", async () => {
  settings.geminiApiKey = "";
  settings.openrouterApiKey = "";
  settings.openrouterModel = "";
  settings.llmProvider = "";

  await expect(callTool({ prompt: "p", tool: TOOL })).rejects.toThrow(/No LLM provider is configured/);
  await expect(generateText({ prompt: "p" })).rejects.toThrow(/No LLM provider is configured/);
});
