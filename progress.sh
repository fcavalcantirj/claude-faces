#!/bin/bash

# Count passed and total requirements in the claude-faces PRD.
# Adapted from solvr/progress.sh. Default PRD lives at the repo root.

prd_file="${PRD_FILE:-prd.json}"

if [ ! -f "$prd_file" ]; then
  echo "0/0 (0%) - PRD not found"
  exit 0
fi

# Count total (lines with "passes":) and passed (lines with "passes": true).
# Relies on the PRD being one "passes" flag per line (it is).
total=$(grep -c '"passes"' "$prd_file" | tr -d '\n')
passed=$(grep -c '"passes": true' "$prd_file" | tr -d '\n')

total=${total:-0}
passed=${passed:-0}

if [ "$total" -eq 0 ]; then
  echo "0/0 (0%)"
else
  percent=$((passed * 100 / total))
  echo "${passed}/${total} (${percent}%)"
fi
