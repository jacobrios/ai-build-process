#!/usr/bin/env node
// ~/.claude/hooks/sensitive-read-guard.mjs
//
// Blocks Claude from READING two categories of thing that project work never needs:
//   1. Secrets: .env files, SSH keys, cloud credentials, certificates.
//   2. Personal folders: Documents, Desktop, Downloads, Pictures, Movies, Music.
//
// Registered as a PreToolUse hook on Bash|Read|Grep|Glob.
//
// WHY READS AND NOT JUST WRITES
// The repo-boundary hook stops Claude editing files outside your projects. It does
// nothing about reading them. The practical risk with a read is different: a file
// gets read for a sensible reason and its contents land in the conversation, which
// is stored and travels. A password that reaches a transcript is one you now have
// to change. This hook is about that, not about snooping.
//
// WHY THIS COVERS Bash TOO
// Deny rules in settings.json are per-tool. Read(**/.env) stops the Read tool but
// not `grep FOO .env` run through Bash, which is the wider hole of the two.
//
// HONEST LIMIT
// Scanning shell command text is a heuristic. It reliably catches the accidental
// case, which is the real risk. It could be worded around deliberately. The macOS
// privacy settings are the layer that does not care how a request is phrased.
//
// ~/Library is deliberately NOT blocked: it is application plumbing rather than
// personal data, and build tooling genuinely reaches into it.

import { homedir } from "node:os"

const HOME = homedir()

// Personal folders. Nothing about building software needs to look in these.
const PERSONAL_DIRS = ["Documents", "Desktop", "Downloads", "Pictures", "Movies", "Music"]

