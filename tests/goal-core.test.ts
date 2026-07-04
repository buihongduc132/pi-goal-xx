import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	truncateText,
	displayObjectiveTitle,
	formatTokenValue,
	formatDuration,
	statusLabel,
	footerStatus,
	shortGoalId,
	shortSessionId,
	formatRelativeTime,
	formatAbsoluteShort,
	compactStatusLabel,
} from "../extensions/goal-core.ts";
import type { GoalDisplayRecordLike } from "../extensions/goal-core.ts";

describe("truncateText", () => {
	it("returns short text unchanged (collapsed whitespace)", () => {
		assert.equal(truncateText("hello world"), "hello world");
	});

	it("collapses runs of whitespace into single spaces and trims", () => {
		assert.equal(truncateText("  hello   world  "), "hello world");
		assert.equal(truncateText("a\tb\nc\n\n\nd"), "a b c d");
	});

	it("truncates with ellipsis when exceeding max", () => {
		const out = truncateText("abcdefghij", 5);
		// 5 - 3 = 2 chars + "..."
		assert.equal(out, "ab...");
	});

	it("uses default max of 120", () => {
		const short = "x".repeat(120);
		assert.equal(truncateText(short), short);
		const long = "x".repeat(121);
		assert.equal(truncateText(long), "x".repeat(117) + "...");
	});

	it("exactly at max is not truncated", () => {
		assert.equal(truncateText("abcdef", 6), "abcdef");
	});

	it("empty string returns empty", () => {
		assert.equal(truncateText(""), "");
	});
});

describe("displayObjectiveTitle", () => {
	it("extracts the 'objective:' labelled line when it is the first real line", () => {
		assert.equal(displayObjectiveTitle("objective: Build a toaster"), "Build a toaster");
	});

	it("returns the FIRST non-banner/non-section line, even if an objective: label appears later", () => {
		// The function does not scan ahead; first real line wins.
		const obj = `some leading line
objective: Build a toaster`;
		assert.equal(displayObjectiveTitle(obj), "some leading line");
	});

	it("extracts the Chinese 目标: labelled line", () => {
		assert.equal(displayObjectiveTitle("目标: 造烤面包机"), "造烤面包机");
	});

	it("skips a '===== goal =====' banner and returns first non-banner line", () => {
		const obj = `===== sisyphus goal =====
Build something cool
more detail`;
		assert.equal(displayObjectiveTitle(obj), "Build something cool");
	});

	it("skips section headers (success criteria:, steps:, etc.) and returns the first real line", () => {
		const obj = `success criteria: it works
steps: do things
The real first line`;
		assert.equal(displayObjectiveTitle(obj), "The real first line");
	});

	it("returns truncated objective when only section headers present", () => {
		const obj = `success criteria: x
boundaries: y`;
		// Both lines are section headers → falls through → returns truncateText(obj)
		assert.equal(displayObjectiveTitle(obj), truncateText(obj));
	});

	it("falls back to truncated full text when no usable line", () => {
		const obj = "    \n  \n";
		assert.equal(displayObjectiveTitle(obj), "");
	});

	it("label value is trimmed", () => {
		assert.equal(displayObjectiveTitle("objective:    spaced out   "), "spaced out");
	});

	it("banner-only first then objective label extracts the label", () => {
		const obj = `===== goal =====
objective: the real goal`;
		assert.equal(displayObjectiveTitle(obj), "the real goal");
	});
});

