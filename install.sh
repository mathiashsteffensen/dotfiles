#!/usr/bin/env bash
set -e
shopt -s nullglob dotglob

function title() {
    echo ""
    echo "================================================================================"
    echo "$1"
    echo "================================================================================"
    echo ""
}

function section_end() {
    echo ""
    echo "================================================================================"
    echo ""
}

function link_config() {
    local source="$1"
    local target="$2"

    if [ -L "$target" ]; then
        rm "$target"
    elif [ -e "$target" ]; then
        echo "Backing up existing $target to ${target}.bak"
        mv "$target" "${target}.bak"
    fi

    echo "Linking $source -> $target"
    ln -s "$source" "$target"
}

function next_available_backup_path() {
    local requested_path="$1"
    local candidate="$requested_path"
    local suffix=1

    while [[ -e "$candidate" || -L "$candidate" ]]; do
        candidate="${requested_path}.${suffix}"
        suffix=$((suffix + 1))
    done

    printf '%s\n' "$candidate"
}

function backup_extension_entry() {
    local target="$1"
    local backup_dir="$2"
    local backup_path

    backup_path="$(next_available_backup_path "$backup_dir/$(basename "$target").bak")"
    echo "Backing up existing $target to $backup_path"
    mv "$target" "$backup_path"
}

function link_extension() {
    local source="$1"
    local target="$2"
    local backup_dir="$3"

    if [[ -L "$target" && "$(readlink "$target")" == "$source" ]]; then
        rm "$target"
    elif [[ -L "$target" || -e "$target" ]]; then
        backup_extension_entry "$target" "$backup_dir"
    fi

    echo "Linking $source -> $target"
    ln -s "$source" "$target"
}

function install_command_if_not_present() {
    local cmd_name="$1"
    local display_name="$2"
    local install_script="$3"

    if ! command -v "$cmd_name" >/dev/null 2>&1; then
        title "Installing $display_name..."
        bash -c "$install_script"
    fi
}

title "Installing development tooling..."
install_command_if_not_present "pi" "Pi" "curl -fsSL https://pi.dev/install.sh | sh"
install_command_if_not_present "brew" "Homebrew" "curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh | sh"
install_command_if_not_present "ghostty" "Ghostty" "brew install --cask ghostty"
install_command_if_not_present "go" "Go" "brew install go"
install_command_if_not_present "lazygit" "lazygit" "brew install lazygit"
install_command_if_not_present "lazysql" "lazysql" "brew install lazysql"
install_command_if_not_present "zed" "Zed" "brew install --cask zed"
section_end

DOTFILES_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

title "Installing Bash dotfiles..."
for source in "$DOTFILES_DIR"/*; do
    [[ -f "$source" ]] || continue
    [[ "$source" == *.example ]] && continue
    [[ "$source" == *.md ]] && continue
    [[ "$source" == *.sh ]] && continue

    relative="${source#"$DOTFILES_DIR"/}"
    link_config "$source" "$HOME/$relative"
done
section_end

title "Installing application configuration..."
xdg_config_dir="${XDG_CONFIG_HOME:-$HOME/.config}"
mkdir -p "$xdg_config_dir/ghostty" "$xdg_config_dir/zed"
link_config "$DOTFILES_DIR/config/ghostty/config" "$xdg_config_dir/ghostty/config"
link_config "$DOTFILES_DIR/config/zed/settings.json" "$xdg_config_dir/zed/settings.json"

# Link the shared Pi configuration into Pi's global configuration directory.
pi_config_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
pi_dotfiles_dir="$DOTFILES_DIR/config/pi/agent"
mkdir -p "$pi_config_dir"
for source in "$pi_dotfiles_dir"/*; do
    [[ -f "$source" ]] || continue

    relative="${source#"$pi_dotfiles_dir"/}"
    link_config "$source" "$pi_config_dir/$relative"
done

pi_extensions_dir="$pi_dotfiles_dir/extensions"
pi_extension_target_dir="$pi_config_dir/extensions"
pi_extension_backup_dir="$pi_config_dir/backups/extensions"
mkdir -p "$pi_extension_target_dir" "$pi_extension_backup_dir"

for source in "$pi_extensions_dir"/*; do
    [[ -f "$source" || -d "$source" ]] || continue

    relative="${source#"$pi_extensions_dir"/}"
    link_extension "$source" "$pi_extension_target_dir/$relative" "$pi_extension_backup_dir"
done
section_end

title "Done! Your configuration is linked."
echo "Open a new terminal or run: source ~/.bash_profile"
echo ""
echo "To set up local configurations:"
echo "1. Copy any .example file to remove the .example extension"
echo "2. Customize the copied file with your machine-specific settings"
echo "3. Run this script again to link the new files"
section_end
