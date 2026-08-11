import { app } from "./app.js";
import { initDb } from "./models/index.js";

const port = process.env.PORT || 8000;

await initDb();
app.listen(port, () => {
  console.log(`Rekono listening on port ${port}`);
});
