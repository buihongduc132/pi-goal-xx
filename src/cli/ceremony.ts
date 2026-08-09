/**
 * Default ceremony workflow contract — baked into every goal file's
 * verificationContract field and mirrored in the objective text.
 *
 * This is the CANONICAL implementation ceremony (10 ordered steps + auditor
 * hard-reject rule). All goal-xx-* family commands point here.
 */
export const DEFAULT_CEREMONY_CONTRACT = [
	"Ordered workflow (MANDATORY):",
	"(1) use worktree-lifecycle + worst-first-testing + coding-rules + e2e-testing + teams-workflow + abw + verifier-loop + pr-creation skills;",
	"(2) all work in separate worktree branched off main, never main checkout;",
	"(3) TDD worst-first, RED committed SEPARATELY from GREEN (never bundle);",
	"(4) delegate sub-agents via teams-workflow when parallelizable (fresh forks per cycle, teams tool only);",
	"(5) MUST implement e2e tests (real fullstack FE→BE→DB, not app.inject);",
	"(6) MUST start app + smoke-test feature in browser via abw — verify works FROM FE, not just API 200;",
	"(7) pass verifier-loop BEFORE completion — else auditor rejects (PRIMARY=jewilo CLI);",
	"(8) rebase work branch onto latest main after verifier passes;",
	"(9) run pr-creation skill;",
	"(10) ensure all work complete + local main synced to remote.",
	"AUDITOR HARD-REJECT: no verifier-loop approval hash present → instant <disapproved/>, skip all other checks.",
].join(" ");
