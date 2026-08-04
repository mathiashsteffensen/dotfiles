#!/bin/bash

# Get the directory of this script
DOTFILES_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# List of files to symlink in the home directory (no Zsh, only Bash!)
files=(".bash_profile" ".bashrc" ".bash_functions" ".gitconfig" ".gitignore")
local_files=(".bash_profile.local" ".bashrc.local" ".gitconfig.local")

echo "========================================"
echo "Installing Bash-only dotfiles..."
echo "========================================"

for file in "${files[@]}"; do
    target="$HOME/$file"
    source="$DOTFILES_DIR/$file"
    
    # If the file already exists in home, back it up first
    if [ -f "$target" ] && [ ! -L "$target" ]; then
        echo "Backing up existing $file to ${target}.bak"
        mv "$target" "${target}.bak"
    fi
    
    # Create the symbolic link
    echo "Linking $source -> $target"
    ln -sf "$source" "$target"
done

# Link machine-specific overrides only when they exist in this checkout.
# They are ignored by Git, so local changes never appear in git diff.
for file in "${local_files[@]}"; do
    target="$HOME/$file"
    source="$DOTFILES_DIR/$file"

    if [ ! -f "$source" ]; then
        echo "Local override $file not found (this is normal)"
        continue
    fi

    if [ -f "$target" ] && [ ! -L "$target" ]; then
        echo "Backing up existing $file to ${target}.bak"
        mv "$target" "${target}.bak"
    fi

    echo "Linking local override $source -> $target"
    ln -sf "$source" "$target"
done

echo "========================================"
echo "Done! Your Bash environment is linked."
echo "Open a new terminal or run: source ~/.bash_profile"
echo ""
echo "Local configuration files:"
echo "- .bash_profile.local (for login shell settings)"
echo "- .bashrc.local (for interactive shell settings)"
echo "- .gitconfig.local (for Git user settings)"
echo ""
echo "To manage local configurations:"
echo "- Run './manage-local-configs.sh' for help and guidance"
echo ""
echo "To set up local configurations:"
echo "1. Copy any .example file to remove the .example extension"
echo "2. Customize the copied file with your machine-specific settings"
echo "3. Run this script again to link the new files"
echo "========================================"
