import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./sync";

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
	writeFileSync(join(seedsDir, ".gitignore"), "*.lock\n");
}

let tmpDir: string;

beforeEach(async () => {
	tmpDir = realpathSync(await mkdtemp(join(tmpdir(), "suji-sync-test-")));
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

describe("sync — worktree guard", () => {
	test("warns and no-ops inside a worktree", async () => {
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

		// Capture console output
		const logs: string[] = [];
		const origLog = console.log;
		console.log = (...args: unknown[]) => {
			logs.push(args.map(String).join(" "));
		};

		const origCwd = process.cwd();
		process.chdir(wtDir);
		try {
			await run([]);
		} finally {
			process.chdir(origCwd);
			console.log = origLog;
		}

		expect(logs.some((l) => l.includes("worktree"))).toBe(true);
	});

	test("sd sync --json returns worktree: true inside a worktree", async () => {
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

		const logs: string[] = [];
		const origLog = console.log;
		console.log = (...args: unknown[]) => {
			logs.push(args.map(String).join(" "));
		};

		const origCwd = process.cwd();
		process.chdir(wtDir);
		try {
			await run(["--json"]);
		} finally {
			process.chdir(origCwd);
			console.log = origLog;
		}

		const output = JSON.parse(logs.join(""));
		expect(output.worktree).toBe(true);
		expect(output.committed).toBe(false);
		expect(output.success).toBe(true);
	});

	test("sd sync commits normally from main repo", async () => {
		const mainRepo = join(tmpDir, "main");
		mkdirSync(mainRepo);
		git(["init"], mainRepo);
		git(["config", "user.email", "test@test.com"], mainRepo);
		git(["config", "user.name", "Test"], mainRepo);
		initSeedsDir(mainRepo);
		git(["add", "."], mainRepo);
		git(["commit", "-m", "init"], mainRepo);

		// Create a new issue to have uncommitted changes
		const issuesPath = join(mainRepo, ".suji", "issues.jsonl");
		writeFileSync(
			issuesPath,
			'{"id":"test-0001","title":"Test","status":"open","type":"task","priority":2,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}\n',
		);

		const logs: string[] = [];
		const origLog = console.log;
		console.log = (...args: unknown[]) => {
			logs.push(args.map(String).join(" "));
		};

		const origCwd = process.cwd();
		process.chdir(mainRepo);
		try {
			await run([]);
		} finally {
			process.chdir(origCwd);
			console.log = origLog;
		}

		expect(logs.some((l) => l.includes("Committed"))).toBe(true);
	});
});

describe("sync — push", () => {
	test("push-short-circuit-no-github", async () => {
		const root = join(tmpDir, "repo");
		mkdirSync(root);
		git(["init"], root);
		git(["config", "user.email", "test@test.com"], root);
		git(["config", "user.name", "Test"], root);
		initSeedsDir(root);
		writeFileSync(
			join(root, ".suji", "issues.jsonl"),
			'{"id":"test-0001","title":"Open issue","status":"open","type":"task","priority":2,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}\n',
		);
		git(["add", "."], root);
		git(["commit", "-m", "init"], root);

		const logs: string[] = [];
		const origLog = console.log;
		console.log = (...args: unknown[]) => {
			logs.push(args.map(String).join(" "));
		};

		const origCwd = process.cwd();
		process.chdir(root);
		try {
			await run(["--push", "--json"]);
		} finally {
			process.chdir(origCwd);
			console.log = origLog;
		}

		const output = JSON.parse(logs.join(""));
		expect(output.success).toBe(true);
		expect(Object.hasOwn(output, "pushed")).toBe(false);
		expect(logs.some((l) => l.includes("Pushed:"))).toBe(false);
	});

	test("push-dry-run-lists-candidates", async () => {
		const root = join(tmpDir, "repo");
		mkdirSync(root);
		git(["init"], root);
		git(["config", "user.email", "test@test.com"], root);
		git(["config", "user.name", "Test"], root);
		initSeedsDir(root);
		writeFileSync(
			join(root, ".suji", "config.yaml"),
			'github_enabled: true\ngithub_repo: "test/repo"\nproject: "test"\nversion: "1"\n',
		);
		const issuesPath = join(root, ".suji", "issues.jsonl");
		const issueLines =
			[
				'{"id":"test-0001","title":"Candidate One","status":"open","type":"task","priority":2,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}',
				'{"id":"test-0002","title":"Candidate Two","status":"open","type":"task","priority":2,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}',
				'{"id":"test-0003","title":"Linked Issue","status":"open","type":"task","priority":2,"githubNumber":42,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}',
				'{"id":"test-0004","title":"Closed Issue","status":"closed","type":"task","priority":2,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}',
			].join("\n") + "\n";
		writeFileSync(issuesPath, issueLines);
		git(["add", "."], root);
		git(["commit", "-m", "init"], root);

		const logs: string[] = [];
		const origLog = console.log;
		console.log = (...args: unknown[]) => {
			logs.push(args.map(String).join(" "));
		};

		const origCwd = process.cwd();
		process.chdir(root);
		try {
			await run(["--push", "--dry-run"]);
		} finally {
			process.chdir(origCwd);
			console.log = origLog;
		}

		expect(readFileSync(issuesPath, "utf8")).toBe(issueLines);
		const wouldPushLogs = logs.filter((l) => l.includes("Would push:"));
		expect(wouldPushLogs.some((l) => l.includes("test-0001"))).toBe(true);
		expect(wouldPushLogs.some((l) => l.includes("test-0002"))).toBe(true);
		expect(wouldPushLogs.some((l) => l.includes("test-0003"))).toBe(false);
		expect(wouldPushLogs.some((l) => l.includes("test-0004"))).toBe(false);
	});

	test("push-status-no-mutate", async () => {
		const root = join(tmpDir, "repo");
		mkdirSync(root);
		git(["init"], root);
		git(["config", "user.email", "test@test.com"], root);
		git(["config", "user.name", "Test"], root);
		initSeedsDir(root);
		writeFileSync(
			join(root, ".suji", "config.yaml"),
			'github_enabled: true\ngithub_repo: "test/repo"\nproject: "test"\nversion: "1"\n',
		);
		const issuesPath = join(root, ".suji", "issues.jsonl");
		writeFileSync(
			issuesPath,
			[
				'{"id":"test-0001","title":"Candidate One","status":"open","type":"task","priority":2,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}',
				'{"id":"test-0002","title":"Candidate Two","status":"open","type":"task","priority":2,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}',
				'{"id":"test-0003","title":"Linked Issue","status":"open","type":"task","priority":2,"githubNumber":42,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}',
				'{"id":"test-0004","title":"Closed Issue","status":"closed","type":"task","priority":2,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}',
			].join("\n") + "\n",
		);
		git(["add", "."], root);
		git(["commit", "-m", "init"], root);

		const logs: string[] = [];
		const origLog = console.log;
		console.log = (...args: unknown[]) => {
			logs.push(args.map(String).join(" "));
		};

		const origCwd = process.cwd();
		process.chdir(root);
		try {
			await run(["--push", "--status"]);
		} finally {
			process.chdir(origCwd);
			console.log = origLog;
		}

		expect(logs.some((l) => l.includes("Would push:") && l.includes("test-0001"))).toBe(true);
		expect(logs.some((l) => l.includes("Would push:") && l.includes("test-0002"))).toBe(true);
		expect(
			logs.some(
				(l) =>
					l.includes("No uncommitted .suji/ changes") || l.includes("Uncommitted .suji/ changes"),
			),
		).toBe(true);
	});

	test("regular-sync-unchanged", async () => {
		const root = join(tmpDir, "repo");
		mkdirSync(root);
		git(["init"], root);
		git(["config", "user.email", "test@test.com"], root);
		git(["config", "user.name", "Test"], root);
		initSeedsDir(root);
		git(["add", "."], root);
		git(["commit", "-m", "init"], root);

		writeFileSync(
			join(root, ".suji", "issues.jsonl"),
			'{"id":"test-0001","title":"Test","status":"open","type":"task","priority":2,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}\n',
		);

		const logs: string[] = [];
		const origLog = console.log;
		console.log = (...args: unknown[]) => {
			logs.push(args.map(String).join(" "));
		};

		const origCwd = process.cwd();
		process.chdir(root);
		try {
			await run([]);
		} finally {
			process.chdir(origCwd);
			console.log = origLog;
		}

		expect(logs.some((l) => l.includes("Committed"))).toBe(true);
		expect(logs.some((l) => l.includes("Pushed:"))).toBe(false);
		expect(logs.some((l) => l.includes("Would push:"))).toBe(false);
	});
});
