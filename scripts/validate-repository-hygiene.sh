#!/usr/bin/env bash
set -euo pipefail

readonly generated_directories=(node_modules dist coverage .cache)
tracked_count=0

for directory in "${generated_directories[@]}"; do
  mapfile -d '' tracked_paths < <(git ls-files -z -- "$directory")
  if ((${#tracked_paths[@]} > 0)); then
    printf 'ERROR: %d generated path(s) are tracked under %s/:\n' \
      "${#tracked_paths[@]}" "$directory" >&2
    printf '  %s\n' "${tracked_paths[@]:0:20}" >&2
    if ((${#tracked_paths[@]} > 20)); then
      printf '  ... and %d more\n' "$(( ${#tracked_paths[@]} - 20 ))" >&2
    fi
    ((tracked_count += ${#tracked_paths[@]}))
  fi
done

if ((tracked_count > 0)); then
  printf 'Repository hygiene failed: %d generated path(s) are tracked.\n' \
    "$tracked_count" >&2
  exit 1
fi

printf 'Repository hygiene passed: generated directories contain no tracked paths.\n'
