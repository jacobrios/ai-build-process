#!/bin/bash
# Test harness for ~/.claude/hooks/sensitive-read-guard.mjs
# Exit 0 = allowed, exit 2 = blocked.

HOOK=~/.claude/hooks/sensitive-read-guard.mjs
H=$(echo ~)
pass=0; fail=0

check() {
  local expect="$1" desc="$2" json="$3"
  echo "$json" | node "$HOOK" >/dev/null 2>&1
  local got=$?
  if [ "$got" = "$expect" ]; then
    printf "  PASS  %-56s (exit %s)\n" "$desc" "$got"; pass=$((pass+1))
  else
    printf "  FAIL  %-56s expected %s, got %s\n" "$desc" "$expect" "$got"; fail=$((fail+1))
  fi
}

echo "MUST STILL WORK (exit 0) — false positives would make this hook unusable"
check 0 "searching source for process.env.FOO"  '{"tool_name":"Bash","tool_input":{"command":"grep -rhoE \"process\\.env\\.[A-Z_]+\" src"}}'
check 0 "REGRESSION: escaped regex process\\.env\\."  '{"tool_name":"Bash","tool_input":{"command":"grep -rhoE \"process\\\\.env\\\\.[A-Z_]+\" src prisma.config.ts"}}'
check 0 "reading code that mentions process.env" '{"tool_name":"Bash","tool_input":{"command":"rg \"process.env.ANTHROPIC_API_KEY\" src/lib"}}'
check 0 "a normal project file read"             "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$H/code/interplanetary-groups/README.md\"}}"
check 0 "running the test suite"                 '{"tool_name":"Bash","tool_input":{"command":"npm test"}}'
check 0 "git status"                             '{"tool_name":"Bash","tool_input":{"command":"git status --short"}}'
check 0 "grep inside a project"                  "{\"tool_name\":\"Grep\",\"tool_input\":{\"pattern\":\"TODO\",\"path\":\"$H/code/math-game\"}}"
check 0 "a file named environment.ts"            "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$H/code/x/src/environment.ts\"}}"
check 0 "prisma.config.ts which reads env vars"  "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$H/code/x/prisma.config.ts\"}}"

echo
echo "SECRETS — must block (exit 2)"
check 2 "cat .env"                               '{"tool_name":"Bash","tool_input":{"command":"cat .env"}}'
check 2 "grep a value out of a project .env"     "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"grep DATABASE_URL $H/code/x/.env\"}}"
check 2 "the Read tool on a .env"                "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$H/code/x/.env\"}}"
check 2 ".env.local"                             '{"tool_name":"Bash","tool_input":{"command":"cat .env.local"}}'
check 2 "ssh private key"                        "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $H/.ssh/id_rsa\"}}"
check 2 "aws credentials"                        "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $H/.aws/credentials\"}}"
check 2 "a certificate"                          '{"tool_name":"Bash","tool_input":{"command":"openssl x509 -in server.pem -text"}}'
check 2 "Claude Code's own stored token"         "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$H/.claude/.credentials.json\"}}"

echo
echo "PERSONAL FOLDERS — must block (exit 2)"
check 2 "listing Documents"                      "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls $H/Documents\"}}"
check 2 "reading from Desktop"                   "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$H/Desktop/notes.txt\"}}"
check 2 "a photo"                                "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$H/Pictures/family.jpg\"}}"
check 2 "Downloads via the ~ shorthand"          '{"tool_name":"Bash","tool_input":{"command":"ls ~/Downloads"}}'
check 2 "grepping across Documents"              "{\"tool_name\":\"Grep\",\"tool_input\":{\"pattern\":\"tax\",\"path\":\"$H/Documents\"}}"

echo
echo "TEMPLATE FILES — must be allowed (exit 0)"
E=".env"
check 0 "git add the template"                   "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git add $E.example\"}}"
check 0 "commit message naming the template"     "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m 'Add $E.example so setup works'\"}}"
check 0 "reading the template"                   "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $E.example\"}}"
check 0 "Read tool on the template"              "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$H/code/x/$E.example\"}}"
check 0 "the .sample spelling"                   "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $E.sample\"}}"
check 0 "the .template spelling"                 "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $E.template\"}}"
check 0 "a commit message naming the REAL file"  "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m 'stop tracking $E'\"}}"

echo
echo "THE EXCEPTION MUST NOT BE WIDENABLE — must block (exit 2)"
check 2 "suffix trap: template.bak"              "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $E.example.bak\"}}"
check 2 "suffix trap: template.old"              "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $E.example.old\"}}"
check 2 "prefix trap: notexample"                "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $E.exampleeee\"}}"
check 2 "git ADD the real secrets file"          "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git add $E\"}}"
check 2 "safe verb chained to a real read"       "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git status && cat $E\"}}"
check 2 "safe verb piped to a real read"         "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls | cat $E\"}}"
check 2 "template masking cannot hide a real read" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $E.example $E\"}}"