describe("formatTokenValue", () => {
	it("formats values < 1000 as plain with 'tokens'", () => {
		assert.equal(formatTokenValue(0), "0 tokens");
		assert.equal(formatTokenValue(42), "42 tokens");
		assert.equal(formatTokenValue(999), "999 tokens");
	});

	it("formats 1_000 .. 9_999 as K with one decimal", () => {
		assert.equal(formatTokenValue(1000), "1K (1,000) tokens");
		assert.equal(formatTokenValue(1500), "1.5K (1,500) tokens");
		assert.equal(formatTokenValue(2000), "2K (2,000) tokens");
	});

	it("strips trailing .0 for exact thousands", () => {
		assert.equal(formatTokenValue(3000), "3K (3,000) tokens");
	});

	it("formats 10_000 .. 999_999 as rounded K (no decimal)", () => {
		assert.equal(formatTokenValue(10_000), "10K (10,000) tokens");
		assert.equal(formatTokenValue(12_345), "12K (12,345) tokens");
		assert.equal(formatTokenValue(999_999), "1000K (999,999) tokens");
	});

	it("formats millions with one decimal (under 10M)", () => {
		assert.equal(formatTokenValue(1_000_000), "1M (1,000,000) tokens");
		assert.equal(formatTokenValue(1_500_000), "1.5M (1,500,000) tokens");
	});

	it("formats >=10M millions with no decimal", () => {
		assert.equal(formatTokenValue(10_000_000), "10M (10,000,000) tokens");
		// 12.5M → toFixed(0) rounds → "12" or "13" depending on engine; match loosely
		assert.match(formatTokenValue(12_500_000), /^1[23]M \(12,500,000\) tokens$/);
	});

	it("formats billions", () => {
		assert.equal(formatTokenValue(1_000_000_000), "1B (1,000,000,000) tokens");
		assert.equal(formatTokenValue(2_500_000_000), "2.5B (2,500,000,000) tokens");
	});

	it("formats >=10B with no decimal", () => {
		assert.equal(formatTokenValue(10_000_000_000), "10B (10,000,000,000) tokens");
	});

	it("floors and clamps negatives to 0", () => {
		assert.equal(formatTokenValue(-5), "0 tokens");
		assert.equal(formatTokenValue(12.9), "12 tokens");
	});

	it("when compact equals exact, omits the parenthetical", () => {
		// 0 → compact "0", exact "0" → equal → "0 tokens"
		assert.equal(formatTokenValue(0), "0 tokens");
	});
});

describe("formatDuration", () => {
	it("formats pure seconds", () => {
		assert.equal(formatDuration(0), "0s");
		assert.equal(formatDuration(5), "5s");
		assert.equal(formatDuration(59), "59s");
	});

	it("formats minutes + seconds", () => {
		assert.equal(formatDuration(60), "1m00s");
		assert.equal(formatDuration(65), "1m05s");
		assert.equal(formatDuration(125), "2m05s");
	});

	it("formats hours + minutes + seconds", () => {
		assert.equal(formatDuration(3600), "1h00m00s");
		assert.equal(formatDuration(3661), "1h01m01s");
		assert.equal(formatDuration(7384), "2h03m04s");
	});

	it("clamps negatives to 0", () => {
		assert.equal(formatDuration(-100), "0s");
	});

	it("floors fractional seconds", () => {
		assert.equal(formatDuration(59.9), "59s");
		assert.equal(formatDuration(60.9), "1m00s");
	});
});

describe("statusLabel", () => {
	it("active + autoContinue → 'running'", () => {
		assert.equal(statusLabel({ sisyphus: false, status: "active", autoContinue: true }), "running");
	});

	it("active without autoContinue → 'active'", () => {
		assert.equal(statusLabel({ sisyphus: false, status: "active", autoContinue: false }), "active");
	});

	it("paused + agent stopReason → 'paused (agent)'", () => {
		assert.equal(
			statusLabel({ sisyphus: false, status: "paused", autoContinue: false, stopReason: "agent" }),
			"paused (agent)",
		);
	});

	it("paused without agent stopReason → 'paused'", () => {
		assert.equal(
			statusLabel({ sisyphus: false, status: "paused", autoContinue: false }),
			"paused",
		);
		assert.equal(
			statusLabel({ sisyphus: false, status: "paused", autoContinue: false, stopReason: "user" }),
			"paused",
		);
	});

	it("complete → 'complete'", () => {
		assert.equal(statusLabel({ sisyphus: false, status: "complete", autoContinue: false }), "complete");
	});

	it("sisyphus prefixes the label", () => {
		assert.equal(statusLabel({ sisyphus: true, status: "active", autoContinue: true }), "sisyphus running");
		assert.equal(statusLabel({ sisyphus: true, status: "complete", autoContinue: false }), "sisyphus complete");
		assert.equal(
			statusLabel({ sisyphus: true, status: "paused", autoContinue: false, stopReason: "agent" }),
			"sisyphus paused (agent)",
		);
	});
});