// Secret-bearing filenames, matched as path components.
//
// The (?<![\w\\]) guard is load-bearing: without it, ".env" matches inside
// "process.env.API_KEY", and ordinary source-code searches get blocked. Requiring
// that the dot is preceded by neither a word character nor a backslash keeps
// "/path/.env" and "cat .env" matching, while letting through both "process.env.FOO"
// and its regex-escaped form "process\.env\." as written in a grep pattern. The
// backslash case is not hypothetical: `grep -rhoE "process\.env\.[A-Z_]+"` is a
// real command that a word-character-only guard blocks.
// Each entry carries a plain-English label, because the label is what gets shown
// when something is blocked. A raw regex in an error message is useless to a reader.
const SECRET_PATTERNS = [
  { label: "a .env file (database passwords, API keys)", re: /(?<![\w\\])\.env(\.[\w-]+)?(?![\w/])/ },
  { label: "the AWS credentials folder", re: /(?<![\w\\])\.aws\// },
  { label: "the SSH folder", re: /(?<![\w\\])\.ssh\// },
  { label: "an SSH private key", re: /\bid_rsa\b/ },
  { label: "an SSH private key", re: /\bid_ed25519\b/ },
  { label: "Claude Code's own saved login token", re: /(?<![\w\\])\.credentials\.json\b/ },
  { label: "a .netrc login file", re: /(?<![\w\\])\.netrc\b/ },
  { label: "a certificate or private key (.pem)", re: /\.pem\b/ },
]

// Template files exist to be committed and shared. They hold placeholder values,
// never real ones, so treating them as secrets blocks the ordinary work of
// documenting how to set a project up.
const TEMPLATE_FILES = [".env.example", ".env.sample", ".env.template"]

// Files inside ~/.ssh that carry no private key material. The folder is treated as
// secret because it usually holds private keys, but these specific members are not:
// host aliases, known-host fingerprints, and public keys, which exist to be shared.
//
// The trailing (?![\w.\-/]) on each is load-bearing in two ways. It pins the match to
// the exact filename, so ".ssh/config.bak" is not exempt. And excluding "/" stops
// ".ssh/config/../id_rsa" having its ".ssh/" masked away and slipping through.
const SSH_SAFE = [
  /\.ssh\/config(?![\w.\-/])/g,
  /\.ssh\/known_hosts(\.old)?(?![\w.\-/])/g,
  /\.ssh\/authorized_keys(?![\w.\-/])/g,
  /\.ssh\/[\w.-]+\.pub(?![\w.\-/])/g,
]

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// Blank out known-safe names before the secret patterns run, so a harmless file living
// inside a secret-ish family cannot trip its family's pattern. ".env.example" must not
// match ".env"; ".ssh/config" must not match ".ssh/".
//
// Masking ".ssh/id_rsa.pub" removes both the ".ssh/" and the "id_rsa" match, so a public
// key reads. That is intended: public keys are meant to be shared. ".ssh/id_rsa" with no
// suffix is not masked and stays blocked by both patterns.
function maskKnownSafePaths(text) {
  let out = text
  for (const name of TEMPLATE_FILES) {
    out = out.replace(new RegExp(`${escapeRe(name)}(?![\\w.-])`, "g"), "<template>")
  }
  for (const re of SSH_SAFE) {
    out = out.replace(re, "<ssh-config>")
  }
  return out
}

// Programs that print a file's contents. Only these turn "a command that mentions a
// secrets file" into "a command that would put secrets in the transcript".
//
// An earlier version blocked ANY command whose text contained ".env". In one day that
// blocked a commit message, a variable assignment (E=".env"), and, worst of all, a
// security audit checking whether secrets had ever been committed. None of those read
// anything. When the safety measure blocks the safety work, the measure is wrong.
const READERS = [
  // print a file directly
  "cat", "bat", "less", "more", "head", "tail", "tac", "nl",
  "strings", "xxd", "od", "hexdump", "base64", "tee",
  // search or transform, printing what they match
  "grep", "egrep", "fgrep", "rg", "ag", "awk", "sed", "jq", "yq",
  // crypto tools whose whole job is printing key material
  "openssl", "ssh-keygen", "gpg",
  // the "open the file and print it" one-liner path
  "python", "python3", "node", "ruby", "perl", "php",
  // these do not print anything, but they consume file contents wholesale, which is
  // how a secret leaves the machine rather than how it reaches the transcript.
  // `tar -czf keys.tgz ~/.ssh/` prints nothing and is exactly the move to stop.
  "tar", "zip", "gzip", "cp", "rsync", "scp", "ditto", "curl",
]

// Splitting on shell separators is load-bearing. It is what lets
// `git ls-files | grep -i env` through (the grep segment names no secrets file) while
// still catching `git status && cat .env` (the reader sits in its own later segment).
function segments(command) {
  return command.split(/(?:&&|\|\||[;|\n])/)
}

// `--env-file=.env.local` is Node handing variables to a program's own process
// environment: loading, not reading. Nothing reaches the transcript unless the
// program prints it, and a program that prints its secrets is beyond what
// command-text scanning can catch anyway. This is the exact in-process pattern
// the guard's own remedy text recommends, and the guard blocking it anyway is
// how a real benchmark run got stopped on 13 Aug 2026.
//
// Only the flag token is masked, value included, in both = and space forms plus
// --env-file-if-exists. A command that ALSO names a secrets file anywhere else
// in the segment keeps that mention visible and is still judged on it.
const ENV_FILE_FLAG = /--env-file(?:-if-exists)?(?:=|\s+)("[^"]*"|'[^']*'|\S+)/g

function maskEnvFileFlags(text) {
  return text.replace(ENV_FILE_FLAG, "<env-file-flag>")
}

// True when this segment would actually print a secrets file, or would add one to git.
// `git add` prints nothing, so a reader-only rule would miss it, but committing a real
// secrets file is a mistake worth stopping. It is the one non-reader kept on the list.
function segmentReadsSecret(segment) {
  const masked = maskKnownSafePaths(maskEnvFileFlags(segment))
  if (!secretHit(masked)) return null
  const firstWord = masked.trim().split(/\s+/)[0]
  const usesReader = READERS.some((r) => new RegExp(`(^|\\s|/)${r}\\b`).test(masked))
  const isGitAdd = /^git\s+add\b/.test(masked.trim()) || firstWord === "git" && /\sadd\b/.test(masked)
  if (usesReader || isGitAdd) return secretHit(masked)
  return null
}

function bashSecretHit(command) {
  if (typeof command !== "string") return null
  for (const segment of segments(command)) {
    const hit = segmentReadsSecret(segment)
    if (hit) return hit
  }
  return null
}

function personalDirHit(text) {
  for (const dir of PERSONAL_DIRS) {
    // Match the real path, and the ~ shorthand a shell command might use.
    if (text.includes(`${HOME}/${dir}`) || text.includes(`~/${dir}`)) return dir
  }
  return null
}

function secretHit(text) {
  const hit = SECRET_PATTERNS.find(({ re }) => re.test(text))
  return hit ? hit.label : null
}

// The fields worth scanning, per tool. Bash hides its paths inside a command
// string; the file tools name them directly.
function textToScan(toolName, toolInput) {
  const parts = [
    toolInput.command, // Bash
    toolInput.file_path, // Read
    toolInput.notebook_path, // NotebookEdit
    toolInput.path, // Grep, Glob
    toolInput.pattern, // Glob
  ]
  return parts.filter((p) => typeof p === "string" && p.length).join("\n")
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
  const text = textToScan(data.tool_name, toolInput)
  if (!text) process.exit(0)

  // Bash is judged on whether a segment would actually READ a secrets file, so merely
  // naming one (a commit message, a git pathspec, an audit) passes. The file tools
  // always open what they are pointed at, so there, naming it is enough to block.
  //
  // The personal-folder check below is deliberately NOT reader-scoped: for a folder
  // the concern includes listing what is in it, not just printing a file.
  const secret =
    typeof toolInput.command === "string"
      ? bashSecretHit(toolInput.command)
      : secretHit(maskKnownSafePaths(text))
  if (secret) {
    console.error(
      `Blocked by a Jacob-built guard (sensitive-read-guard, tunable): this looks like it reads a secrets file (matched ${secret}).\n` +
        `Secrets read into the conversation end up in a stored transcript, which ` +
        `means rotating them. Ask Jacob to supply the value or check it himself.\n` +
        `If the goal is knowing which database or project the env file points at, ` +
        `use the project's db:which-style script (npm run db:which), or create one: ` +
        `a script that loads the env file in its own process and prints only ` +
        `non-secret facts like the project ref. That is the sanctioned path.\n` +
        `To adjust what counts as a secret, edit SECRET_PATTERNS in ` +
        `~/.claude/hooks/sensitive-read-guard.mjs.`
    )
    process.exit(2)
  }

  const personal = personalDirHit(text)
  if (personal) {
    console.error(
      `Blocked by a Jacob-built guard (sensitive-read-guard, tunable): ~/${personal} is a personal folder, not a project folder.\n` +
        `Project work lives in ~/code. If a file here is genuinely needed, ask Jacob ` +
        `to move a copy into the project or to widen PERSONAL_DIRS in ` +
        `~/.claude/hooks/sensitive-read-guard.mjs.`
    )
    process.exit(2)
  }

  process.exit(0)
})
