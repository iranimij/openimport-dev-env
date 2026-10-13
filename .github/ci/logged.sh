#!/usr/bin/env bash
# Runs a command, keeps its output in the job log, and on failure repeats the last lines as one error annotation:
# annotations are readable through the GitHub REST API (check-runs/{id}/annotations), raw job logs are not always.
# Usage: .github/ci/logged.sh <title> <command> [args...]
set -uo pipefail
title="$1"; shift
log="$(mktemp)"
"$@" 2>&1 | tee "$log"
status="${PIPESTATUS[0]}"
if [ "$status" -ne 0 ]; then
  # Annotations are cut at about 4 KB: drop known noise and colours, keep the last 3,500 characters, encode.
  sed -E 's/\x1B\[[0-9;]*[A-Za-z]//g' "$log" \
    | grep -vE 'recognized as part of Magento Multi Source Inventory|No special rule applied for|^\s*$' \
    | tail -n 60 | tail -c 3500 \
    | awk 'BEGIN { ORS = "" } { gsub(/%/, "%25"); gsub(/\r/, "%0D"); print $0 "%0A" }' > "$log.tail"
  echo "::error title=${title} (exit ${status})::$(cat "$log.tail")"
fi
exit "$status"
