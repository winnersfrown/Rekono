// One surface over the two LLM providers this app can talk to, so the code
// that actually needs a model -- extraction.js, transactionCategorization.js,
// routes/assistant.js -- doesn't carry a branch per provider.
//
// Only two shapes are needed, and they're the two below:
//
//   callTool()     forces the model to answer by calling one named function
//                  with a JSON-schema'd argument object, and returns those
//                  arguments. This is how extraction gets a fixed schema
//                  out of a model instead of prose it would have to parse.
//   generateText() open-ended text, with a system prompt and prior turns.
//                  Only Ask Rekono needs this.
//
// Provider choice: LLM_PROVIDER if set, otherwise whichever has credentials,
// preferring OpenRouter. With neither configured every caller falls back to
// its own non-LLM path (heuristic extraction, uncategorized merchants) --
// the pipeline runs end to end without a key, which is what keeps the test
// suite and local demos honest.
import { GoogleGenAI, FunctionCallingConfigMode } from "@google/genai";
import { settings } from "./config.js";

// Bounds the worst case for one call. The Gemini SDK's own default timeout
// is several minutes and its default retries multiply that; a single retry
// inside a 60s budget rides out a transient blip while still failing fast
// into the caller's fallback rather than leaving a document stuck
// "processing" while someone watches a spinner.
export const LLM_TIMEOUT_MS = 60_000;
export const LLM_MAX_ATTEMPTS = 2; // original call + one retry

// Built from settings rather than a module constant, so a test (or a
// process that reloads config) sees a changed base URL instead of whatever
// the first import happened to capture. The trailing slash is trimmed so
// both "…/v1" and "…/v1/" produce the same endpoint.
function chatCompletionsUrl() {
  return `${settings.openrouterBaseUrl.replace(/\/+$/, "")}/chat/completions`;
}

// What to call this endpoint in an error message. "OpenRouter request
// failed" is actively misleading when the base URL points at a gateway on
// localhost, and the host is the one detail that tells somebody which box
// to go and look at.
export function openaiCompatibleLabel() {
  try {
    const { host } = new URL(settings.openrouterBaseUrl);
    return host === "openrouter.ai" ? "OpenRouter" : host;
  } catch {
    return settings.openrouterBaseUrl || "the OpenAI-compatible endpoint";
  }
}

function geminiReady() {
  return Boolean(settings.geminiApiKey);
}

// A key alone isn't enough: OpenRouter needs to be told which model to
// route to, and there's no sane default to fall back on (see config.js).
function openrouterReady() {
  return Boolean(settings.openrouterApiKey && settings.openrouterModel);
}

export function llmProvider() {
  const forced = settings.llmProvider.trim().toLowerCase();
  if (forced === "openrouter") return openrouterReady() ? "openrouter" : null;
  if (forced === "gemini") return geminiReady() ? "gemini" : null;
  if (openrouterReady()) return "openrouter";
  if (geminiReady()) return "gemini";
  return null;
}

export function llmConfigured() {
  return llmProvider() !== null;
}

// Says why a provider that looks half-configured isn't being used, so the
// answer to "I set OPENROUTER_API_KEY, why is it still using the heuristic
// extractor?" is in the logs instead of requiring a debugging session.
export function llmConfigurationWarning() {
  if (settings.openrouterApiKey && !settings.openrouterModel) {
    return "OPENROUTER_API_KEY is set but OPENROUTER_MODEL isn't, so OpenRouter can't be used -- set it to the model slug you want (e.g. \"vendor/model-name\").";
  }
  const forced = settings.llmProvider.trim().toLowerCase();
  if (forced && !["openrouter", "gemini"].includes(forced)) {
    return `LLM_PROVIDER is "${settings.llmProvider}", which isn't a provider this app knows -- use "openrouter" or "gemini", or leave it unset.`;
  }
  if (forced === "openrouter" && !openrouterReady()) {
    return 'LLM_PROVIDER is "openrouter" but its key/model aren\'t both set, so no LLM will be used.';
  }
  if (forced === "gemini" && !geminiReady()) {
    return 'LLM_PROVIDER is "gemini" but GEMINI_API_KEY isn\'t set, so no LLM will be used.';
  }
  return null;
}

function geminiClient(timeoutMs = LLM_TIMEOUT_MS) {
  return new GoogleGenAI({
    apiKey: settings.geminiApiKey,
    httpOptions: { timeout: timeoutMs, retryOptions: { attempts: LLM_MAX_ATTEMPTS } },
  });
}