describe("footerStatus", () => {
	function goal(over: Partial<GoalDisplayRecordLike>): GoalDisplayRecordLike {
		return {
			objective: "do the thing",
			status: "active",
			autoContinue: false,
			usage: { tokensUsed: 0, activeSeconds: 0 },
			sisyphus: false,
			...over,
		};
	}

	it("includes status + truncated objective, no usage when zero", () => {
		const g = goal({});
		// no usage bits → no [..]; objective truncated to 60
		assert.equal(footerStatus(g), `goal: active - ${truncateText(g.objective, 60)}`);
	});

	it("appends duration when activeSeconds > 0", () => {
		const g = goal({ usage: { tokensUsed: 0, activeSeconds: 60 } });
		assert.match(footerStatus(g), /\[1m00s\]/);
	});

	it("appends token compact when tokensUsed > 0", () => {
		const g = goal({ usage: { tokensUsed: 1500, activeSeconds: 0 } });
		assert.match(footerStatus(g), /\[1\.5K\]/);
	});

	it("appends both duration and tokens when both > 0", () => {
		const g = goal({ usage: { tokensUsed: 2000, activeSeconds: 125 } });
		assert.match(footerStatus(g), /\[2m05s 2K\]/);
	});

	it("uses goal✊ prefix for sisyphus", () => {
		const g = goal({ sisyphus: true, status: "active", autoContinue: true });
		assert.match(footerStatus(g), /^goal✊: sisyphus running/);
	});

	it("truncates objective to 60 chars", () => {
		const long = "x".repeat(200);
		const g = goal({ objective: long });
		assert.equal(footerStatus(g), `goal: active - ${truncateText(long, 60)}`);
	});
});

// ── goal-focus-picker-ux: new helpers ────────────────────────────────────────
// These tests pin the requirements in
// openspec/changes/goal-focus-picker-ux/specs/goal-focus-picker/spec.md.

describe("shortGoalId", () => {
	it("returns substring after the final dash", () => {
		assert.equal(shortGoalId("mr62bc2x-qi4x4i"), "qi4x4i");
	});

	it("returns whole id when there is no dash", () => {
		assert.equal(shortGoalId("nodash"), "nodash");
	});

	it("returns the LAST segment when multiple dashes present", () => {
		assert.equal(shortGoalId("a-b-c"), "c");
	});

	it("empty input returns empty string", () => {
		assert.equal(shortGoalId(""), "");
	});

	it("does not strip a trailing dash (suffix is empty string)", () => {
		// 'id-' → lastIndexOf('-') points at the trailing dash → slice after it = ''
		assert.equal(shortGoalId("id-"), "");
	});
});

describe("shortSessionId", () => {
	it("returns last 6 chars when longer than 6", () => {
		// 'ses_abcdef12345' (len 14) → last 6 = 'f12345'
		assert.equal(shortSessionId("ses_abcdef12345"), "f12345");
	});

	it("returns whole id when length <= 6", () => {
		assert.equal(shortSessionId("abc"), "abc");
		assert.equal(shortSessionId("abcdef"), "abcdef");
		assert.equal(shortSessionId(""), "");
	});
});

describe("formatRelativeTime", () => {
	// Use a fixed 'now' so assertions are deterministic.
	const NOW = Date.parse("2026-07-04T15:00:00Z");

	it("30 seconds ago → 'just now'", () => {
		const iso = new Date(NOW - 30_000).toISOString();
		assert.equal(formatRelativeTime(iso, NOW), "just now");
	});

	it("59 seconds ago → 'just now' (boundary just below 1 minute)", () => {
		const iso = new Date(NOW - 59_000).toISOString();
		assert.equal(formatRelativeTime(iso, NOW), "just now");
	});

	it("5 minutes ago → '5m ago'", () => {
		const iso = new Date(NOW - 5 * 60_000).toISOString();
		assert.equal(formatRelativeTime(iso, NOW), "5m ago");
	});

	it("2 hours ago → '2h ago'", () => {
		const iso = new Date(NOW - 2 * 3_600_000).toISOString();
		assert.equal(formatRelativeTime(iso, NOW), "2h ago");
	});

	it("3 days ago → '3d ago'", () => {
		const iso = new Date(NOW - 3 * 86_400_000).toISOString();
		assert.equal(formatRelativeTime(iso, NOW), "3d ago");
	});

	it("future timestamp clamps to 'just now' (clock skew tolerance)", () => {
		const iso = new Date(NOW + 10 * 60_000).toISOString();
		assert.equal(formatRelativeTime(iso, NOW), "just now");
	});

	it("empty string → '—'", () => {
		assert.equal(formatRelativeTime("", NOW), "—");
	});

	it("invalid ISO → '—'", () => {
		assert.equal(formatRelativeTime("not-a-date", NOW), "—");
		assert.equal(formatRelativeTime("2026-13-99", NOW), "—");
	});
});

