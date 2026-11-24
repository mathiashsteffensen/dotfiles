# Ensure colors are enabled
export CLICOLOR=1
export LSCOLORS=ExFxBxDxCxegedabagacad

[ "$TERM" = xterm-ghostty ] && export TERM=xterm-256color

# Load custom helper functions if they exist
if [ -f ~/.bash_functions ]; then
    . ~/.bash_functions
fi

parse_git_branch() {
    local branch
    branch=$(git symbolic-ref --short HEAD 2>/dev/null || git rev-parse --short HEAD 2>/dev/null)
    if [ -n "$branch" ]; then
        echo " ($branch)"
    fi
}

# Single quotes are critical here so parse_git_branch runs every time the prompt redraws
export PS1='\[\e[1;34m\]\w\[\e[1;30m\]$(parse_git_branch)\[\e[0m\] \$ '

# ------------------------------------------------------------------------------
#  Git Aliases
# ------------------------------------------------------------------------------
alias lg="lazygit"
alias gst="git status"
alias gl="git pull --rebase"
alias gp="git push"
alias gpf="git push -f"
alias gps="git push"
alias gd="git diff --cached ."
alias gc="git commit -v"
alias gca="git commit -v -a"
alias gcm="git commit -m"
alias gb="git branch --color"
alias gbd="git branch -D"
alias gba="git branch -a"
gco() {
    if [ "$#" -eq 1 ] && [[ "$1" != -* ]]; then
        local target="$1"
        if git show-ref --verify --quiet "refs/heads/$target" ||
           [ -n "$(git for-each-ref --format='%(refname)' "refs/remotes/*/$target" 2>/dev/null)" ] ||
           git rev-parse --verify --quiet "$target^{commit}" >/dev/null ||
           [ -e "$target" ] ||
           git ls-files --error-unmatch -- "$target" >/dev/null 2>&1; then
            git checkout "$target"
        else
            git checkout -b "$target"
        fi
    else
        git checkout "$@"
    fi
}
alias gr="git rebase"
alias gra="gr --abort"
alias grc="gr --continue"
alias grm="gr master"
alias gss="git stash save"
alias gsp="git stash pop"
alias gpu="git push -u origin"
alias grh="git reset HEAD~1"
alias grs="git restore --staged"

# ------------------------------------------------------------------------------
#  Standard Command Aliases & Safe Guards
# ------------------------------------------------------------------------------
# GNU ls ignores CLICOLOR and LSCOLORS above; only macOS's BSD ls reads them.
if [[ "$OSTYPE" == linux* ]]; then
    alias ls='ls --color=auto'
fi
alias ll='ls -lah'
alias la='ls -A'
alias l='ls -CF'
alias ..='cd ..'
alias ...='cd ../..'
alias mv='mv -i'
alias cp='cp -i'

# ------------------------------------------------------------------------------
#  Environment Path Setup
# ------------------------------------------------------------------------------
for brew_prefix in /opt/homebrew /usr/local /home/linuxbrew/.linuxbrew; do
    if [[ -x "$brew_prefix/bin/brew" ]]; then
        eval "$("$brew_prefix/bin/brew" shellenv)"
        break
    fi
done
unset brew_prefix
if command -v rbenv >/dev/null 2>&1; then
    eval "$(rbenv init - --no-rehash bash)"
fi
if command -v go >/dev/null 2>&1; then
    go_path="$(go env GOPATH)"
    go_bin_dir="$(go env GOBIN)"
    if [ -z "$go_bin_dir" ]; then
        go_bin_dir="$go_path/bin"
    fi
    export PATH="$go_bin_dir:$go_path/bin:$HOME/bin:$HOME/.local/bin:/usr/local/bin:$PATH"
else
    export PATH="$HOME/bin:$HOME/.local/bin:/usr/local/bin:$PATH"
fi
export PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$PATH"
if command -v zed >/dev/null 2>&1; then
    export EDITOR="zed --wait"
else
    export EDITOR="nvim"
fi
export VISUAL="$EDITOR"

# ssh-add exits 1 for a reachable agent with no identities and 2 when unreachable.
ssh_agent_unreachable() {
    ssh-add -l >/dev/null 2>&1
    [ $? -eq 2 ]
}

# Without a session agent, share one agent at a fixed socket, so new shells do not
# each start an agent that outlives them.
if command -v ssh-agent >/dev/null 2>&1 && ssh_agent_unreachable; then
    [ -d "$HOME/.ssh" ] || mkdir -m 700 "$HOME/.ssh"
    export SSH_AUTH_SOCK="$HOME/.ssh/agent.sock"
    if ssh_agent_unreachable; then
        rm -f "$SSH_AUTH_SOCK"
        eval "$(ssh-agent -s -a "$SSH_AUTH_SOCK")" >/dev/null
    fi
fi
unset -f ssh_agent_unreachable

# Load machine-specific shell settings. This file is intentionally not tracked.
if [ -f ~/.bashrc.local ]; then
    . ~/.bashrc.local
fi
