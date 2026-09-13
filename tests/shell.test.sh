#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
home="$(mktemp -d /tmp/dotfiles-shell-test.XXXXXX)"
trap 'rm -rf "$home"' EXIT

env -i HOME="$home" PATH=/usr/bin:/bin:/usr/sbin:/sbin DOTFILES_ROOT="$root" /bin/bash --noprofile --norc <<'SH'
set -e
# Prevent shell initialization from touching actual language managers or agents.
rbenv() { :; }
go() { [[ "$2" != GOPATH ]] || printf '%s/go\n' "$HOME"; }
ssh-agent() { :; }
. "$DOTFILES_ROOT/.bashrc"
[[ "$(alias gps)" == "alias gps='git push'" ]]
if [[ "$OSTYPE" == darwin* && ( -x /opt/homebrew/bin/brew || -x /usr/local/bin/brew ) ]]; then
    command -v brew >/dev/null
    printf 'PASS: Homebrew is discoverable from a clean shell PATH\n'
fi
printf 'PASS: gps only pushes; shell initialization used isolated HOME and stubbed managers\n'
SH
