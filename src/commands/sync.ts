import type { Command } from "commander";
import { findSeedsDir, isInsideWorktree, projectRootFromSeedsDir, readConfig } from "../config.ts";
import { outputJson, printSuccess, printWarning } from "../output.ts";
import { issuesPath, readIssues, withLock, writeIssues } from "../store.ts";
import { SUJI_DIR_NAME } from "../types.ts";

function spawnSync(
	cmd: string[],
	cwd: string,
): { stdout: string; stderr: string; exitCode: number } {
	const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	const stdout = new TextDecoder().decode(result.stdout);
	const stderr = new TextDecoder().decode(result.stderr);
	return { stdout, stderr, exitCode: result.exitCode ?? 0 };
}

/** Check if .suji/ is in .gitignore. */
function isSeedsIgnored(projectRoot: string): boolean {
	const result = spawnSync(
		["git", "-C", projectRoot, "check-ignore", "-q", `${SUJI_DIR_NAME}/`],
		projectRoot,
	);
	return result.exitCode === 0;
}

/** Pull state changes and comments from GitHub into sd. */
async function syncFromGitHub(dir: string, jsonMode: boolean): Promise<{ pulled: number }> {
	const config = await readConfig(dir);
	if (!config.github_enabled) return { pulled: 0 };

	const { ghIsAvailable, detectGitHubRepo, ghList, ghListComments } = await import("../github.ts");
	if (!(await ghIsAvailable())) return { pulled: 0 };

	const repo = config.github_repo ?? (await detectGitHubRepo(process.cwd()));
	if (!repo) return { pulled: 0 };

	let pulled = 0;

	await withLock(issuesPath(dir), async () => {
		const issues = await readIssues(dir);
		let changed = false;

		// Get all GitHub issues (open + closed)
		const ghIssues = await ghList(repo, { state: "all", limit: 200 });

		// Auto-discover: link sd issues that don't have githubNumber yet
		// Match by Suji ID in GitHub issue body (`Suji ID: \`overstory-xxxx\``)
		for (const ghIssue of ghIssues) {
			// Skip if already linked to an sd issue
			if (issues.some((i) => i.githubNumber === ghIssue.number)) continue;

			// Try to find Suji ID in body
			const seedsIdMatch = ghIssue.body.match(/Suji ID: `([^`]+)`/);
			if (seedsIdMatch?.[1]) {
				const sdId = seedsIdMatch[1];
				const idx = issues.findIndex((i) => i.id === sdId && !i.githubNumber);
				if (idx >= 0) {
					issues[idx] = {
						...issues[idx]!,
						githubNumber: ghIssue.number,
						updatedAt: new Date().toISOString(),
					};
					changed = true;
					pulled++;
					if (!jsonMode) printSuccess(`Linked: ${sdId} ↔ gh #${ghIssue.number}`);
				}
			} else {
				// Fallback: match by exact title
				const idx = issues.findIndex((i) => i.title === ghIssue.title && !i.githubNumber);
				if (idx >= 0) {
					issues[idx] = {
						...issues[idx]!,
						githubNumber: ghIssue.number,
						updatedAt: new Date().toISOString(),
					};
					changed = true;
					pulled++;
					if (!jsonMode)
						printSuccess(`Linked (by title): ${issues[idx]!.id} ↔ gh #${ghIssue.number}`);
				}
			}
		}

		for (const ghIssue of ghIssues) {
			const sdIssue = issues.find((i) => i.githubNumber === ghIssue.number);
			if (!sdIssue) continue;

			// Sync state: gh closed but sd open → close sd
			if (ghIssue.state === "CLOSED" && sdIssue.status !== "closed") {
				const idx = issues.findIndex((i) => i.id === sdIssue.id);
				if (idx >= 0) {
					issues[idx] = {
						...issues[idx]!,
						status: "closed",
						closedAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
						closeReason: "Closed on GitHub",
					};
					changed = true;
					pulled++;
					if (!jsonMode) printSuccess(`Synced close: ${sdIssue.id} (gh #${ghIssue.number})`);
				}
			}

			// Sync state: gh open but sd closed → reopen sd
			if (ghIssue.state === "OPEN" && sdIssue.status === "closed") {
				const idx = issues.findIndex((i) => i.id === sdIssue.id);
				if (idx >= 0) {
					issues[idx] = {
						...issues[idx]!,
						status: "open",
						closedAt: undefined,
						closeReason: undefined,
						updatedAt: new Date().toISOString(),
					};
					changed = true;
					pulled++;
					if (!jsonMode) printSuccess(`Synced reopen: ${sdIssue.id} (gh #${ghIssue.number})`);
				}
			}

			// Sync comments from GitHub → sd
			if (sdIssue.githubNumber) {
				const ghComments = await ghListComments(sdIssue.githubNumber, repo);
				const existingGhIds = new Set(
					(sdIssue.comments ?? []).filter((c) => c.githubId).map((c) => c.githubId),
				);
				// Also track existing comment bodies to detect duplicates from sd→gh→sd round-trip
				const existingBodies = new Set((sdIssue.comments ?? []).map((c) => c.body));

				for (const ghComment of ghComments) {
					if (existingGhIds.has(ghComment.id)) continue;

					// Skip if body matches an existing local comment (sd posted it → gh → sync back)
					// Strip **author:** prefix for matching
					const strippedBody = ghComment.body.replace(/^\*\*[^*]+:\*\*\s*/, "");
					if (existingBodies.has(ghComment.body) || existingBodies.has(strippedBody)) continue;

					const idx = issues.findIndex((i) => i.id === sdIssue.id);
					if (idx >= 0) {
						const existing = issues[idx]!;
						const comments = [
							...(existing.comments ?? []),
							{
								body: ghComment.body,
								author: ghComment.author,
								createdAt: ghComment.createdAt,
								githubId: ghComment.id,
							},
						];
						issues[idx] = { ...existing, comments, updatedAt: new Date().toISOString() };
						changed = true;
						pulled++;
					}
				}
			}
		}

		if (changed) {
			await writeIssues(dir, issues);
		}
	});

	return { pulled };
}

