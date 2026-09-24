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

// THE LINKED WORKTREE THE SESSION ACTUALLY STANDS IN (added 23 September 2026)
// An Agent spawned with worktree isolation got its own linked worktree as its real
// cwd, but the harness set CLAUDE_PROJECT_DIR to the PARENT session's worktree, a
// sibling directory of the same repository. The anchor above stayed put by design, so
// every write in the agent's own worktree was denied. This widens the fence to also
// cover the worktree the hook input's cwd is actually standing in, when it can be
// shown to be a linked worktree of the same repository as the anchor.
//
// Why the main checkout is excluded: the main checkout is itself a worktree of the
// same repository, so a same-repository rule with no further condition would let any
// worktree session `cd` into it and act as if it owned it. On 4 September only
// `pull --ff-only` and `branch -d` were opened from a worktree against the main
// checkout, with checkout, switch, reset, restore, clean, stash, rebase and merge
// deliberately kept blocked, because the 1 September incident (branch-cut-guard.mjs)
// was exactly a `cd` into the main checkout sweeping another session's 32 unmerged
// commits into a branch (PR #112). Allowing the main checkout outright here would
// reopen that with one `cd`, so only a LINKED worktree (its git dir lives inside
// `.git/worktrees/<name>`, not the repository's common dir itself) qualifies.
//
// Why this does not reintroduce the cwd-anchoring bugs fixed 11 Aug 2026 (fa5d797):
// the anchor computed above never moves, so a subfolder `cd` still cannot shrink the
// fence. And the extra root is only added when its git COMMON dir matches the
// anchor's, so a `cd` into an unrelated repository cannot move the fence there either;
// this is additive; it never replaces the anchor with the cwd's own root. The accepted
// residual: a deliberate `cd` into another live session's linked worktree of the SAME
// repository makes that worktree writable from here too.
//
// Nearest ancestor-or-self of `dir` with a `.git` entry (a directory for the main
// checkout, a file for a linked worktree). Independent of resolveProjectRoot: that
// one prefers CLAUDE_PROJECT_DIR and only falls back to a git walk; this always
// walks, because it answers "what worktree does this cwd stand in", not "what is
// the session's anchor".
function worktreeRootContaining(dir) {
  let probe = existsSync(dir) ? realpathSync(dir) : resolve(dir)
  for (;;) {
    if (existsSync(join(probe, ".git"))) return probe
    const parent = dirname(probe)
    if (parent === probe) return null
    probe = parent
  }
}

// Git environment variables that override which repository a `-C <dir>` call
// actually answers for. If the hook's own process inherited one of these (a
// session started with GIT_DIR set, for instance), every directory asked about
// would report the SAME repository, the one named by the env var, regardless of
// which directory `-C` points at. That breaks the one thing this exception is
// built on: telling "the same repository as the anchor" apart from "a different
// one". Found in review 23 September 2026, with three confirmed cases where an
// inherited GIT_DIR made the main checkout, and an unrelated repository, both
// answer as the anchor's own repository and become writable. Both git calls in
// this file run with these scrubbed, never with the hook's raw environment.
const GIT_ENV_OVERRIDES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_CEILING_DIRECTORIES",
]
function scrubbedGitEnv() {
  const env = { ...process.env }
  for (const key of GIT_ENV_OVERRIDES) delete env[key]
  return env
}

