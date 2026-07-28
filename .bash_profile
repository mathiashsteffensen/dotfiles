# Load custom bashrc configuration if it exists
if [ -f ~/.bashrc ]; then
    . ~/.bashrc
fi

# Load machine-specific login-shell settings. This file is intentionally not tracked.
if [ -f ~/.bash_profile.local ]; then
    . ~/.bash_profile.local
fi