type PushResult = { pushed: number; failed: number; orphaned: number };

async function pushToGitHub(
	dir: string,
	jsonMode: boolean,
	dryRun: boolean,
): Promise<PushResult | null> {
	const config = await readConfig(dir);
	if (!config.github_enabled) return null;

	const initial = await readIssues(dir);
	const candidates = initial.filter((i) => i.status === "open" && !i.githubNumber);

	// DRY-RUN: report and return BEFORE any gh interaction (Design decision #4).
	// Always reachable when github_enabled, regardless of gh auth.
	if (dryRun) {
		if (!jsonMode) {
			for (const c of candidates) console.log(`Would push: ${c.id} — ${c.title}`);
		}
		return { pushed: candidates.length, failed: 0, orphaned: 0 };
	}

	// Live path: requires gh + repo. Both short-circuits return null (did not run).
	const { ghIsAvailable, detectGitHubRepo, ghCreate } = await import("../github.ts");
	if (!(await ghIsAvailable())) return null;
	const repo = config.github_repo ?? (await detectGitHubRepo(process.cwd()));
	if (!repo) return null;

	let pushed = 0;
	let failed = 0;
	let orphaned = 0;

	for (const candidate of candidates) {
		try {
			// Phase 1: network call OUTSIDE the lock. Do not hold lock across network call.
			const allIssues = await readIssues(dir);
			const ghNumber = await ghCreate(candidate, repo, allIssues);
			if (!ghNumber) {
				failed++;
				if (!jsonMode) printWarning(`Push failed: ${candidate.id}`);
				continue;
			}

			// Phase 2: writeback INSIDE the lock — re-check to defend concurrent push race.
			let wroteSuccessfully = false;
			let orphanedThisIteration = false;
			await withLock(issuesPath(dir), async () => {
				const issues = await readIssues(dir);
				const idx = issues.findIndex((i) => i.id === candidate.id);
				if (idx < 0) {
					orphanedThisIteration = true;
					return;
				}
				if (issues[idx]?.githubNumber) {
					orphanedThisIteration = true;
					if (!jsonMode)
						printWarning(
							`Race: ${candidate.id} already has gh #${issues[idx]?.githubNumber}; ` +
								`gh #${ghNumber} created by this process is now orphaned.`,
						);
					return;
				}
				issues[idx] = {
					...issues[idx]!,
					githubNumber: ghNumber,
					updatedAt: new Date().toISOString(),
				};
				await writeIssues(dir, issues);
				wroteSuccessfully = true;
			});

			if (wroteSuccessfully) {
				pushed++;
				if (!jsonMode) printSuccess(`Pushed: ${candidate.id} → gh #${ghNumber}`);
			} else if (orphanedThisIteration) {
				orphaned++;
			}
		} catch (err) {
			failed++;
			if (!jsonMode) printWarning(`Push error: ${candidate.id}: ${err}`);
		}
	}

	return { pushed, failed, orphaned };
}

