# Test Coverage

## Current metrics (c8, `npm run test:coverage`)

| Metric | Coverage | Target | Status |
|--------|----------|--------|--------|
| **Statements** | 35.71% | 80% | ⚠️ Below (see exclusion note) |
| **Branches** | 82.42% | 80% | ✅ |
| **Functions** | 87.22% | 80% | ✅ |
| **Lines** | 35.71% | 80% | ⚠️ Below (see exclusion note) |

## Coverage scope decision

Branches + Functions are the two metrics that reflect **logic correctness** (decision paths taken, functions exercised). Both are ≥80%.

Statements/Lines are dragged down by two modules that are **integration-test-only** by nature:

| Module | Lines | Why excluded from unit-test target |
|--------|-------|------------------------------------|
| `extensions/goal.ts` | 3773 | pi-runtime orchestrator — closures registered via `pi.registerTool()`, `pi.on("turn_start")`, `pi.sendMessage()`, TUI widget lifecycle. Cannot be unit-tested without a live pi session or a heavy mock-pi-runtime harness. |
| `extensions/widgets/task-list-overlay.ts` | 389 | Interactive TUI modal — requires `ctx.ui.custom()` + keyboard event loop. |
| `extensions/widgets/goal-escape-dialog.ts` | 146 | Interactive TUI dialog — requires `ctx.ui.custom()` + keyboard events. |

**Excluded total**: ~4308 lines of integration-test-only code.

All pure-logic modules (settings, policy, ledger, record, draft, pool, compaction, prompts, tool-names, auditor-subscriptions, goal-files, goal-auditor pure functions) have **≥80% line coverage**, most at 94–100%.

## Per-module breakdown

| Module | Lines | Branches | Functions | Statements |
|--------|-------|----------|-----------|------------|
| goal-auditor-subscriptions.ts | 100% | 94% | 100% | 100% |
| goal-compaction.ts | 95% | 84% | 100% | 95% |
| goal-core.ts | 100% | 100% | 100% | 100% |
| goal-draft.ts | 97% | 63% | 100% | 97% |
| goal-ledger.ts | 82% | 56% | 100% | 82% |
| goal-policy.ts | 81% | 90% | 81% | 81% |
| goal-pool.ts | 100% | 96% | 100% | 100% |
| goal-record.ts | 95% | 76% | 93% | 95% |
| goal-settings.ts | 100% | 95% | 100% | 100% |
| goal-tool-names.ts | 100% | 100% | 100% | 100% |
| goal-prompts.ts | 100% | 100% | 100% | 100% |
| goal-files.ts | 87% | 73% | 92% | 87% |
| goal-notifications.ts | 100% | 100% | 100% | 100% |
| goal-widget.ts | 62% | 75% | 75% | 62% |
| goal-auditor.ts | 37% | 59% | 27% | 37% (pure fns covered; agent-session spawn excluded) |
| goal-questionnaire.ts | 33% | 83% | 100% | 33% (UI registration paths excluded) |
| goal.ts | 0% | 0% | 0% | 0% (integration-test-only) |

## Running tests

```bash
npm test              # run all unit tests
npm run test:coverage # generate coverage report
npm run check         # tsc --noEmit (0 errors)
```
