# Suji

Forked from jayminwest/seeds under MIT License.

Git-native issue tracker for AI agent workflows.

[![npm](https://img.shields.io/npm/v/@hana/suji-cli)](https://www.npmjs.com/package/@hana/suji-cli)
[![CI](https://github.com/jayminwest/seeds/actions/workflows/ci.yml/badge.svg)](https://github.com/jayminwest/seeds/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Replaces [beads](https://github.com/steveyegge/beads) in the [overstory](https://github.com/jayminwest/overstory)/[mulch](https://github.com/jayminwest/mulch) ecosystem. No Dolt, no daemon, no binary DB files. **The JSONL file IS the database.**

## Install

```bash
bun install -g @hana/suji-cli
```

Or try without installing:

```bash
npx @hana/suji-cli --help
```

### Development

```bash
git clone https://github.com/jayminwest/seeds
cd suji
bun install
bun link              # Makes 'su' available globally

bun test              # Run all tests
bun run lint          # Biome check
bun run typecheck     # tsc --noEmit
```

## Quick Start

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

Every command supports `--json` for structured output. Global flags: `-v`/`--version`, `-q`/`--quiet`, `--verbose`, `--timing`. ANSI colors respect `NO_COLOR`.

### Issue Commands

| Command | Description |
|---------|-------------|
| `su init` | Initialize `.suji/` in current directory |
| `su create --title <text>` | Create a new issue (`--type`, `--priority`, `--description`, `--assignee`) |
| `su show <id>` | Show issue details |
| `su list` | List issues with filters (`--status`, `--type`, `--assignee`, `--label`, `--limit`, `--all`) |
| `su ready` | Open issues with no unresolved blockers |
| `su update <id>` | Update issue fields (`--status`, `--title`, `--priority`, `--assignee`, `--description`) |
| `su close <id> [<id2> ...]` | Close one or more issues (`--reason`) |
| `su dep add <issue> <depends-on>` | Add dependency |
| `su dep remove <issue> <depends-on>` | Remove dependency |
| `su dep list <issue>` | Show deps for an issue |
| `su block <id> --by <blocker-id>` | Mark issue as blocked by another |
| `su unblock <id> --from <blocker-id>` | Remove a blocker (`--all` to clear all) |
| `su blocked` | Show all blocked issues |
| `su label add <id> <label>` | Add a label to an issue |
| `su label remove <id> <label>` | Remove a label from an issue |
| `su label list <id>` | List labels on an issue |
| `su label list-all` | List all labels across issues |
| `su stats` | Project statistics |
| `su sync` | Stage and commit `.suji/` changes (`--status`, `--dry-run`) |

### Template Commands

| Command | Description |
|---------|-------------|
| `su tpl create --name <text>` | Create a template |
| `su tpl step add <id> --title <text>` | Add step (supports `{prefix}` interpolation) |
| `su tpl list` | List all templates |
| `su tpl show <id>` | Show template with steps |
| `su tpl pour <id> --prefix <text>` | Instantiate template into issues |
| `su tpl status <id>` | Show convoy completion status |

### Health

| Command | Description |
|---------|-------------|
| `su doctor` | Check project health and data integrity (`--fix`) |

### Agent Integration

| Command | Description |
|---------|-------------|
| `su prime` | Output AI agent context (`--compact`) |
| `su onboard` | Add suji section to CLAUDE.md / AGENTS.md |

### Utility

| Command | Description |
|---------|-------------|
| `su upgrade` | Upgrade suji to latest version from npm (`--check`) |
| `su completions <shell>` | Output shell completion script (bash, zsh, fish) |
| `su migrate-from-beads` | Import `.beads/issues.jsonl` into `.suji/` |

## Architecture

Suji stores all data in JSONL files inside a `.suji/` directory — one JSON object per line, fully diffable and mergeable via git. Advisory file locks (`O_CREAT | O_EXCL`) and atomic writes (temp file + rename) ensure safe concurrent access from multiple agents. The `merge=union` gitattribute handles parallel branch merges; dedup-on-read (last occurrence wins) resolves any duplicates. See [CLAUDE.md](CLAUDE.md) for full technical details.

## Why

Beads works but carries baggage overstory doesn't need:

| Problem | Beads | Suji |
|---------|-------|-------|
| Storage | 2.8MB binary `beads.db` (can't diff/merge) | JSONL (diffable, mergeable) |
| Sync | 286 export-state tracking files | No sync — file IS the DB |
| Concurrency | `beads.db` lock contention | Advisory locks + atomic writes |
| Dependencies | Dolt embedded | chalk + commander |

## Priority Scale

| Value | Label    | Use |
|-------|----------|-----|
| 0     | Critical | System-breaking, drop everything |
| 1     | High     | Core functionality |
| 2     | Medium   | Default — important but not urgent |
| 3     | Low      | Nice-to-have |
| 4     | Backlog  | Future consideration |

## On-Disk Format

```
.suji/
  config.yaml          # Project config: project name, version
  issues.jsonl         # All issues, one JSON object per line
  templates.jsonl      # Template definitions
  .gitignore           # Ignores *.lock files
```

Add to your `.gitattributes` (done automatically by `su init`):

```
.suji/issues.jsonl merge=union
.suji/templates.jsonl merge=union
```

The `merge=union` strategy handles parallel agent branch merges. Suji deduplicates by ID on read (last occurrence wins), so conflicts resolve automatically.

## JSON Output

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

- **Advisory file locks** — `O_CREAT | O_EXCL`, 30s stale threshold, 100ms retry with jitter, 30s timeout
- **Atomic writes** — temp file + rename under lock
- **Dedup on read** — last occurrence wins after `merge=union` git merges

## Integration with Overstory

Overstory wraps `su` via `Bun.spawn(["su", ...])` with `--json` parsing, identical to how it wraps `bd`:

| BeadsClient method | su command |
|--------------------|------------|
| `ready()` | `su ready --json` |
| `show(id)` | `su show <id> --json` |
| `create(title, opts)` | `su create --title "..." --json` |
| `claim(id)` | `su update <id> --status=in_progress --json` |
| `close(id, reason)` | `su close <id> --reason "..." --json` |

## Part of os-eco

Suji is part of the [os-eco](https://github.com/jayminwest/os-eco) AI agent tooling ecosystem.

<p align="center">
  <img src="https://raw.githubusercontent.com/jayminwest/os-eco/main/branding/logo.png" alt="os-eco" width="444" />
</p>

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT
