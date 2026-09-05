import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const directory = resolve(fileURLToPath(new URL(".", import.meta.url)));
if (!process.argv.includes("--repo-root")) {
  process.argv.push("--repo-root", resolve(directory, "../../.."));
}
const jiti = createJiti(import.meta.url);
await jiti.import("./cli.ts");
