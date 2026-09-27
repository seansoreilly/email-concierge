#!/usr/bin/env node
// Shared esbuild invocation for the Lambda packages (poll/api/draft-lambda),
// which all bundle the same way: single entry, ESM, Node 22, AWS SDK
// externalized (provided by the Lambda runtime), with a require() shim since
// some transitive deps are still CommonJS.
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "dist/index.mjs",
  external: ["@aws-sdk/*"],
  banner: {
    js: "import{createRequire}from'module';const require=createRequire(import.meta.url);",
  },
});
