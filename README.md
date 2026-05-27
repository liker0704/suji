# Suji

> 筋 — thread. Git-native issue tracker for AI agent workflows.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

JSONL storage, Bun runtime, zero binary databases. **The JSONL file IS the
database** — no Dolt, no daemon, no export pipeline.

## Install

```bash
bun install -g @hana/suji-cli
```

### Development

```bash
git clone https://github.com/liker0704/suji
cd suji
bun install
bun link
bun test
```

## Quick start

```bash
# Initialize in your project
su init

# Create an issue
su create --title "Add retry logic to mail client" --type task --priority 1

# List open issues
su list

# Find work (open, unblocked)
su ready

# Claim and complete
su update suji-a1b2 --status in_progress
su close suji-a1b2 --reason "Implemented with exponential backoff"

# Commit .suji/ changes to git
su sync
```

## Commands

Every command supports `--json` for structured output. Global flags:
`-v`/`--version`, `-q`/`--quiet`, `--verbose`, `--timing`. ANSI colors respect
`NO_COLOR`.

### Issues

| Command | Description |
|---------|-------------|
| `su init` | Initialize `.suji/` in current directory |
| `su create --title <text>` | Create a new issue (`--type`, `--priority`, `--description`, `--assignee`) |
| `su show <id>` | Show issue details |
| `su list` | List issues with filters (`--status`, `--type`, `--assignee`, `--label`, `--limit`, `--all`) |
| `su ready` | Open issues with no unresolved blockers |
| `su update <id>` | Update issue fields |
| `su close <id> [<id2> ...]` | Close one or more issues (`--reason`) |
| `su dep add\|remove\|list <issue> <depends-on>` | Manage dependencies |
| `su block <id> --by <blocker-id>` | Mark issue as blocked |
| `su unblock <id> --from <blocker-id>` | Remove a blocker (`--all` to clear) |
| `su blocked` | Show all blocked issues |
| `su label add\|remove\|list <id> <label>` | Manage labels |
| `su label list-all` | List all labels across issues |
| `su stats` | Project statistics |
| `su sync` | Stage and commit `.suji/` changes (`--status`, `--dry-run`, `--push`) |

`su sync --push` pushes open local-only issues (no `githubNumber`) to GitHub,
writes back the assigned issue number, then stages and commits everything in
one pass. `--push --dry-run` lists candidates without acting.

### Templates

| Command | Description |
|---------|-------------|
| `su tpl create --name <text>` | Create a template |
| `su tpl step add <id> --title <text>` | Add a step (supports `{prefix}` interpolation) |
| `su tpl list` | List templates |
| `su tpl show <id>` | Show template with steps |
| `su tpl pour <id> --prefix <text>` | Instantiate template into issues |
| `su tpl status <id>` | Show convoy completion status |

### Health & agent integration

| Command | Description |
|---------|-------------|
| `su doctor` | Check project health and data integrity (`--fix`) |
| `su prime` | Output AI agent context (`--compact`) |
| `su onboard` | Add suji section to CLAUDE.md / AGENTS.md |

### Utility

| Command | Description |
|---------|-------------|
| `su upgrade` | Upgrade suji to latest version from npm (`--check`) |
| `su completions <shell>` | Output shell completion script (bash, zsh, fish) |
| `su migrate-from-beads` | Import `.beads/issues.jsonl` into `.suji/` |

## Architecture

Suji stores all data in JSONL files inside a `.suji/` directory — one JSON
object per line, fully diffable and mergeable via git. Advisory file locks
(`O_CREAT | O_EXCL`) and atomic writes (temp file + rename) ensure safe
concurrent access from multiple agents. The `merge=union` gitattribute handles
parallel branch merges; dedup-on-read (last occurrence wins) resolves any
duplicates.

See [CLAUDE.md](CLAUDE.md) for full technical details.

## Why not beads

[Beads](https://github.com/steveyegge/beads) works, but for agent workflows it
carries baggage:

| Problem | Beads | Suji |
|---------|-------|------|
| Storage | 2.8MB binary `beads.db` (can't diff/merge) | JSONL (diffable, mergeable) |
| Sync | 286 export-state tracking files | No sync — file IS the DB |
| Concurrency | `beads.db` lock contention | Advisory locks + atomic writes |
| Dependencies | Dolt embedded | chalk + commander |

## Priority scale

| Value | Label    | Use |
|-------|----------|-----|
| 0     | Critical | System-breaking, drop everything |
| 1     | High     | Core functionality |
| 2     | Medium   | Default — important but not urgent |
| 3     | Low      | Nice-to-have |
| 4     | Backlog  | Future consideration |

## On-disk format

```
.suji/
  config.yaml          # Project config: project name, version
  issues.jsonl         # All issues, one JSON object per line
  templates.jsonl      # Template definitions
  .gitignore           # Ignores *.lock files
```

Add to your `.gitattributes` (done automatically by `su init`):

```
.suji/issues.jsonl    merge=union
.suji/templates.jsonl merge=union
```

`merge=union` handles parallel agent branch merges. Suji deduplicates by ID on
read (last occurrence wins), so conflicts resolve automatically.

## JSON output

Success:
```json
{ "success": true, "command": "create", "id": "myproject-a1b2" }
```

Error:
```json
{ "success": false, "command": "create", "error": "Title is required" }
```

## Concurrency

Suji is safe for concurrent multi-agent use:

- **Advisory file locks** — `O_CREAT | O_EXCL`, 30s stale threshold, 100ms
  retry with jitter, 30s timeout
- **Atomic writes** — temp file + rename under lock
- **Dedup on read** — last occurrence wins after `merge=union` git merges

## Integration with Haru

Haru wraps `su` via `Bun.spawn(["su", ...])` with `--json` parsing:

| Method | Suji command |
|--------|--------------|
| `ready()` | `su ready --json` |
| `show(id)` | `su show <id> --json` |
| `create(title, opts)` | `su create --title "..." --json` |
| `claim(id)` | `su update <id> --status=in_progress --json` |
| `close(id, reason)` | `su close <id> --reason "..." --json` |

## Part of Hana

Suji is part of the [Hana](https://github.com/liker0704/hana) ecosystem:

- [Haru](https://github.com/liker0704/haru) — orchestration
- [Kura](https://github.com/liker0704/kura) — structured expertise
- [Suji](https://github.com/liker0704/suji) — issue tracking
- [Tane](https://github.com/liker0704/tane) — prompt management

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT

---

Maintained by [Kyryl Zmiienko](https://www.linkedin.com/in/kyryl-zmiienko/).

Part of a personal ecosystem alongside [Haru](https://github.com/liker0704/haru),
[Kura](https://github.com/liker0704/kura), and
[Tane](https://github.com/liker0704/tane). Diverged significantly from upstream.