// A directory's git dir and common dir, both absolute and realpath'd. Any failure,
// including "not a git repository" or git being unavailable, answers null. Callers
// treat null as "add nothing": this exception is opt-in evidence, never opt-out.
function gitDirs(dir) {
  try {
    const out = execFileSync(
      "git",
      ["-C", dir, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
      { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"], env: scrubbedGitEnv() }
    )
      .trim()
      .split("\n")
    if (out.length !== 2 || !out[0] || !out[1]) return null
    return { gitDir: realpathSync(out[0]), commonDir: realpathSync(out[1]) }
  } catch {
    return null
  }
}

// The one extra root this exception can add, or null. `baseIsAllowed` must be built
// from the anchor and the standing extra roots WITHOUT this one, so "already inside
// an allowed root" cannot see its own answer.
function linkedWorktreeRoot(shellCwd, projectDir, baseIsAllowed) {
  const wtRoot = worktreeRootContaining(shellCwd)
  if (!wtRoot || wtRoot === projectDir || baseIsAllowed(wtRoot)) return null

  const wt = gitDirs(wtRoot)
  const anchor = gitDirs(projectDir)
  if (!wt || !anchor) return null
  if (wt.commonDir !== anchor.commonDir) return null // a different repository
  if (wt.gitDir === wt.commonDir) return null // the main checkout, not linked

  return wtRoot
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

// Commands that create a link. Only the LINK PATH is checked, the same as a copy
// destination: creating the link is the write, and what it points at is merely read
// through later. `ln`'s flags that take a value are `-t`/`--target-directory` (the
// write destination) and `-S`/`--suffix` (a backup suffix, irrelevant to the
// destination but still not a positional). A combined short form with only
// boolean flags, like `-sf`, is still all flags, never a positional.
//
// FIX (23 Sept 2026, review round 2): the comment used to say `-t` was the only
// flag taking a value, which missed `-S`/`--suffix`, and the parser only recognized
// `-t` standing alone, which missed the combined cluster form (`-st DIR`) and the
// attached form (`-tDIR`). `ln -st /outside a b` and `ln -t/outside a b` were both
// allowed. macOS's own `ln` does not support these GNU forms; the fix is parse-only.
//
// DECLINED GAP (23 Sept 2026, same family as the 20 Aug cp finding): a link made
// INSIDE the project can point OUTSIDE it at a secret, e.g.
// `ln -s ~/.aws/credentials ./notes.txt`. A later read of that innocent-looking
// name is judged by sensitive-read-guard.mjs on its own spelling, and its spelling
// gives no hint of the secret behind it. Declined because setting this up takes
// deliberate intent, and these guards exist to catch accidents, not to stop someone
// determined to exfiltrate a secret on purpose.
const LINKING = new Set(["ln"])

// The path `ln` writes to. With two or more positional (non-flag) arguments, the
// last one is where the link is created; the ones before it are read, not written.
// With exactly one positional, `ln` creates the link in the current directory under
// the source's own basename, so the directory itself is what gets checked. A
// `-t DIR` / `--target-directory=DIR` / `--target-directory DIR` overrides both and
// names the directory directly. No positionals (a malformed invocation) checks
// nothing, same as a malformed `cp`.
//
// FIX (24 Sept 2026, review round 1): the space-separated GNU long form
// (`--target-directory DIR`, no `=`) was not recognized, so `DIR` fell through as an
// ordinary positional and the real destination was never checked. Reviewer verified
// `ln --target-directory /outside a b` and `ln -s --target-directory /outside a b`
// were both allowed from inside the project. `--target-directory` now consumes the
// next argument exactly as `-t` does.
//
// FIX (23 Sept 2026, review round 2, part 1): `-t` or `--target-directory` with NO
// following argument left `targetDir` as `undefined`, which later crashed the hook
// (`undefined.replace` inside `canonical`). A crashing hook exits 1, and only exit 2
// blocks, so the crash did not just fail to check the destination, it let the WHOLE
// REST OF THE LINE through unchecked. Confirmed: `ln -t; rm -rf <outside>` exited 1
// and the `rm` went unguarded. A missing value now means no target directory, the
// same as if the flag had not been given, rather than a value that crashes later.
//
// FIX (23 Sept 2026, review round 2, part 2): the combined short-flag cluster
// (`-st DIR`) and the attached short form (`-tDIR`) were not recognized, so their
// value fell through as an ordinary positional argument and the real destination
// went unchecked (`ln -st /outside a b` was allowed). `-S`/`--suffix` is now also
// recognized as consuming a value, so it cannot be mistaken for a positional either.
function lnDestination(args) {
  let targetDir = null
  const positionals = []
  for (let j = 0; j < args.length; j++) {
    const a = args[j]

    if (a === "-t" || a === "--target-directory") {
      const value = args[j + 1] ?? null
      if (value !== null) targetDir = value
      j++
      continue
    }
    if (a.startsWith("--target-directory=")) {
      targetDir = a.slice("--target-directory=".length)
      continue
    }
    if (a === "-S" || a === "--suffix") { j++; continue } // consumes a value; not a destination
    if (a.startsWith("--suffix=")) continue

    // A SINGLE-DASH short flag or a combined short cluster (`-s`, `-sf`, `-st DIR`,
    // `-tDIR`). `t` and `S` are the only letters that take a value; whatever
    // follows that letter in the SAME token is its value, or, if nothing follows,
    // the next token is. Any letter after that in the cluster would be the
    // value's text, never a further flag, which is why the scan stops there.
    //
    // FIX (23 Sept 2026, review round 3): this used to match ANY token starting
    // with `-`, long options included, so a long flag merely containing a "t" was
    // misread as `-t` plus a value. `ln --interactive a b` read "eractive" as the
    // target directory and never checked `b`, the real destination; the same
    // happened for `--no-target-directory` and `--backup=existing` (an "S"). Long
    // options are handled above by name (`--target-directory[=]`, `--suffix[=]`);
    // every other long option is a plain flag that consumes nothing, which is
    // exactly what falls through to the plain-flag branch below now that this one
    // only matches a single leading dash.
    if (a.startsWith("-") && !a.startsWith("--") && a !== "-") {
      const letters = a.slice(1)
      for (let k = 0; k < letters.length; k++) {
        const letter = letters[k]
        if (letter !== "t" && letter !== "S") continue
        const attached = letters.slice(k + 1)
        const value = attached !== "" ? attached : args[j + 1] ?? null
        if (attached === "") j++
        if (letter === "t" && value !== null) targetDir = value
        break
      }
      continue
    }

    // Any other flag, long or short, that reaches here consumes nothing: a plain
    // switch like `--interactive`, `-v`, or an unrecognized long option.
    if (a.startsWith("-")) continue

    positionals.push(a)
  }
  if (targetDir !== null) return targetDir
  if (positionals.length >= 2) return positionals.at(-1)
  if (positionals.length === 1) return "."
  return null
}

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
      env: scrubbedGitEnv(),
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

// Splits a command line at `&&`, `||`, `;`, `|` and newlines, but only where those
// characters are shell syntax. Inside single or double quotes they are text: a sed
// script like `'s|a|b|'` or a jq filter like `'.x | select(.n > 3)'` is one argument.
// The first version split on the raw string, which cut quoted arguments in half and
// was wrong in both directions at once (16 September 2026): a `>` inside a quoted
// sed regex was reported as a write to a nonsense path, and a real `> ~/file` after
// a quoted `|` was read as quoted and let through. `>|` (force-overwrite) is one
// operator, not a pipe, so it does not split either.
function splitOutsideQuotes(command) {
  const out = []
  let cur = ""
  let quote = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote) {
      cur += c
      if (c === "\\" && quote === '"' && i + 1 < command.length) cur += command[++i]
      else if (c === quote) quote = null
      continue
    }
    if (c === "\\" && i + 1 < command.length) { cur += c + command[++i]; continue }
    if (c === "'" || c === '"') { quote = c; cur += c; continue }
    const two = command.slice(i, i + 2)
    if (two === "&&" || two === "||") { out.push(cur); cur = ""; i++; continue }
    if (c === ";" || c === "\n" || (c === "|" && command[i - 1] !== ">")) { out.push(cur); cur = ""; continue }
    cur += c
  }
  out.push(cur)
  return out
}

function checkBashCommand(command, cwd, isAllowed, projectDir) {
  // Split on shell separators, preserving order so `cd X && git commit` is understood.
  const segments = splitOutsideQuotes(dropHeredocBodies(command))
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

    if (LINKING.has(cmd)) {
      const destination = lnDestination(args)
      if (destination !== null && !isUnresolvable(destination)) {
        const full = canonical(destination, currentDir)
        if (!isAllowed(full)) {
          return { path: full, why: `\`${cmd}\` would create a link outside this project` }
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
  const baseRoots = [projectDir, ...extraAllowedRoots()]
  const baseIsAllowed = makeIsAllowed(baseRoots)
  const extraRoot = linkedWorktreeRoot(shellCwd, projectDir, baseIsAllowed)
  const roots = extraRoot ? [...baseRoots, extraRoot] : baseRoots
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
