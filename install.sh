#!/bin/bash

# Get the directory of this script
DOTFILES_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# List of files to symlink in the home directory (no Zsh, only Bash!)
files=(".bash_profile" ".bashrc" ".bash_functions" ".gitconfig" ".gitignore")
local_files=(".bash_profile.local" ".bashrc.local" ".gitconfig.local")
pi_config_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
pi_files=("APPEND_SYSTEM.md" "models.json" "settings.json")
pi_extension_source="$DOTFILES_DIR/config/pi/agent/extensions/auto-approve"

echo "========================================"
echo "Installing Bash dotfiles and Pi configuration..."
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

# Link the shared Pi configuration into Pi's global configuration directory.
mkdir -p "$pi_config_dir"
for file in "${pi_files[@]}"; do
    target="$pi_config_dir/$file"
    source="$DOTFILES_DIR/config/pi/agent/$file"

    if [ -f "$target" ] && [ ! -L "$target" ]; then
        echo "Backing up existing Pi config $file to ${target}.bak"
        mv "$target" "${target}.bak"
    elif [ -e "$target" ] && [ ! -L "$target" ]; then
        echo "Error: Pi config target is not a regular file: $target" >&2
        exit 1
    fi

    echo "Linking $source -> $target"
    if ! ln -sf "$source" "$target"; then
        echo "Error: failed to link Pi config $file" >&2
        exit 1
    fi
done

# Link the custom auto-approve extension into Pi's extensions directory.
pi_extension_target="$pi_config_dir/extensions/auto-approve"
mkdir -p "$(dirname "$pi_extension_target")"
if [ -L "$pi_extension_target" ]; then
    rm "$pi_extension_target"
elif [ -e "$pi_extension_target" ]; then
    echo "Backing up existing Pi extension to ${pi_extension_target}.bak"
    mv "$pi_extension_target" "${pi_extension_target}.bak"
fi

echo "Linking $pi_extension_source -> $pi_extension_target"
ln -s "$pi_extension_source" "$pi_extension_target"

echo "========================================"
echo "Done! Your Bash environment and Pi configuration are linked."
echo "Open a new terminal or run: source ~/.bash_profile"
echo ""
echo "Local configuration files:"
echo "- .bash_profile.local (for login shell settings)"
echo "- .bashrc.local (for interactive shell settings)"
echo "- .gitconfig.local (for Git user settings)"
echo ""
echo "Pi configuration:"
echo "- $pi_config_dir/settings.json"
echo "- $pi_config_dir/models.json"
echo "- $pi_config_dir/APPEND_SYSTEM.md"
echo "- $pi_extension_target"
echo ""
echo "To manage local configurations:"
echo "- Run './manage-local-configs.sh' for help and guidance"
echo ""
echo "To set up local configurations:"
echo "1. Copy any .example file to remove the .example extension"
echo "2. Customize the copied file with your machine-specific settings"
echo "3. Run this script again to link the new files"
echo "========================================"
