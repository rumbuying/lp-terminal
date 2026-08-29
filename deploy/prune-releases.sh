#!/usr/bin/env bash
set -euo pipefail

keep=3
apply=false

if [[ ${1:-} == "--apply" ]]; then
  apply=true
elif [[ $# -ne 0 ]]; then
  echo "usage: $0 [--apply]" >&2
  exit 2
fi

targets=(
  "/var/www/lp-terminal/releases|/var/www/lp-terminal/current"
  "/opt/lp-terminal-indexer/releases|/opt/lp-terminal-indexer/app"
  "/opt/lp-terminal-executor/releases|/opt/lp-terminal-executor/app"
)

doomed_all=()

contains() {
  local needle=$1
  shift
  local item
  for item in "$@"; do
    [[ $item == "$needle" ]] && return 0
  done
  return 1
}

for target in "${targets[@]}"; do
  releases_dir=${target%%|*}
  current_link=${target#*|}

  if [[ ! -d $releases_dir ]]; then
    echo "skip missing release root: $releases_dir"
    continue
  fi
  if [[ ! -L $current_link ]]; then
    echo "refusing cleanup: current link is missing or is not a symlink: $current_link" >&2
    exit 1
  fi

  current_target=$(readlink -f -- "$current_link")
  case "$current_target" in
    "$releases_dir"/*) ;;
    *)
      echo "refusing cleanup: $current_link resolves outside $releases_dir" >&2
      exit 1
      ;;
  esac

  mapfile -d '' -t releases < <(
    while IFS= read -r -d '' release; do
      name=${release##*/}
      if [[ $name =~ ([0-9]{8}T[0-9]{6}Z) ]]; then
        stamp=${BASH_REMATCH[1]}
      else
        stamp=$(stat -c '%Y' -- "$release")
      fi
      printf '%s\t%s\0' "$stamp" "$release"
    done < <(find "$releases_dir" -mindepth 1 -maxdepth 1 -type d -print0) \
      | sort -z -r -k1,1 \
      | cut -z -f2-
  )

  if (( ${#releases[@]} <= keep )); then
    echo "$releases_dir: ${#releases[@]} release(s), nothing to prune"
    continue
  fi

  retained=("${releases[@]:0:keep}")
  doomed=("${releases[@]:keep}")

  if ! contains "$current_target" "${retained[@]}"; then
    echo "refusing cleanup: active release is not among the newest $keep: $current_target" >&2
    exit 1
  fi

  for release in "${retained[@]}"; do
    while IFS= read -r -d '' link; do
      dependency=$(readlink -f -- "$link" || true)
      case "$dependency" in
        "$releases_dir"/*)
          relative_dependency=${dependency#"$releases_dir"/}
          dependency_release="$releases_dir/${relative_dependency%%/*}"
          if ! contains "$dependency_release" "${retained[@]}"; then
            echo "refusing cleanup: retained release $release depends on $dependency_release via $link" >&2
            exit 1
          fi
          ;;
      esac
    done < <(find "$release" -mindepth 1 -maxdepth 1 -type l -print0)
  done

  echo "$releases_dir: retaining"
  printf '  %s\n' "${retained[@]}"
  echo "$releases_dir: pruning"
  printf '  %s\n' "${doomed[@]}"
  doomed_all+=("${doomed[@]}")
done

if $apply; then
  for release in "${doomed_all[@]}"; do
    case "$release" in
      /var/www/lp-terminal/releases/*|/opt/lp-terminal-indexer/releases/*|/opt/lp-terminal-executor/releases/*) ;;
      *)
        echo "refusing unexpected delete target: $release" >&2
        exit 1
        ;;
    esac
    rm -rf --one-file-system -- "$release"
  done
  echo "release pruning applied; exactly the newest $keep releases remain in each present release root"
else
  echo "dry run only; rerun with --apply after deployment health checks pass"
fi
