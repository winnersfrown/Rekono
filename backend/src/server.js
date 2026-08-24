import { app } from "./app.js";
import { initDb } from "./models/index.js";
import { recoverOrphanedJobs } from "./jobs.js";
import { llmConfigurationWarning, llmProvider } from "./llm.js";

const port = process.env.PORT || 8000;

await initDb();
await recoverOrphanedJobs();

// Which model (if any) is behind extraction, categorization and Ask Rekono
// is otherwise invisible until someone uploads a document and wonders why
// the confidence scores look like the heuristic extractor's.
const warning = llmConfigurationWarning();
if (warning) console.warn(warning);
const provider = llmProvider();
console.log(
  provider ? `LLM provider: ${provider}` : "No LLM provider configured -- extraction will use the heuristic fallback."
);

app.listen(port, () => {
  console.log(`Rekono listening on port ${port}`);
});
