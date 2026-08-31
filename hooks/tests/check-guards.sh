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

echo "Checking repo boundary guard (keeps edits inside the current project)..."
bash "$DIR/test-repo-boundary.sh" | tail -2 || fail=1

echo
echo "Checking sensitive read guard (blocks secrets and personal folders)..."
bash "$DIR/test-sensitive-guard.sh" | tail -2 || fail=1

echo
if [ "$fail" = 0 ]; then
  echo "Both guards are working."
else
  echo "SOMETHING IS WRONG. A guard is not blocking what it should."
  echo "Until it is fixed, assume Claude can reach files you expect to be protected."
  exit 1
fi
