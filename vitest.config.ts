import { defineConfig } from "vitest/config";

// This repo runs TWO test frameworks:
//   - node:test (100 files) — canonical runner: `npm test`
//     (node --experimental-strip-types --test tests/*.test.ts).
//   - vitest (3 files below) — run via `npx vitest run`.
// Without this include filter, vitest tries to collect the node:test files
// and fails every one with "No test suite found in file" (they register
// suites through node:test's describe/it, which vitest does not execute).
// Scope vitest to its own files; node:test keeps the rest via `npm test`.
export default defineConfig({
	test: {
		include: [
			"tests/auditor-persona.test.ts",
			"tests/goal-hash.test.ts",
			"tests/goal-continuation-throttle.test.ts",
		],
	},
});
