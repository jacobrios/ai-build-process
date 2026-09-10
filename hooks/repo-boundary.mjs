#!/usr/bin/env node
// ~/.claude/hooks/repo-boundary.mjs
//
// Keeps Claude's file changes inside the project it was actually asked to work in.
// Registered as a PreToolUse hook on Edit|Write|MultiEdit|NotebookEdit|Bash.
//
// WHAT THIS PROTECTS AGAINST
// Three things, all of which have happened or nearly happened:
//   1. Editing a file in a DIFFERENT project mid-session. Selecting a project in
//      the desktop app sets where Claude starts, not a boundary it cannot cross.
//   2. Committing or pushing in a different repo (`cd ../other && git commit`).
//   3. Deleting or moving files outside the project (`rm -rf ~/anything`).
//
// A rule in CLAUDE.md relies on the agent choosing to follow it. This does not:
// it runs before the tool does, and the tool never executes if it exits 2.
//
// THE ALLOWED AREA IS THE CURRENT PROJECT, NOT ALL OF ~/code
// This is the load-bearing choice. An earlier version allowed all of ~/code, which
// meant the exact cross-repo edit that motivated this hook would still have passed.
//
// THE ANCHOR IS THE SESSION'S PROJECT, NOT THE SHELL'S WANDERING CWD
// The boundary anchors to CLAUDE_PROJECT_DIR (the directory the session was opened
// in, which the harness sets for hook commands), falling back to the git root above
// the shell's cwd, and only then to the cwd itself. An earlier version anchored to
// the raw cwd, which was wrong in both directions at once: a shell cd'd into a
// subfolder shrank "the project" to that subfolder and blocked writes to the rest
// of the repo (found by a session blocked writing its own spec, 11 Aug 2026), and a
// persistent cd into a DIFFERENT repo moved the fence along with the shell, so the
// exact cross-repo edit this hook exists to stop was reachable in two tool calls.
// The shell's cwd still resolves relative paths; it just no longer defines the fence.
//
// HONEST LIMITS
//   - Shell text is parsed heuristically. It catches accidents, which are the real
//     risk. Deliberate obfuscation (variables, base64, eval) can get around it.
//   - Output redirection (`>`, `>>`, `tee`) IS parsed since 9 September 2026. It
//     was an accepted gap on the theory that macOS privacy settings backstopped it;
//     they gate Documents/Desktop/Downloads, not ~/code, so they did not. What made
//     it urgent: sessions are now steered to prefer Bash over the Write tool for
//     file changes, so the guarded path became the one agents avoid and the
//     unguarded one the path they use. A worktree session wrote into the main
//     checkout this way on 31 August 2026 and was only noticed when its cleanup
//     `rm` tripped the guard on the way out. Heredoc bodies are skipped unless a
//     shell receives them, so prose inside one is not mistaken for a command.
//   - A path built from a shell variable cannot be resolved, so it is allowed
//     rather than blocked. Blocking the unresolvable would break ordinary work.
//   - When CLAUDE_PROJECT_DIR is absent (a hook run outside the harness), the git
//     root above the cwd is the best available anchor. A shell that has already
//     wandered into another repo anchors there; only the env var can tell wandering
//     apart from a session genuinely opened in that repo.
//
// TO CHANGE WHAT IS ALLOWED, edit extraAllowedRoots() below.

import { execFileSync } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { homedir } from "node:os"

const HOME = homedir()

// The project the fence is drawn around. Preference order: the harness-provided
// session anchor, the git root enclosing the shell's cwd, the cwd itself.
function resolveProjectRoot(shellCwd) {
  const fromEnv = process.env.CLAUDE_PROJECT_DIR
  if (fromEnv && existsSync(fromEnv)) return realpathSync(fromEnv)

  let dir = existsSync(shellCwd) ? realpathSync(shellCwd) : resolve(shellCwd)
  while (dirname(dir) !== dir) {
    if (existsSync(join(dir, ".git"))) return dir
    dir = dirname(dir)
  }
  return existsSync(shellCwd) ? realpathSync(shellCwd) : resolve(shellCwd)
}

