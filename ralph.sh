#!/bin/bash
set -e

# ─────────────────────────────────────────────────────────────────────────────
# ralph.sh — bounded per-task build loop for claude-faces.
#
# Runs headless Claude Code N times. Each run: pick the first prd.json task with
# passes=false, do ONLY that task (tests-first where sensible), run the task's own
# "Verify:" steps, flip passes=true, journal to progress.txt, commit (and push),
# then STOP. Statelessness (--no-session-persistence) means every run re-reads the
# JSON and picks up the next undone task. Adapted from solvr/ralph.sh.
#
#   ./ralph.sh 1          # one task
#   ./ralph.sh 5          # up to five tasks
#   PRD_FILE=prd.json ./ralph.sh 3
#   RALPH_PUSH=0 ./ralph.sh 3     # commit locally, do NOT push
#   MODEL=claude-opus-4-8 ./ralph.sh 3   # pin a model (default: Claude Code default)
# ─────────────────────────────────────────────────────────────────────────────

# PRD file (override with env var). Lives at the repo root for claude-faces.
PRD_FILE="${PRD_FILE:-prd.json}"

# Auto-push after each task (1=push, 0=commit only). Default matches Ralph.
RALPH_PUSH="${RALPH_PUSH:-1}"

# Optional model pin. Empty = whatever Claude Code is configured to use.
MODEL="${MODEL:-}"
MODEL_FLAG=""
if [ -n "$MODEL" ]; then
  MODEL_FLAG="--model $MODEL"
fi

# Colors
CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
MAGENTA='\033[0;35m'; BLUE='\033[0;34m'; RED='\033[0;31m'
BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

CONTEXT_WARNING_THRESHOLD=120000

# Push instruction injected into the prompt based on RALPH_PUSH.
if [ "$RALPH_PUSH" = "1" ]; then
  PUSH_STEP="8. PUSH: run 'git push' to publish the commit."
else
  PUSH_STEP="8. Do NOT push — leave the commit local (RALPH_PUSH=0)."
fi

format_time() {
  local secs=$1
  printf "%02d:%02d:%02d" $((secs/3600)) $((secs%3600/60)) $((secs%60))
}