echo
echo "REGRESSIONS FROM 27 JUL — real work the guard wrongly blocked, must be allowed"
check 0 "audit: which env-ish files are tracked"  "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git ls-files | grep -i env\"}}"
check 0 "audit: was a secret ever committed"      "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git log --all --full-history --oneline -- '$E' '$E.local'\"}}"
check 0 "audit: is the secrets file ignored"      "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git check-ignore -q $E\"}}"
check 0 "a shell variable assignment"             "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"E=\\\"$E\\\"; echo done\"}}"
check 0 "listing the file"                        "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls -l $E\"}}"
check 0 "removing it from git tracking"           "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git rm --cached $E\"}}"

echo
echo "READS MUST STILL BE BLOCKED (exit 2)"
check 2 "cat the secrets file"                    "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $E\"}}"
check 2 "head it"                                 "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"head -5 $E\"}}"
check 2 "grep a value out of it"                  "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"grep DATABASE_URL $E\"}}"
check 2 "sed over it"                             "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"sed -n '1,5p' $E\"}}"
check 2 "base64 it"                               "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"base64 $E\"}}"
check 2 "reader hidden in a LATER segment"        "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git status && cat $E\"}}"
check 2 "reader after a semicolon"                "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"echo hi; cat $E\"}}"
check 2 "git add the real secrets file"           "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git add $E\"}}"
check 2 "cat a local override"                    "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $E.local\"}}"
check 2 "cat an ssh private key"                  '{"tool_name":"Bash","tool_input":{"command":"cat ~/.ssh/id_rsa"}}'

echo
echo "SSH CONFIG IS NOT A KEY — must be allowed (exit 0)"
S="\$HOME/.ssh"
check 0 "read the ssh config"                    "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $S/config\"}}"
check 0 "grep host aliases (reported block)"     "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"grep -n Host $S/config\"}}"
check 0 "known_hosts"                            "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $S/known_hosts\"}}"
check 0 "authorized_keys"                        "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $S/authorized_keys\"}}"
check 0 "a PUBLIC key (meant to be shared)"      "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $S/id_rsa.pub\"}}"
check 0 "Read tool on the ssh config"            "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$H/.ssh/config\"}}"

echo
echo "PRIVATE KEYS STAY UNREACHABLE — must block (exit 2)"
check 2 "the rsa private key"                    "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $S/id_rsa\"}}"
check 2 "the ed25519 private key"                "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $S/id_ed25519\"}}"
check 2 "suffix trap: config.bak"                "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $S/config.bak\"}}"
check 2 "prefix trap: configuration"             "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $S/configuration\"}}"
check 2 "a safe file cannot vouch for a key"     "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $S/id_rsa.pub $S/id_rsa\"}}"
check 2 "traversal out of a safe filename"       "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $S/config/../id_rsa\"}}"
check 2 "archiving the whole ssh folder"         "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"tar -czf keys.tgz $S/\"}}"
check 2 "Read tool on a private key"             "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$H/.ssh/id_ed25519\"}}"

echo
echo "LOADING IS NOT READING — --env-file hands secrets to a process, not the transcript (13 Aug 2026)"
check 0 "the exact blocked bench command"        "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"node --env-file=$E.local scripts/bench-coach-brevity.mjs --condition baseline --runs 1\"}}"
check 0 "--env-file with plain $E"               "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"node --env-file=$E scripts/run.mjs\"}}"
check 0 "the -if-exists variant"                 "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"node --env-file-if-exists=$E.local x.mjs\"}}"
check 0 "space-separated flag form"              "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"node --env-file $E.local x.mjs\"}}"

echo
echo "THE FLAG MUST NOT BECOME A CLOAK — must block (exit 2)"
check 2 "flag plus an actual read of the file"   "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"node --env-file=$E.local -e 'fs.readFileSync(\\\"$E.local\\\")'\"}}"
check 2 "flag in one segment, cat in the next"   "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"node --env-file=$E.local x.mjs && cat $E\"}}"
check 2 "cat is still cat"                       "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat $E.local\"}}"
check 2 "node one-liner reading the file"        "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"node -e 'console.log(require(\\\"fs\\\").readFileSync(\\\"$E\\\"))'\"}}"
check 2 "Read tool on the file is unchanged"     "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$H/code/x/$E.local\"}}"

echo
echo "  $pass passed, $fail failed"
[ "$fail" = 0 ] || exit 1
