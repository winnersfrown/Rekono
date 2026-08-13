import { app } from "./app.js";
import { initDb } from "./models/index.js";
import { recoverOrphanedJobs } from "./jobs.js";

const port = process.env.PORT || 8000;

await initDb();
await recoverOrphanedJobs();
app.listen(port, () => {
  console.log(`Rekono listening on port ${port}`);
});
