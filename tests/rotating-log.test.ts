/**
 * G5 — rotating-log helper tests.
 *
 * Validates the size-capped rotation used by auditor-trace.jsonl and
 * goal_events.jsonl: when a file reaches the cap, it rotates to `.1`, shifts
 * older rotations down, and drops the oldest past the keep count.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	rotateIfNeeded,
	DEFAULT_ROTATING_LOG_MAX_BYTES,
	DEFAULT_ROTATING_LOG_KEEP,
} from "../extensions/storage/rotating-log.ts";

function makeTmpFile(seed = "rot"): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pgxx-rot-${seed}-`));
	return path.join(dir, "log.jsonl");
}

describe("G5: rotateIfNeeded", () => {
	let file: string;
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pgxx-rot-"));
		file = path.join(dir, "log.jsonl");
	});

	afterEach(() => {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
	});

	it("does NOT rotate when the file is below the cap", () => {
		fs.writeFileSync(file, "small");
		rotateIfNeeded(file, 1024, 3);
		assert.ok(fs.existsSync(file), "live file must remain");
		assert.ok(!fs.existsSync(`${file}.1`), "no rotation should occur below the cap");
	});

	it("rotates the live file to .1 when it reaches the cap", () => {
		fs.writeFileSync(file, "x".repeat(1024));
		rotateIfNeeded(file, 1024, 3);
		assert.ok(!fs.existsSync(file), "live file must be rotated away");
		assert.ok(fs.existsSync(`${file}.1`), "live file must move to .1");
		assert.equal(fs.readFileSync(`${file}.1`, "utf8"), "x".repeat(1024));
	});

	it("shifts prior rotations down and drops the oldest past keepCount", () => {
		fs.writeFileSync(file, "live");
		fs.writeFileSync(`${file}.1`, "rot1");
		fs.writeFileSync(`${file}.2`, "rot2");
		fs.writeFileSync(`${file}.3`, "rot3");
		// live is tiny, so force rotation by setting cap below its size.
		rotateIfNeeded(file, 1, 3);
		// live → .1 (live), old .1 → .2 (rot1), old .2 → .3 (rot2), old .3 dropped.
		assert.ok(!fs.existsSync(file));
		assert.equal(fs.readFileSync(`${file}.1`, "utf8"), "live");
		assert.equal(fs.readFileSync(`${file}.2`, "utf8"), "rot1");
		assert.equal(fs.readFileSync(`${file}.3`, "utf8"), "rot2");
		assert.ok(!fs.existsSync(`${file}.4`), "oldest rotation past keepCount must be dropped");
	});

	it("does not throw when the file does not exist", () => {
		assert.doesNotThrow(() => rotateIfNeeded(path.join(dir, "missing.jsonl"), 10, 3));
	});

	it("exposes sensible default cap and keep values", () => {
		assert.equal(DEFAULT_ROTATING_LOG_MAX_BYTES, 10 * 1024 * 1024);
		assert.equal(DEFAULT_ROTATING_LOG_KEEP, 3);
	});

	it("rotates exactly at the cap boundary (size >= maxBytes)", () => {
		fs.writeFileSync(file, "x".repeat(100));
		rotateIfNeeded(file, 100, 3);
		assert.ok(!fs.existsSync(file), "file at exactly the cap must rotate");
		assert.ok(fs.existsSync(`${file}.1`));
	});

	it("rotates BEFORE appending when size + appendBytes would exceed the cap", () => {
		// Existing file is under the cap but the incoming record would push it over.
		fs.writeFileSync(file, "x".repeat(80));
		rotateIfNeeded(file, 100, 3, 30);
		assert.ok(!fs.existsSync(file), "file must rotate when size+append > cap");
		assert.ok(fs.existsSync(`${file}.1`));
	});

	it("does NOT rotate when size + appendBytes still fits under the cap", () => {
		fs.writeFileSync(file, "x".repeat(70));
		rotateIfNeeded(file, 100, 3, 25);
		assert.ok(fs.existsSync(file), "file must stay when size+append <= cap");
		assert.ok(!fs.existsSync(`${file}.1`));
	});
});