print_exceeded_summary() {
  if [ ${#exceeded_iters[@]} -gt 0 ]; then
    echo ""
    echo -e "${RED}${BOLD}───────────────────────────────────────────────────────────${NC}"
    echo -e "${RED}${BOLD}  ⚠️  ${#exceeded_iters[@]} iteration(s) exceeded ${CONTEXT_WARNING_THRESHOLD} tokens:${NC}"
    for idx in "${!exceeded_iters[@]}"; do
      echo -e "${RED}     • Iteration ${exceeded_iters[$idx]}: ${exceeded_tokens[$idx]} tokens${NC}"
    done
    echo -e "${RED}${BOLD}───────────────────────────────────────────────────────────${NC}"
  fi
}

if [ -z "$1" ]; then
  echo "Usage: $0 <iterations>"
  exit 1
fi

echo -e "${DIM}PRD: ${PRD_FILE}   push: ${RALPH_PUSH}   model: ${MODEL:-<default>}${NC}"
echo -e "${DIM}Claude processes running:${NC}"
ps aux | grep -i '[c]laude' | awk '{print "  PID:", $2}' || echo "  None"
echo ""

tmpfile=$(mktemp)
cleanup() { rm -f "$tmpfile"; }
trap cleanup EXIT

overall_start=$(date +%s)
total_iteration_time=0
completed_iterations=0
total_cost=0
total_input_tokens=0
total_output_tokens=0
declare -a exceeded_iters=()
declare -a exceeded_tokens=()

for ((i=1; i<=$1; i++)); do
  echo ""
  echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════════════${NC}"
  echo -e "${CYAN}${BOLD}  Iteration $i of $1${NC}"
  echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════════════${NC}"
  echo ""
  iter_start=$(date +%s)

  # Run Claude Code synchronously on ONE task.
  claude $MODEL_FLAG --dangerously-skip-permissions --no-session-persistence -p --output-format json "@CLAUDE.md @README.md @$PRD_FILE @progress.txt \
\
=== GOLDEN RULES (MUST FOLLOW) === \
• Build the REAL thing — no mocks, no stubs, no placeholders for real logic. \
• TDD where there is a runtime surface: write a failing test FIRST, then implement (RED→GREEN→REFACTOR). Docs/infra tasks may have no test — use judgment. \
• Keep files focused: ~500 lines max, split if larger. SKILL.md MUST stay <= 500 lines. \
• Secrets are server-side ONLY — never NEXT_PUBLIC_*; all provider keys live in route handlers. \
• Reuse, don't reinvent: port from the READ-ONLY reference at ../fuguFaces. NEVER modify anything under ../fuguFaces. \
• Match the stack: Next.js 16 App Router, React 19, TypeScript, npm. \
\
=== WORKFLOW === \
1. Read CLAUDE.md (guidelines + golden rules) and README.md (product vision/spec). \
2. In $PRD_FILE, find the FIRST task (top-to-bottom order = priority; do any task whose description starts with the URGENT marker before others) where passes is false. Work ONLY on that one task. Honor its 'DEPENDS ON:' / 'PREREQUISITE:' notes. \
3. Follow that task's 'steps' exactly. Write tests first where it makes sense. \
4. Validate by running that task's own 'Verify:' steps (npm run typecheck, npm run build, node checks, tests — whatever the task specifies). Do NOT mark the task done until its Verify steps pass. \
5. Append a dated entry to progress.txt describing what you did. \
6. In $PRD_FILE, set that task's \"passes\" to true. \
7. COMMIT: run 'git add .' to stage ALL files (including new ones), then 'git commit -m \"<task description>\"'. \
$PUSH_STEP \
9. If, and ONLY IF, every task in $PRD_FILE now has passes=true, output the exact line: <promise>COMPLETE</promise> \
\
CRITICAL: \
- ONE TASK ONLY, then STOP. Do NOT continue to another task. \
- NEVER modify anything under ../fuguFaces (read-only reference). \
- Always 'git add .' (include NEW files) before committing. \
- After commit, you are DONE. Exit immediately. \
- Keep files focused (~500 lines max)." > "$tmpfile" 2>&1 || true

  iter_end=$(date +%s)
  iter_time=$((iter_end - iter_start))
  total_iteration_time=$((total_iteration_time + iter_time))
  completed_iterations=$((completed_iterations + 1))

  result_text=""; cost=0; input_tokens=0; cache_read=0; cache_create=0; output_tokens=0; iter_context=0

  if jq -e . "$tmpfile" > /dev/null 2>&1; then
    result_text=$(jq -r '.result // "No result"' "$tmpfile")
    cost=$(jq -r '.total_cost_usd // 0' "$tmpfile")
    input_tokens=$(jq -r '.usage.input_tokens // 0' "$tmpfile")
    cache_read=$(jq -r '.usage.cache_read_input_tokens // 0' "$tmpfile")
    cache_create=$(jq -r '.usage.cache_creation_input_tokens // 0' "$tmpfile")
    output_tokens=$(jq -r '.usage.output_tokens // 0' "$tmpfile")
    iter_context=$((input_tokens + cache_read + cache_create))

    if [ "$iter_context" -gt "$CONTEXT_WARNING_THRESHOLD" ]; then
      exceeded_iters+=("$i"); exceeded_tokens+=("$iter_context")
    fi

    total_cost=$(echo "$total_cost $cost" | awk '{printf "%.4f", $1 + $2}')
    total_input_tokens=$((total_input_tokens + iter_context))
    total_output_tokens=$((total_output_tokens + output_tokens))

    echo "$result_text"
    echo ""
    echo -e "${BLUE}───────────────────────────────────────────────────────────${NC}"
    echo -e "${BLUE}  🔢 CONTEXT: ${BOLD}${iter_context}${NC}${BLUE} tokens (in=${input_tokens} cache_read=${cache_read} cache_create=${cache_create})${NC}"
    echo -e "${BLUE}  📤 OUTPUT:  ${BOLD}${output_tokens}${NC}${BLUE} tokens${NC}"
    echo -e "${BLUE}  💰 COST:    ${BOLD}\$${cost}${NC}"
    echo -e "${BLUE}───────────────────────────────────────────────────────────${NC}"

    if [ "$iter_context" -gt "$CONTEXT_WARNING_THRESHOLD" ]; then
      echo ""
      echo -e "${RED}${BOLD}  ⚠️  WARNING: CONTEXT EXCEEDED ${CONTEXT_WARNING_THRESHOLD} TOKENS! (${iter_context})${NC}"
      echo ""
    fi
  else
    echo -e "${YELLOW}Warning: Could not parse JSON output${NC}"
    cat "$tmpfile"
  fi

  echo ""
  echo -e "${YELLOW}⏱  Iteration $i took ${BOLD}$(format_time $iter_time)${NC}"
  echo -e "${GREEN}📊 $(./progress.sh)${NC}"

  if grep -q "<promise>COMPLETE</promise>" "$tmpfile"; then
    overall_end=$(date +%s)
    overall_time=$((overall_end - overall_start))
    avg_time=$((total_iteration_time / completed_iterations))
    echo ""
    echo -e "${MAGENTA}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${MAGENTA}${BOLD}  🎉 PRD COMPLETE after $i iterations!${NC}"
    echo -e "${MAGENTA}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${MAGENTA}  ⏱  Overall time: ${BOLD}$(format_time $overall_time)${NC}"
    echo -e "${MAGENTA}  ⏱  Average per iteration: ${BOLD}$(format_time $avg_time)${NC}"
    echo -e "${BLUE}  🔢 Total context: ${BOLD}${total_input_tokens}${NC}${BLUE} tokens${NC}"
    echo -e "${BLUE}  📤 Total output: ${BOLD}${total_output_tokens}${NC}${BLUE} tokens${NC}"
    echo -e "${BLUE}  💰 Total cost: ${BOLD}\$${total_cost}${NC}"
    echo -e "${GREEN}  📊 $(./progress.sh)${NC}"
    print_exceeded_summary
    exit 0
  fi
done

overall_end=$(date +%s)
overall_time=$((overall_end - overall_start))
avg_time=$((total_iteration_time / completed_iterations))

echo ""
echo -e "${MAGENTA}${BOLD}═══════════════════════════════════════════════════════════${NC}"
echo -e "${MAGENTA}${BOLD}  Completed $1 iterations${NC}"
echo -e "${MAGENTA}${BOLD}═══════════════════════════════════════════════════════════${NC}"
echo -e "${MAGENTA}  ⏱  Overall time: ${BOLD}$(format_time $overall_time)${NC}"
echo -e "${MAGENTA}  ⏱  Average per iteration: ${BOLD}$(format_time $avg_time)${NC}"
echo -e "${BLUE}  🔢 Total context: ${BOLD}${total_input_tokens}${NC}${BLUE} tokens${NC}"
echo -e "${BLUE}  📤 Total output: ${BOLD}${total_output_tokens}${NC}${BLUE} tokens${NC}"
echo -e "${BLUE}  💰 Total cost: ${BOLD}\$${total_cost}${NC}"
echo -e "${GREEN}  📊 $(./progress.sh)${NC}"
print_exceeded_summary