describe("formatAbsoluteShort", () => {
	it("formats a valid ISO as 'MM-DD HH:mm'", () => {
		const iso = "2026-07-04T14:50:00"; // local time, no Z
		assert.match(formatAbsoluteShort(iso), /^\d{2}-\d{2} \d{2}:\d{2}$/);
	});

	it("produces the expected month/day/hour/minute components", () => {
		const iso = "2026-07-04T14:50:00";
		const out = formatAbsoluteShort(iso);
		// Local tz-independent: month=07, day=04, hour=14, minute=50
		assert.ok(out.startsWith("07-04 "), `expected '07-04 ...' got '${out}'`);
		assert.ok(out.endsWith(" 14:50"), `expected '... 14:50' got '${out}'`);
	});

	it("empty string → '—'", () => {
		assert.equal(formatAbsoluteShort(""), "—");
	});

	it("invalid ISO → '—'", () => {
		assert.equal(formatAbsoluteShort("not-a-date"), "—");
	});
});

describe("compactStatusLabel", () => {
	it("active + autoContinue → 'running'", () => {
		assert.equal(compactStatusLabel({ status: "active", autoContinue: true }), "running");
	});

	it("active WITHOUT autoContinue → 'active'", () => {
		assert.equal(compactStatusLabel({ status: "active", autoContinue: false }), "active");
	});

	it("paused + stopReason agent → 'paused·agent'", () => {
		assert.equal(compactStatusLabel({ status: "paused", autoContinue: false, stopReason: "agent" }), "paused·agent");
	});

	it("paused + stopReason user → 'paused'", () => {
		assert.equal(compactStatusLabel({ status: "paused", autoContinue: false, stopReason: "user" }), "paused");
	});

	it("paused without stopReason → 'paused'", () => {
		assert.equal(compactStatusLabel({ status: "paused", autoContinue: false }), "paused");
	});

	it("does NOT prepend 'sisyphus ' (the whole point — no duplication)", () => {
		// sisyphus mode is surfaced as a leading glyph on the row, not in the status pill.
		const out = compactStatusLabel({ status: "active", autoContinue: true });
		assert.ok(!out.startsWith("sisyphus"), `must not start with 'sisyphus', got '${out}'`);
		assert.ok(!out.includes("sisyphus"), `must not contain 'sisyphus', got '${out}'`);
	});
});

describe("displayObjectiveTitle — sanitization (goal-focus-picker-ux)", () => {
	it("strips a leading code fence with a language tag", () => {
		// '```ts do the thing' → strips fence + lang tag 'ts' → 'do the thing'.
		// (Note: bare fence + prose on same line like '```do the thing' is NOT
		// supported — the word after the fence is parsed as a lang tag. See report.)
		assert.equal(displayObjectiveTitle("```ts do the thing"), "do the thing");
	});

	it("strips a leading blockquote marker", () => {
		assert.equal(displayObjectiveTitle("> do the thing"), "do the thing");
	});

	it("strips surrounding double quotes", () => {
		assert.equal(displayObjectiveTitle('"quoted"'), "quoted");
	});

	it("strips surrounding single quotes", () => {
		assert.equal(displayObjectiveTitle("'single'"), "single");
	});

	it("strips a combined prefix '> ``` \"x\"'", () => {
		// Repeated stripping collapses nested prefixes.
		assert.equal(displayObjectiveTitle('> ``` "x"'), "x");
	});

	it("normal prose is unchanged", () => {
		assert.equal(displayObjectiveTitle("just plain text"), "just plain text");
	});

	it("'Objective: ...' label is still extracted AND sanitized", () => {
		assert.equal(displayObjectiveTitle('Objective: "ship it"'), "ship it");
	});

	it("four-backtick fence with lang tag is stripped", () => {
		// '````ts real title' → strips 4 backticks + lang 'ts' → 'real title'.
		assert.equal(displayObjectiveTitle("````ts real title"), "real title");
	});
});
