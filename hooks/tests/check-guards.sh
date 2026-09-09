#!/bin/bash
# Verifies that the two Claude Code guardrail hooks are alive and working.
#
# WHY THIS EXISTS
# A hook that crashes exits with code 1, which Claude Code treats as a NON-blocking
# error. The tool call proceeds. So a broken guard does not announce itself: it just
# quietly stops protecting anything. This happened once during the original build.
#
# Run this any time you want to confirm the guards are real:
#   bash ~/.claude/hooks/tests/check-guards.sh

DIR="$(cd "$(dirname "$0")" && pwd)"
fail=0

# Piping to tail would report tail's exit status, not the suite's, so this
# script said "working" over 86 failing assertions until 9 September 2026.
# Run, keep the status, then show the tail.
run() {
  echo "$2..."
  local out rc
  out=$(bash "$DIR/$1.sh" 2>&1); rc=$?
  echo "$out" | tail -2
  [ "$rc" = 0 ] || fail=1
  echo
}

run test-repo-boundary   "Checking repo boundary guard (keeps edits inside the current project)"
run test-sensitive-guard "Checking sensitive read guard (blocks secrets and personal folders)"
run test-branch-cut-guard "Checking branch cut guard (a new slice starts from a current main)"
run test-safety-net-drift "Checking safety-net drift report"

if [ "$fail" = 0 ]; then
  echo "All guards are working."
else
  echo "SOMETHING IS WRONG. A guard is not blocking what it should."
  echo "Until it is fixed, assume Claude can reach files you expect to be protected."
  exit 1
fi