// OpenRouter speaks the OpenAI dialect, which differs from Gemini's in
// three ways that matter here: tools are wrapped in `{type:"function"}`,
// forcing a specific tool is `tool_choice` rather than a `toolConfig`
// block, and the chosen arguments come back as a JSON *string* that has to
// be parsed rather than as an object.
async function openrouterFetch(body, timeoutMs = LLM_TIMEOUT_MS) {
  let lastError;
  for (let attempt = 1; attempt <= LLM_MAX_ATTEMPTS; attempt += 1) {
    // The SDK handles this for Gemini; here it's ours to do, and without it
    // a hung connection would hold the request (and, under row-level
    // security, its open transaction) until something else gave up.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const res = await fetch(chatCompletionsUrl(), {
        method: "POST",
        signal: abort.signal,
        headers: {
          Authorization: `Bearer ${settings.openrouterApiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": settings.openrouterSiteUrl,
          "X-Title": settings.openrouterAppName,
        },
        body: JSON.stringify({ model: settings.openrouterModel, ...body }),
      });

      const text = await res.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`${openaiCompatibleLabel()} returned a non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`);
      }

      // OpenRouter reports upstream provider failures in the body with a
      // 200, not only via the HTTP status, so both have to be checked or a
      // failed call reads as an empty success.
      if (!res.ok || payload.error) {
        const detail = payload.error?.message || payload.error || `HTTP ${res.status}`;
        throw new Error(`${openaiCompatibleLabel()} request failed: ${detail}`);
      }
      return payload;
    } catch (err) {
      lastError = err.name === "AbortError" ? new Error(`${openaiCompatibleLabel()} request timed out after ${timeoutMs}ms`) : err;
      if (attempt === LLM_MAX_ATTEMPTS) throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

/**
 * Forces one named function call and returns its arguments object.
 *
 * `tool` is the Gemini-shaped declaration the callers already define:
 * { name, description, parametersJsonSchema }. That schema is plain JSON
 * Schema, which is exactly what OpenAI-style `function.parameters` wants,
 * so no translation is needed beyond the wrapper.
 */
export async function callTool({ prompt, tool, maxOutputTokens = 4096, timeoutMs = LLM_TIMEOUT_MS }) {
  const provider = llmProvider();

  if (provider === "gemini") {
    const response = await geminiClient(timeoutMs).models.generateContent({
      model: settings.geminiModel,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        maxOutputTokens,
        tools: [{ functionDeclarations: [tool] }],
        toolConfig: {
          functionCallingConfig: { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: [tool.name] },
        },
      },
    });
    return response.functionCalls[0].args;
  }

  if (provider === "openrouter") {
    const payload = await openrouterFetch(
      {
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxOutputTokens,
        tools: [
          {
            type: "function",
            function: { name: tool.name, description: tool.description, parameters: tool.parametersJsonSchema },
          },
        ],
        tool_choice: { type: "function", function: { name: tool.name } },
      },
      timeoutMs
    );

    const call = payload.choices?.[0]?.message?.tool_calls?.[0];
    if (!call) {
      // Either the model ignored tool_choice or it doesn't support tools at
      // all -- worth distinguishing, since the second is a permanent
      // property of the chosen model rather than a bad roll.
      throw new Error(
        `${openaiCompatibleLabel()} model "${settings.openrouterModel}" returned no tool call. If it doesn't support tool/function calling, pick one that does.`
      );
    }

    try {
      // Arguments arrive as a JSON string here, unlike Gemini's parsed object.
      return JSON.parse(call.function.arguments);
    } catch {
      throw new Error(`${openaiCompatibleLabel()} returned tool arguments that aren't valid JSON: ${String(call.function.arguments).slice(0, 200)}`);
    }
  }

  throw new Error("No LLM provider is configured");
}

// Thrown when the provider answered but there's no usable text in it -- a
// safety block, an empty completion, a response with no candidates. Carries
// its own code because callers want to say something different for this
// ("try rephrasing") than for a transport or auth failure ("try again").
export class EmptyLlmResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = "EmptyLlmResponseError";
    this.code = "empty_response";
  }
}

/**
 * Open-ended text. `history` is prior turns as { role: "user"|"assistant" }.
 */
export async function generateText({ system, history = [], prompt, maxOutputTokens = 1024 }) {
  const provider = llmProvider();

  if (provider === "gemini") {
    // Gemini's roles are "user"/"model" rather than "user"/"assistant".
    const contents = [
      ...history.map((entry) => ({
        role: entry.role === "assistant" ? "model" : "user",
        parts: [{ text: entry.content }],
      })),
      { role: "user", parts: [{ text: prompt }] },
    ];
    const response = await geminiClient().models.generateContent({
      model: settings.geminiModel,
      config: { systemInstruction: system, maxOutputTokens },
      contents,
    });
    // `.text` is a getter that throws (rather than returning undefined)
    // when the response has no candidates at all -- e.g. a safety block on
    // the prompt -- so reading it is itself the check.
    let text;
    try {
      text = response.text;
    } catch (err) {
      throw new EmptyLlmResponseError(err.message);
    }
    if (!text) throw new EmptyLlmResponseError("The model returned an empty response");
    return text;
  }

  if (provider === "openrouter") {
    const payload = await openrouterFetch({
      max_tokens: maxOutputTokens,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        ...history.map((entry) => ({ role: entry.role, content: entry.content })),
        { role: "user", content: prompt },
      ],
    });
    const text = payload.choices?.[0]?.message?.content;
    if (!text) throw new EmptyLlmResponseError("The model returned an empty response");
    return text;
  }

  throw new Error("No LLM provider is configured");
}