// Always writable, regardless of which project is open.
function extraAllowedRoots() {
  return [
    `${HOME}/.claude`, // standing rules, settings, memory files
    "/private/tmp/claude-501", // per-session scratchpad (/tmp/... resolves here on macOS)
    "/private/var/folders", // macOS per-user temp
  ]
}

// Commands that destroy or relocate files. Every path argument is checked, because
// `mv` removes its source: moving a tracked file out of the project is a destructive
// change to the project, not a gentler version of copying it.
const DESTRUCTIVE = new Set(["rm", "rmdir", "mv", "shred", "truncate"])

// Commands that duplicate files. Only the DESTINATION is checked: the source is
// merely read, and reading from outside into the project is allowed on purpose.
//
// Copying was unchecked until 20 Aug 2026, which left the sharpest hole in either
// guard. The read guard blocks secrets by spelling, so `cp .env /tmp/x` is refused
// while `cp -r . /tmp/whole` is not: the same secrets ride along inside a directory
// copy that never names them. /tmp is world-readable (drwxrwxrwt), so that copy is
// materially less protected than the original. It also made the fence arbitrary,
// with `mv` stopped and `cp` waved through for identical intent, which teaches an
// agent that rephrasing gets past a guard.
const COPYING = new Set(["cp", "rsync", "ditto"])

// git subcommands that always write, whatever flags follow.
//
// `fetch` is deliberately absent: it updates remote-tracking refs and touches neither
// the working tree nor any local branch, so in practice it is inspection.
const ALWAYS_MUTATING = new Set([
  "commit", "push", "add", "merge", "rebase", "reset", "checkout", "switch",
  "restore", "rm", "mv", "clean", "cherry-pick", "revert", "am", "apply",
  "init", "pull",
])

// Verbs that read or write depending on how they are called. Judging these by name
// alone was wrong in both directions: it blocked `git branch --contains` (a read-only
// query) while letting `git remote set-url` through (repointing another repo at a
// different remote, exactly what this hook exists to stop).
const WRITE_FLAGS = new Set([
  "-d", "-D", "-m", "-M", "-c", "-C", "-f", "-u",
  "--delete", "--move", "--copy", "--force",
  "--set-upstream-to", "--unset-upstream", "--edit-description",
])
const CONFIG_WRITE_FLAGS = new Set([
  "--unset", "--unset-all", "--add", "--replace-all",
  "--edit", "--rename-section", "--remove-section",
])
const REMOTE_WRITE_SUBCOMMANDS = new Set([
  "add", "remove", "rm", "rename", "set-url", "set-head", "set-branches", "prune",
])

// THE WORKTREE EXCEPTION (added 4 September 2026)
// A git worktree is a second working directory for the SAME repository, and this
// project puts them at `.claude/worktrees/<name>` inside the main checkout. The fence
// is drawn by path prefix, so from a worktree the main checkout reads as a different
// project and the merge-resync rule in CLAUDE.md ("pull main, delete the merged
// branch") could not run. Two conditions together, never one, let it through: the two
// directories share a repository, AND the verb is one of two chores.
//
// Deliberately NOT a blanket same-repo widening. `checkout`, `reset`, `clean` and the
// rest can move a live session's working tree, which is the 1 Sept 2026 incident that
// branch-cut-guard.mjs exists for. Each chore below is additionally safe because git
// itself refuses the destructive case: `--ff-only` cannot discard a commit, and `-d`
// cannot delete an unmerged branch.
//
// Worth knowing before extending this: the guard's cross-session protection was never
// symmetric. A session in the MAIN checkout can already `reset --hard` a worktree,
// because the worktree sits inside its root and passes the prefix test. That gap is
// older than this exception and is recorded in decisions/access-protections.md.
function isWorktreeChore(verb, args) {
  if (verb === "pull") return args.includes("--ff-only")
  if (verb === "branch") {
    const forced = args.some((a) => a === "-D" || a === "-f" || a === "--force")
    return !forced && args.some((a) => a === "-d" || a === "--delete")
  }
  return false
}

