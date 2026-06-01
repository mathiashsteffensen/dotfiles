# Ensure colors are enabled
export CLICOLOR=1
export LSCOLORS=ExFxBxDxCxegedabagacad

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
alias gps="gss && gp && gsp"
alias gd="git diff --cached ."
alias gc="git commit -v"
alias gca="git commit -v -a"
alias gcm="git commit -m"
alias gb="git branch --color"
alias gbd="git branch -D"
alias gba="git branch -a"
alias gco="git checkout"
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
export PATH="$(go env GOPATH)/bin:$HOME/bin:$HOME/.local/bin:/usr/local/bin:$PATH"
export EDITOR="nano"

# Start SSH Agent
eval "$(ssh-agent -s)" &> /dev/null
