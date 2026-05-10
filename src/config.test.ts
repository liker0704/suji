import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSeedsDir, isInsideWorktree } from "./config";

function git(args: string[], cwd: string): void {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if ((result.exitCode ?? 0) !== 0) {
		const stderr = new TextDecoder().decode(result.stderr);
		throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
	}
}

function initSeedsDir(root: string): void {
	const seedsDir = join(root, ".suji");
	mkdirSync(seedsDir, { recursive: true });
	writeFileSync(join(seedsDir, "config.yaml"), 'project: "test"\nversion: "1"\n');
	writeFileSync(join(seedsDir, "issues.jsonl"), "");
}

let tmpDir: string;

beforeEach(async () => {
	tmpDir = realpathSync(await mkdtemp(join(tmpdir(), "suji-config-test-")));
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

describe("findSeedsDir — worktree resolution", () => {
	test("resolves to main root from a worktree", async () => {
		const mainRepo = join(tmpDir, "main");
		mkdirSync(mainRepo);
		git(["init"], mainRepo);
		git(["config", "user.email", "test@test.com"], mainRepo);
		git(["config", "user.name", "Test"], mainRepo);
		initSeedsDir(mainRepo);
		git(["add", "."], mainRepo);
		git(["commit", "-m", "init"], mainRepo);

		const wtDir = join(tmpDir, "wt");
		git(["worktree", "add", wtDir, "-b", "wt-branch"], mainRepo);

		// worktree also gets .suji/ via the branch content
		const result = await findSeedsDir(wtDir);
		expect(result).toBe(join(mainRepo, ".suji"));
	});

	test("falls back to worktree .suji/ when main root has none", async () => {
		const mainRepo = join(tmpDir, "main");
		mkdirSync(mainRepo);
		git(["init"], mainRepo);
		git(["config", "user.email", "test@test.com"], mainRepo);
		git(["config", "user.name", "Test"], mainRepo);
		writeFileSync(join(mainRepo, "README.md"), "hello");
		git(["add", "."], mainRepo);
		git(["commit", "-m", "init"], mainRepo);

		const wtDir = join(tmpDir, "wt");
		git(["worktree", "add", wtDir, "-b", "wt-branch"], mainRepo);

		// Only init .suji/ in worktree, NOT in main
		initSeedsDir(wtDir);

		const result = await findSeedsDir(wtDir);
		expect(result).toBe(join(wtDir, ".suji"));
	});

	test("no-op when in main repo (not a worktree)", async () => {
		const mainRepo = join(tmpDir, "main");
		mkdirSync(mainRepo);
		git(["init"], mainRepo);
		initSeedsDir(mainRepo);

		const result = await findSeedsDir(mainRepo);
		expect(result).toBe(join(mainRepo, ".suji"));
	});

	test("no-op when not in a git repo", async () => {
		const plainDir = join(tmpDir, "plain");
		mkdirSync(plainDir);
		initSeedsDir(plainDir);

		const result = await findSeedsDir(plainDir);
		expect(result).toBe(join(plainDir, ".suji"));
	});
});

describe("isInsideWorktree", () => {
	test("returns true inside a worktree", () => {
		const mainRepo = join(tmpDir, "main");
		mkdirSync(mainRepo);
		git(["init"], mainRepo);
		git(["config", "user.email", "test@test.com"], mainRepo);
		git(["config", "user.name", "Test"], mainRepo);
		writeFileSync(join(mainRepo, "README.md"), "hello");
		git(["add", "."], mainRepo);
		git(["commit", "-m", "init"], mainRepo);

		const wtDir = join(tmpDir, "wt");
		git(["worktree", "add", wtDir, "-b", "wt-branch"], mainRepo);

		expect(isInsideWorktree(wtDir)).toBe(true);
	});

	test("returns false in main repo", () => {
		const mainRepo = join(tmpDir, "main");
		mkdirSync(mainRepo);
		git(["init"], mainRepo);

		expect(isInsideWorktree(mainRepo)).toBe(false);
	});

	test("returns false outside a git repo", () => {
		const plainDir = join(tmpDir, "plain");
		mkdirSync(plainDir);

		expect(isInsideWorktree(plainDir)).toBe(false);
	});
});
