#!/bin/bash
#
# Claude Code statusline: cwd | git branch | session cost | context left |
# 5h quota used | model (+ effort)
#

input=$(cat)

# --- Colors (dim-friendly ANSI) ---
RESET=$'\033[0m'
DIM=$'\033[2m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
CYAN=$'\033[36m'
LIGHT_BLUE=$'\033[94m'
ORANGE=$'\033[38;5;208m'
MAGENTA=$'\033[35m'
RED=$'\033[31m'
GRAY=$'\033[90m'
# Folder: a light grey, a step above GRAY.
LIGHT_GRAY=$'\033[38;5;250m'
BRIGHT_BLUE=$'\033[94m'
AMBER=$'\033[38;5;214m'
# Model: a greyed plum, quieter than the magenta of the response time.
MODEL_GREY=$'\033[38;5;139m'
BOLD_RED=$'\033[1;31m'

# --- Working directory (short form: last path component) ---
dir=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // empty')
if [ -n "$dir" ]; then
  dir_short=$(basename "$dir")
else
  dir_short="?"
fi

# --- Git branch (skip optional locks, only if inside a repo) ---
branch=""
worktree=""
if [ -n "$dir" ] && git -C "$dir" --no-optional-locks rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  branch=$(git -C "$dir" --no-optional-locks branch --show-current 2>/dev/null)
  if [ -z "$branch" ]; then
    branch=$(git -C "$dir" --no-optional-locks rev-parse --short HEAD 2>/dev/null)
  fi

  # --- Linked worktree: keep the main repo folder as the dir segment and
  # surface the worktree name separately. A linked worktree has its own
  # git-dir, distinct from the shared common dir of the main checkout.
  git_dir=$(git -C "$dir" --no-optional-locks rev-parse --path-format=absolute --git-dir 2>/dev/null)
  common_dir=$(git -C "$dir" --no-optional-locks rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
  if [ -n "$git_dir" ] && [ -n "$common_dir" ] && [ "$git_dir" != "$common_dir" ]; then
    worktree=$(basename "$(git -C "$dir" --no-optional-locks rev-parse --show-toplevel 2>/dev/null)")
    dir_short=$(basename "$(dirname "$common_dir")")
  fi
fi

# --- Session cost so far (with abbreviated total token count) ---
cost=$(echo "$input" | jq -r '.cost.total_cost_usd // empty')
if [ -n "$cost" ]; then
  # 4 decimals under $1, 2 from $1 up.
  cost_fmt=$(awk -v c="$cost" 'BEGIN { printf (c < 1 ? "$%.4f" : "$%.2f"), c }')
else
  cost_fmt='$0.0000'
fi

total_tokens=$(echo "$input" | jq -r '((.context_window.total_input_tokens // 0) + (.context_window.total_output_tokens // 0))')
if [ -n "$total_tokens" ] && [ "$total_tokens" -gt 0 ] 2>/dev/null; then
  tokens_fmt=$(awk -v n="$total_tokens" 'BEGIN {
    if (n >= 1000000) printf "%.1fM token", n/1000000
    else if (n >= 1000) printf "%.1fK token", n/1000
    else printf "%d token", n
  }')
  cost_fmt="${cost_fmt} (${tokens_fmt})"
fi

# --- Model in use ---
model=$(echo "$input" | jq -r '.model.display_name // "Unknown"')

# --- Reasoning effort level ---
effort=$(echo "$input" | jq -r '.effort.level // empty')
if [ -n "$effort" ]; then
  model="${model} (${effort})"
fi

# --- Context window used (severity-colored: healthy/high/critical) ---
# Below NEARFULL_THRESHOLD% remaining, treat the context as effectively
# full (rounding/display noise means it rarely shows a literal 0%) and
# call it out loudly — that's the cue to run /clear.
NEARFULL_THRESHOLD=1
context_pct=$(echo "$input" | jq -r '.context_window.remaining_percentage // empty')
context_nearfull=0
if [ -n "$context_pct" ]; then
  if awk "BEGIN{exit !($context_pct <= $NEARFULL_THRESHOLD)}"; then
    context_nearfull=1
    context_fmt="ctx 100%"
    context_color="$BOLD_RED"
  else
    context_used_pct=$(awk -v r="$context_pct" 'BEGIN { printf "%.0f", 100 - r }')
    context_fmt="ctx ${context_used_pct}%"
    # Escalates with usage: <20% grey, 20–50% yellow, >50% orange,
    # >75% bold red.
    context_color="$GRAY"
    if awk "BEGIN{exit !($context_used_pct > 75)}"; then
      context_color="$BOLD_RED"
    elif awk "BEGIN{exit !($context_used_pct > 50)}"; then
      context_color="$ORANGE"
    elif awk "BEGIN{exit !($context_used_pct >= 20)}"; then
      context_color="$YELLOW"
    fi
  fi
fi

# --- 5h rate-limit reset time (severity-colored by usage: healthy/high/critical) ---
quota_pct=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')
resets_at=$(echo "$input" | jq -r '.rate_limits.five_hour.resets_at // empty')
if [ -n "$resets_at" ]; then
  reset_time=$(python3 -c "
import sys, datetime
try:
    dt = datetime.datetime.fromtimestamp(int(sys.argv[1]))
    print(dt.strftime('%H:%M'))
except Exception:
    pass
" "$resets_at" 2>/dev/null)
fi
if [ -n "$reset_time" ]; then
  if [ -n "$quota_pct" ]; then
    quota_fmt=$(printf '%.0f%% ↻  %s' "$quota_pct" "$reset_time")
  else
    quota_fmt="↻  ${reset_time}"
  fi
  # Amber at rest, orange past 60%, red from 95%.
  quota_color="$AMBER"
  if [ -n "$quota_pct" ]; then
    if awk "BEGIN{exit !($quota_pct >= 95)}"; then
      quota_color="$RED"
    elif awk "BEGIN{exit !($quota_pct > 60)}"; then
      quota_color="$ORANGE"
    fi
  fi
fi

# --- Time of last assistant response (HH:MM:SS, local time) ---
# Transcript is JSONL, one JSON object per line — jq parses concatenated
# top-level values natively, no need to reverse/tac the file (not available
# on macOS by default). `tail -1` picks the chronologically last assistant
# entry, since entries are appended in order.
transcript_path=$(echo "$input" | jq -r '.transcript_path // empty')
last_response_time=""
if [ -n "$transcript_path" ] && [ -f "$transcript_path" ]; then
  last_ts=$(jq -rc 'select(.type == "assistant") | .timestamp' "$transcript_path" 2>/dev/null | tail -1)
  if [ -n "$last_ts" ]; then
    last_response_time=$(python3 -c "
import sys, datetime
try:
    dt = datetime.datetime.fromisoformat(sys.argv[1].replace('Z', '+00:00')).astimezone()
    print(dt.strftime('%H:%M:%S'))
except Exception:
    pass
" "$last_ts" 2>/dev/null)
  fi
fi

# --- Assemble output ---
# dir/branch/cost keep the original positional color order; context/quota
# are severity-colored since they're warning-style metrics; model always
# closes the line in magenta, followed by the last-response-time segment
# in the same color.
sep="${DIM} | ${RESET}"
line=""

append_segment() {
  local color="$1" text="$2"
  local seg="${color}${text}${RESET}"
  if [ -n "$line" ]; then
    line="${line}${sep}${seg}"
  else
    line="${seg}"
  fi
}

# Cost segment shares the context's at-rest grey, and turns red when
# context is effectively full, so both signals point at the same moment.
cost_color="$GRAY"
if [ "$context_nearfull" -eq 1 ]; then
  cost_color="$BOLD_RED"
fi

dir_seg="${LIGHT_GRAY}→ ${dir_short}${RESET}"
if [ -n "$worktree" ]; then
  # The worktree name already shows up as the branch in the git segment,
  # so only flag that we're in a linked worktree.
  dir_seg="${dir_seg} ${GREEN}@${RESET} ${YELLOW}WT${RESET}"
fi
append_segment "" "$dir_seg"
if [ -n "$branch" ]; then
  # "git:(" and ")" in red; the branch name itself in bright blue.
  branch_seg="${RED}git:(${RESET}${BRIGHT_BLUE}${branch}${RESET}${RED})${RESET}"
  append_segment "" "$branch_seg"
fi
append_segment "$cost_color" "$cost_fmt"

if [ -n "$context_fmt" ]; then
  append_segment "$context_color" "$context_fmt"
fi
if [ -n "$quota_fmt" ]; then
  append_segment "$quota_color" "$quota_fmt"
fi

append_segment "$MODEL_GREY" "$model"
if [ -n "$last_response_time" ]; then
  append_segment "$MAGENTA" "$last_response_time"
fi

printf '%s\n' "$line"