export async function run(args: string[], seedsDir?: string): Promise<void> {
	const jsonMode = args.includes("--json");
	const statusOnly = args.includes("--status");
	const dryRun = args.includes("--dry-run");
	const push = args.includes("--push");

	const dir = seedsDir ?? (await findSeedsDir());
	const projectRoot = projectRootFromSeedsDir(dir);

	// GitHub sync: pull changes from GitHub first
	let ghPulled = 0;
	try {
		const result = await syncFromGitHub(dir, jsonMode);
		ghPulled = result.pulled;
	} catch {
		// Non-fatal: GitHub sync failure doesn't block local sync
	}

	// GitHub push: push local-only open issues to GitHub
	const effectiveDryRun = dryRun || statusOnly;
	const pushResult = push ? await pushToGitHub(dir, jsonMode, effectiveDryRun) : null;
	if (pushResult && pushResult.failed > 0) {
		process.exitCode = 1;
	}

	const pushKeys =
		pushResult !== null
			? {
					pushed: pushResult.pushed,
					pushFailed: pushResult.failed,
					pushOrphaned: pushResult.orphaned,
				}
			: {};

	// Worktree guard: skip commit when running from a worktree
	if (!seedsDir && isInsideWorktree(process.cwd())) {
		const msg = "Inside a git worktree — skipping commit. Issues are stored in the main repo.";
		if (jsonMode) {
			outputJson({
				success: true,
				command: "sync",
				committed: false,
				worktree: true,
				ghPulled,
				...pushKeys,
				message: msg,
			});
		} else {
			printWarning(msg);
		}
		return;
	}

	// Check if .suji/ is gitignored → skip git operations
	if (isSeedsIgnored(projectRoot)) {
		if (jsonMode) {
			outputJson({
				success: true,
				command: "sync",
				committed: false,
				gitignored: true,
				ghPulled,
				...pushKeys,
				message: ".suji/ is in .gitignore — skipping git commit",
			});
		} else {
			if (ghPulled > 0) {
				printSuccess(`Pulled ${ghPulled} change(s) from GitHub`);
			}
			console.log(".suji/ is gitignored — skipping git commit.");
		}
		return;
	}

	const statusResult = spawnSync(
		["git", "-C", projectRoot, "status", "--porcelain", `${SUJI_DIR_NAME}/`],
		projectRoot,
	);

	const changed = statusResult.stdout.trim();

	if (statusOnly) {
		if (jsonMode) {
			outputJson({
				success: true,
				command: "sync",
				hasChanges: !!changed,
				changes: changed,
				ghPulled,
				...pushKeys,
			});
		} else {
			if (ghPulled > 0) printSuccess(`Pulled ${ghPulled} change(s) from GitHub`);
			if (changed) {
				console.log("Uncommitted .suji/ changes:");
				console.log(changed);
			} else {
				console.log("No uncommitted .suji/ changes.");
			}
		}
		return;
	}

	if (!changed) {
		if (jsonMode) {
			outputJson({
				success: true,
				command: "sync",
				committed: false,
				ghPulled,
				...pushKeys,
				message: "Nothing to commit",
			});
		} else {
			if (ghPulled > 0) printSuccess(`Pulled ${ghPulled} change(s) from GitHub`);
			else console.log("No changes to commit.");
		}
		return;
	}

	if (dryRun) {
		const date = new Date().toISOString().slice(0, 10);
		const msg = `suji: sync ${date}`;
		if (jsonMode) {
			outputJson({
				success: true,
				command: "sync",
				dryRun: true,
				wouldCommit: true,
				ghPulled,
				...pushKeys,
				message: msg,
				changes: changed,
			});
		} else {
			if (ghPulled > 0) printSuccess(`Pulled ${ghPulled} change(s) from GitHub`);
			console.log("Dry run — would commit:");
			console.log(changed);
			console.log(`Commit message: ${msg}`);
		}
		return;
	}

	// Stage
	const addResult = spawnSync(["git", "-C", projectRoot, "add", `${SUJI_DIR_NAME}/`], projectRoot);
	if (addResult.exitCode !== 0) {
		throw new Error(`git add failed: ${addResult.stderr}`);
	}

	// Commit
	const date = new Date().toISOString().slice(0, 10);
	const msg = `suji: sync ${date}`;
	const commitResult = spawnSync(["git", "-C", projectRoot, "commit", "-m", msg], projectRoot);
	if (commitResult.exitCode !== 0) {
		throw new Error(`git commit failed: ${commitResult.stderr}`);
	}

	if (jsonMode) {
		outputJson({
			success: true,
			command: "sync",
			committed: true,
			ghPulled,
			...pushKeys,
			message: msg,
		});
	} else {
		if (ghPulled > 0) printSuccess(`Pulled ${ghPulled} change(s) from GitHub`);
		console.log(`Committed: ${msg}`);
	}
}

export function register(program: Command): void {
	program
		.command("sync")
		.description("Sync issues: pull from GitHub + stage/commit .suji/ changes")
		.option("--status", "Check status without committing")
		.option("--dry-run", "Show what would be committed without committing")
		.option("--push", "Also push local-only open issues to GitHub")
		.option("--json", "Output as JSON")
		.action(
			async (opts: { status?: boolean; dryRun?: boolean; push?: boolean; json?: boolean }) => {
				const args: string[] = [];
				if (opts.status) args.push("--status");
				if (opts.dryRun) args.push("--dry-run");
				if (opts.push) args.push("--push");
				if (opts.json) args.push("--json");
				await run(args);
			},
		);
}
