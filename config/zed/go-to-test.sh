#!/usr/bin/env bash
set -euo pipefail

case "${ZED_FILE:-}" in
    *_test.go|*/specs/*_test.rb) exit 0 ;;
    *.go) target="${ZED_FILE%.go}_test.go" ;;
    *.rb)
        relative="${ZED_RELATIVE_FILE:-}"
        case "$relative" in
            app/*|lib/*)
                relative="${relative#*/}"
                target="$ZED_WORKTREE_ROOT/specs/${relative%.rb}_test.rb"
                ;;
            *) exit 0 ;;
        esac
        ;;
    *) exit 0 ;;
esac

zed --existing "$target"