// Asked of git rather than inferred from paths, since a worktree can live anywhere.
// Only ever reached after the path check has already failed AND the verb is a chore,
// so the common path stays free of subprocesses. Any failure answers "no", so an
// unreadable or missing directory leaves the block standing.
function sameRepository(a, b) {
  const commonDir = (dir) => {
    const out = execFileSync("git", ["-C", dir, "rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    return realpathSync(resolve(dir, out))
  }
  try {
    return commonDir(a) === commonDir(b)
  } catch {
    return false
  }
}

// Returns true when this particular invocation writes. `args` excludes the verb itself.
function gitVerbWrites(verb, args) {
  if (ALWAYS_MUTATING.has(verb)) return true

  const positionals = args.filter((a) => !a.startsWith("-"))

  switch (verb) {
    // Listing is read-only; deleting, renaming and force-moving all carry a flag.
    // Accepted imprecision: bare `git branch <name>` (create a ref) passes, because
    // telling a new ref name from the value of --contains or --merged needs a
    // flag-value table, and creating a ref destroys nothing.
    case "branch":
    case "tag":
      return args.some((a) => WRITE_FLAGS.has(a))

    // `git stash list` and `git stash show` read; bare `git stash` shelves your work.
    case "stash":
      return !(positionals[0] === "list" || positionals[0] === "show")

    case "remote":
      return REMOTE_WRITE_SUBCOMMANDS.has(positionals[0])

    // `git config --get x` and `git config x` read. `git config x value` writes,
    // which is what a second positional argument means.
    case "config":
      return args.some((a) => CONFIG_WRITE_FLAGS.has(a)) || positionals.length >= 2

    default:
      return false
  }
}

// Prefixes to skip when identifying the real command (`sudo rm ...`).
const PREFIXES = new Set(["sudo", "command", "nohup", "time", "env", "xargs"])

function canonical(inputPath, baseDir) {
  const target = resolve(baseDir, inputPath.replace(/^~(?=\/|$)/, HOME))
  let probe = target
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe)
  try {
    const realProbe = realpathSync(probe)
    return target === probe ? realProbe : realProbe + target.slice(probe.length)
  } catch {
    return target
  }
}

function makeIsAllowed(roots) {
  const real = roots.map((r) => (existsSync(r) ? realpathSync(r) : resolve(r)))
  return (fullPath) => real.some((r) => fullPath === r || fullPath.startsWith(`${r}/`))
}

// Naive but adequate tokenizer: strips surrounding quotes, splits on whitespace.
function tokenize(segment) {
  return (segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []).map((t) =>
    t.replace(/^["']|["']$/g, "")
  )
}

// A token is unresolvable if it interpolates a variable or substitutes a command.
const isUnresolvable = (t) => /[$`*?]/.test(t)

// Paths written by `>`-style operators in one raw segment. Scanned on the text
// rather than the tokens because the tokenizer strips quotes, and quoting matters
// here in both directions: an operator INSIDE quotes is text (`echo "a>b"`), while
// a quoted TARGET after a real operator is still a write (`> "/other/x.md"`), and
// the first version of this check could not tell them apart. The operator may
// stand alone (`> file`), lead a word (`>file`, `2>file`, `&>file`) or sit inside
// one (`x>file`). `&1`/`&2` targets are file descriptors. Input redirection (`<`,
// heredocs) reads and is ignored.
function redirectionTargets(segment) {
  const out = []
  const n = segment.length
  let i = 0
  let quote = null
  while (i < n) {
    const c = segment[i]
    if (c === "\\") { i += 2; continue }
    if (quote) { if (c === quote) quote = null; i++; continue }
    if (c === '"' || c === "'") { quote = c; i++; continue }
    if (c !== ">") { i++; continue }
    let j = i + 1
    if (segment[j] === ">") j++
    if (segment[j] === "|") j++
    while (j < n && /\s/.test(segment[j])) j++
    if (segment[j] === "&") { i = j + 1; continue }
    let target = ""
    if (segment[j] === '"' || segment[j] === "'") {
      const q = segment[j++]
      while (j < n && segment[j] !== q) target += segment[j++]
      j++
    } else {
      while (j < n && !/\s/.test(segment[j])) target += segment[j++]
    }
    if (target) out.push(target)
    i = j
  }
  return out
}

// A heredoc body is data, not commands, unless the command receiving it is a
// shell: `cat > x <<EOF` writes the body, `bash <<EOF` runs it. Bodies fed to
// anything else are dropped before scanning, since a documentation line inside
// one that happens to read `> ~/x` is prose. The line that opens the heredoc is
// kept, so its own redirection target is still checked. Added 9 September 2026,
// after the redirection check blocked its own lineage entry for exactly this.
const SHELLS = new Set(["bash", "sh", "zsh", "ksh", "dash", "eval", "source", "."])
function dropHeredocBodies(command) {
  const lines = command.split("\n")
  const kept = []
  let terminator = null
  let keepBody = false
  for (const line of lines) {
    if (terminator !== null) {
      if (line.trim() === terminator) { terminator = null; continue }
      if (keepBody) kept.push(line)
      continue
    }
    kept.push(line)
    const m = line.match(/<<-?\s*(['"]?)(\w+)\1/)
    if (!m) continue
    terminator = m[2]
    const words = tokenize(line.trim())
    let k = 0
    while (k < words.length && PREFIXES.has(words[k])) k++
    keepBody = SHELLS.has(words[k])
  }
  return kept.join("\n")
}

function checkBashCommand(command, cwd, isAllowed, projectDir) {
  // Split on shell separators, preserving order so `cd X && git commit` is understood.
  const segments = dropHeredocBodies(command).split(/(?:&&|\|\||;|\||\n)/)
  let currentDir = cwd

  for (const segment of segments) {
    const tokens = tokenize(segment.trim())
    if (!tokens.length) continue

    let i = 0
    while (i < tokens.length && PREFIXES.has(tokens[i])) i++
    const cmd = tokens[i]
    const args = tokens.slice(i + 1)
    if (!cmd) continue

    // `cd somewhere` moves the working directory for later segments in this chain.
    if (cmd === "cd") {
      const dest = args.find((a) => !a.startsWith("-"))
      if (dest && !isUnresolvable(dest)) currentDir = canonical(dest, currentDir)
      continue
    }

    if (cmd === "git") {
      // `git -C <path> <verb>` operates on another directory entirely.
      // Strip `-C <path>` first, both to find which repo is being targeted and so the
      // verb and its own arguments can be read cleanly. Note -C is consumed WITH its
      // value: an earlier version mistook the value for the verb, which let
      // `cd other && git commit` through, the exact case this hook exists to catch.
      let gitDir = currentDir
      const rest = []
      for (let j = 0; j < args.length; j++) {
        if (args[j] === "-C") {
          const value = args[j + 1]
          if (value && !isUnresolvable(value)) gitDir = canonical(value, currentDir)
          j++ // skip the value
          continue
        }
        rest.push(args[j])
      }

      const verbIndex = rest.findIndex((a) => !a.startsWith("-"))
      const verb = verbIndex === -1 ? null : rest[verbIndex]
      const verbArgs = verbIndex === -1 ? [] : rest.slice(verbIndex + 1)

      if (verb && gitVerbWrites(verb, verbArgs) && !isAllowed(gitDir)) {
        const chore = isWorktreeChore(verb, verbArgs) && sameRepository(gitDir, projectDir)
        if (!chore) {
          return { path: gitDir, why: `\`git ${verb}\` would write to a repository outside this project` }
        }
      }
      continue
    }

    // Output redirection and tee write a file just as surely as `cp` does. The
    // operator may stand alone (`> file`) or be attached (`>file`, `2>file`,
    // `&>file`). `&1`/`&2` targets are file descriptors and /dev/* is not a file
    // anyone keeps; both are skipped. Variable-built targets stay allowed, as every
    // unresolvable path in this hook does.
    const redirected = redirectionTargets(segment)
    for (const target of redirected) {
      if (isUnresolvable(target)) continue
      const full = canonical(target, currentDir)
      if (full.startsWith("/dev/")) continue
      if (!isAllowed(full)) {
        return { path: full, why: "output redirection would write a file outside this project" }
      }
    }
    if (cmd === "tee") {
      for (const arg of args) {
        if (arg.startsWith("-") || isUnresolvable(arg)) continue
        const full = canonical(arg, currentDir)
        if (!isAllowed(full)) {
          return { path: full, why: "`tee` would write a file outside this project" }
        }
      }
    }

    if (DESTRUCTIVE.has(cmd)) {
      for (const arg of args) {
        if (arg.startsWith("-") || isUnresolvable(arg)) continue
        const full = canonical(arg, currentDir)
        if (!isAllowed(full)) {
          return { path: full, why: `\`${cmd}\` would modify or remove a file outside this project` }
        }
      }
    }

    if (COPYING.has(cmd)) {
      // The last positional argument is the destination, which is the only one that
      // gets written. Anything before it is a source and may legitimately sit outside
      // the project. A single positional is a malformed command; leave it alone.
      const positionals = args.filter((a) => !a.startsWith("-"))
      const destination = positionals.at(-1)
      if (positionals.length >= 2 && destination && !isUnresolvable(destination)) {
        const full = canonical(destination, currentDir)
        if (!isAllowed(full)) {
          return { path: full, why: `\`${cmd}\` would copy files to a destination outside this project` }
        }
      }
    }
  }
  return null
}

