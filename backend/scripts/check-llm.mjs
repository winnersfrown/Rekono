#!/usr/bin/env node
// One real call against whichever LLM provider is configured -- the check
// this sandbox can't run itself, since openrouter.ai is policy-blocked at
// its proxy (confirmed via `curl "$HTTPS_PROXY/__agentproxy/status"`:
// "connect_rejected ... policy denial", host openrouter.ai:443).
//
// Run from backend/, with the same env vars the app would use:
//   OPENROUTER_API_KEY=sk-or-v1-... OPENROUTER_MODEL=stealth/ox-alpha node scripts/check-llm.mjs
// or against Gemini:
//   GEMINI_API_KEY=... node scripts/check-llm.mjs
//
// Exercises the exact code path extraction/categorization/QuickBooks/Ask
// Rekono use (src/llm.js's callTool and generateText) rather than a
// separate reimplementation, so a pass here means those features will work.

import { callTool, generateText, llmConfigurationWarning, llmProvider } from "../src/llm.js";

const TEST_TOOL = {
  name: "record_answer",
  description: "Record the answer to the arithmetic question.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      sum: { type: "number", description: "The numeric result" },
      confidence: { type: "number", description: "0.0-1.0" },
    },
    required: ["sum"],
  },
};

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exitCode = 1;
}

function ok(msg) {
  console.log(`✓ ${msg}`);
}

const warning = llmConfigurationWarning();
if (warning) console.warn(`! ${warning}`);

const provider = llmProvider();
if (!provider) {
  fail("No LLM provider is configured. Set GEMINI_API_KEY, or both OPENROUTER_API_KEY and OPENROUTER_MODEL.");
  process.exit(1);
}
console.log(`Provider: ${provider}${provider === "openrouter" ? ` (${process.env.OPENROUTER_MODEL})` : ""}\n`);

console.log("--- Test 1: forced tool call (what extraction/categorization/QuickBooks need) ---");
try {
  const start = Date.now();
  const args = await callTool({
    prompt: "What is 21 plus 33? Call record_answer with the sum and your confidence.",
    tool: TEST_TOOL,
    maxOutputTokens: 512,
  });
  const ms = Date.now() - start;
  console.log(`  raw args: ${JSON.stringify(args)}  (${ms}ms)`);
  if (typeof args?.sum !== "number") {
    fail("Response didn't contain a numeric 'sum' -- tool calling may not be working as expected.");
  } else if (args.sum !== 54) {
    fail(`Got sum=${args.sum}, expected 54 -- the call went through, but check the model's reliability before relying on it for extraction.`);
  } else {
    ok("Tool calling works: forced a schema, got the right structured answer back.");
  }
} catch (err) {
  if (/no tool call/i.test(err.message)) {
    fail(`This model does not support tool/function calling: ${err.message}\n  Extraction, categorization, and both QuickBooks suggestions all need this -- they will silently fall back to the heuristic path with this model configured.`);
  } else {
    fail(`Tool call failed: ${err.message}`);
  }
}

console.log("\n--- Test 2: plain text (what Ask Rekono needs) ---");
try {
  const start = Date.now();
  const text = await generateText({
    system: "Answer in exactly one short sentence.",
    prompt: "What is the capital of France?",
    maxOutputTokens: 256,
  });
  const ms = Date.now() - start;
  console.log(`  response: ${JSON.stringify(text)}  (${ms}ms)`);
  if (/paris/i.test(text)) {
    ok("Plain text generation works.");
  } else {
    fail("Got a response, but it didn't mention Paris -- worth a manual look.");
  }
} catch (err) {
  fail(`Text generation failed: ${err.message}`);
}

console.log(process.exitCode ? "\nSome checks failed -- see above." : "\nAll checks passed.");
