import { createRequire } from "node:module";

// The manifest sits one directory above both `src/` under tsx and `dist/` in a published
// install, so a runtime require keeps package.json the single source of the version.
const requireFromHere = createRequire(import.meta.url);

export const cliVersion: string = (requireFromHere("../package.json") as { version: string }).version;
