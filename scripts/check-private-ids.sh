#!/bin/sh
# Refuse commits whose staged changes add a private identifier (chat ID, email, hostname...).
# The values live outside the repository, one per line ('#' comments allowed), in
# ${PIBOT_PRIVATE_IDS_FILE:-~/.config/pibot/private-ids}. Without that file the check is skipped.
# Values are never printed: findings are reported by line number in the private file.
# .beads/ is skipped until its exported owner email is addressed separately (pibot-9mf).
list="${PIBOT_PRIVATE_IDS_FILE:-$HOME/.config/pibot/private-ids}"
[ -r "$list" ] || exit 0

added=$(git diff --cached -U0 --no-color --diff-filter=ACMR -- . ':(exclude).beads' | grep '^+' | grep -v '^+++ ')
[ -n "$added" ] || exit 0

found=0
line=0
while IFS= read -r value || [ -n "$value" ]; do
  line=$((line + 1))
  case "$value" in ''|'#'*) continue ;; esac
  if printf '%s\n' "$added" | grep -qiF -- "$value"; then
    # Name only files whose *added* lines carry it (-S would also match removals).
    files=$(git diff --cached --name-only --diff-filter=ACMR -- . ':(exclude).beads' | while IFS= read -r f; do
      git diff --cached -U0 --no-color -- "$f" | grep '^+' | grep -v '^+++ ' | grep -qiF -- "$value" && printf '%s ' "$f"
    done)
    echo "private-ids: staged changes add the value on line $line of $list${files:+ in: $files}" >&2
    found=1
  fi
done < "$list"
[ "$found" -eq 0 ] || { echo "private-ids: replace it with a fake value (see src/test-fixtures.ts) before committing." >&2; exit 1; }