let input = ""
process.stdin.on("data", (chunk) => (input += chunk))
process.stdin.on("end", () => {
  let data = {}
  try {
    data = JSON.parse(input)
  } catch {
    process.exit(0) // unparseable input is not the agent's fault; do not block
  }

  const toolInput = data.tool_input || {}
  // Two distinct directories, deliberately: the fence is drawn around the project,
  // while relative paths and `cd` tracking resolve against the shell's actual cwd.
  const shellCwd = data.cwd || process.cwd()
  const projectDir = resolveProjectRoot(shellCwd)
  const roots = [projectDir, ...extraAllowedRoots()]
  const isAllowed = makeIsAllowed(roots)

  // Three subagents in one session reached for /tmp instead of the scratchpad their
  // own system prompt named (b1-coach, 20 Aug 2026). The guard caught all three, but
  // catching is downstream of the cause. Naming the alternative at the moment of the
  // block is the cheap fix, the same one that worked for db:which on the read guard.
  const scratchpadHint = (path) =>
    /^\/(private\/)?tmp\//.test(path) && !path.startsWith("/private/tmp/claude-501/")
      ? `\nFor a scratch file, use THIS session's scratchpad directory, named in your ` +
        `system prompt under /private/tmp/claude-501/. Not /tmp: that is shared with ` +
        `every app on the machine and is world-readable.`
      : ""

  const deny = (path, why) => {
    console.error(
      `Blocked by a Jacob-built guard (repo-boundary, tunable): ${why}.${scratchpadHint(path)}\n` +
        `  Target:  ${path}\n` +
        `  Project: ${projectDir}\n` +
        `Claude may only change files in the project it was opened in. If this is ` +
        `genuinely wanted, ask Jacob first and name the target by its folder name. ` +
        `He can make the change himself, open a session in that project, or widen ` +
        `the roots in ~/.claude/hooks/repo-boundary.mjs.`
    )
    process.exit(2)
  }

  if (data.tool_name === "Bash" || typeof toolInput.command === "string") {
    const hit = checkBashCommand(toolInput.command || "", shellCwd, isAllowed, projectDir)
    if (hit) deny(hit.path, hit.why)
    process.exit(0)
  }

  const rawPath = ["file_path", "notebook_path"]
    .map((k) => toolInput[k])
    .find((v) => typeof v === "string" && v.length)
  if (!rawPath) process.exit(0)

  const full = canonical(rawPath, shellCwd)
  if (!isAllowed(full)) deny(full, "this edit is outside the current project")

  process.exit(0)
})
