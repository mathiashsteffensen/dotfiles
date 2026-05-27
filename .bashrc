# ==============================================================================
#  Julia's Custom Bash Configuration
# ==============================================================================

# Ensure colors are enabled
export CLICOLOR=1
export LSCOLORS=ExFxBxDxCxegedabagacad

# Define nice colors for prompt
COLOR_GREEN='\[\033[01;32m\]'
COLOR_BLUE='\[\033[01;34m\]'
COLOR_RED='\[\033[01;31m\]'
COLOR_RESET='\[\033[00m\]'

# Simple, informative prompt: user@host:cwd$
PS1="${COLOR_GREEN}\u@\h${COLOR_RESET}:${COLOR_BLUE}\w${COLOR_RESET}\$ "

# Navigation & Listing Aliases
alias ll='ls -lah'
alias la='ls -A'
alias l='ls -CF'
alias ..='cd ..'
alias ...='cd ../..'

# Git Aliases (clean and fast)
alias gs='git status'
alias gd='git diff'
alias gl="git log --graph --pretty=format:'%Cred%h%Creset -%C(yellow)%d%Creset %s %Cgreen(%cr) %C(bold blue)<%an>%Creset' --abbrev-commit -n 10"
alias gp='git push'
alias gco='git checkout'
alias gcb='git checkout -b'
alias gcm='git checkout main || git checkout master'
alias gpl='git pull'

# Safe file operations
alias mv='mv -i'
alias cp='cp -i'

# Ensure standard local binary paths are in environment
export PATH="$HOME/bin:$HOME/.local/bin:/usr/local/bin:$PATH"

# Editor preference
export EDITOR="nano"
