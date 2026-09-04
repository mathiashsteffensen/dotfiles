#!/usr/bin/env bash
set -e
set -o pipefail
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

    if [[ -L "$target" && "$(readlink "$target")" == "$source" ]]; then
        rm "$target"
    elif [[ -L "$target" || -e "$target" ]]; then
        local backup_path
        backup_path="$(next_available_backup_path "${target}.bak")"
        echo "Backing up existing $target to $backup_path"
        mv "$target" "$backup_path"
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

function is_generated_extension_entry() {
    local name
    name="$(basename "$1")"
    [[ "$name" == "node_modules" || "$name" == results.log* ]]
}

function link_extension_directory() {
    local source="$1"
    local target="$2"
    local backup_dir="$3"
    local source_entry
    local target_entry

    if [[ -L "$target" && "$(readlink "$target")" == "$source" ]]; then
        # Migrate directory symlinks created by older installer versions.
        rm "$target"
    elif [[ -L "$target" || ( -e "$target" && ! -d "$target" ) ]]; then
        backup_extension_entry "$target" "$(dirname "$backup_dir")"
    fi

    mkdir -p "$target" "$backup_dir"

    for source_entry in "$source"/*; do
        is_generated_extension_entry "$source_entry" && continue

        target_entry="$target/$(basename "$source_entry")"
        if [[ -d "$source_entry" && ! -L "$source_entry" ]]; then
            link_extension_directory "$source_entry" "$target_entry" "$backup_dir/$(basename "$source_entry")"
        else
            link_extension "$source_entry" "$target_entry" "$backup_dir"
        fi
    done
}

function install_command_if_not_present() {
    local cmd_name="$1"
    local display_name="$2"
    local install_script="$3"

    if ! command -v "$cmd_name" >/dev/null 2>&1; then
        title "Installing $display_name..."
        bash -o pipefail -c "$install_script"
    fi
}

function initialize_homebrew() {
    local brew_prefix

    if ! command -v brew >/dev/null 2>&1; then
        for brew_prefix in /opt/homebrew /usr/local; do
            if [[ -x "$brew_prefix/bin/brew" ]]; then
                export PATH="$brew_prefix/bin:$PATH"
                break
            fi
        done
    fi

    if command -v brew >/dev/null 2>&1; then
        eval "$(brew shellenv)"
    fi
}

function install_go_tool_if_not_present() {
    local cmd_name="$1"
    local module="$2"
    local go_bin_dir

    go_bin_dir="$(go env GOBIN)"
    if [[ -z "$go_bin_dir" ]]; then
        go_bin_dir="$(go env GOPATH)/bin"
    fi

    if [[ ! -x "$go_bin_dir/$cmd_name" ]]; then
        title "Installing $cmd_name..."
        go install "$module"
    fi
}

function install_ruby_gem_if_not_present() {
    local gem_name="$1"
    local installed_gems

    installed_gems="$(gem list --local --exact "$gem_name" 2>/dev/null)"
    if [[ "$installed_gems" != "$gem_name ("* ]]; then
        title "Installing $gem_name..."
        gem install "$gem_name" --no-document
    fi
}

function install_latest_ruby_if_not_present() {
    local latest_ruby
    local rbenv_root

    latest_ruby="$(rbenv install -l | awk '$0 ~ /^[0-9]+\.[0-9]+\.[0-9]+$/ { print }' | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)"
    if [[ -z "$latest_ruby" ]]; then
        echo "Could not determine the latest Ruby version from ruby-build."
        return 1
    fi

    rbenv_root="$(rbenv root)"
    if [[ ! -d "$rbenv_root/versions/$latest_ruby" ]]; then
        title "Installing Ruby $latest_ruby..."
        rbenv install "$latest_ruby"
    fi

    rbenv global "$latest_ruby"
}

title "Installing development tooling..."
install_command_if_not_present "pi" "Pi" "curl -fsSL https://pi.dev/install.sh | sh"
initialize_homebrew
install_command_if_not_present "brew" "Homebrew" "curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh | sh"
initialize_homebrew
install_command_if_not_present "ghostty" "Ghostty" "brew install --cask ghostty"
install_command_if_not_present "go" "Go" "brew install go"
install_command_if_not_present "node" "Node.js" "brew install node"
install_go_tool_if_not_present "gopls" "golang.org/x/tools/gopls@latest"
install_command_if_not_present "rbenv" "rbenv" "brew install rbenv"
install_command_if_not_present "ruby-build" "ruby-build" "brew install ruby-build"
eval "$(rbenv init - --no-rehash bash)"
install_latest_ruby_if_not_present
if command -v gem >/dev/null 2>&1 && ruby -rrubygems -e 'abort if Gem::Version.new(RUBY_VERSION) < Gem::Version.new("3.0")'; then
    install_ruby_gem_if_not_present "ruby-lsp"
    install_ruby_gem_if_not_present "rubocop"
elif command -v gem >/dev/null 2>&1; then
    echo "Skipping ruby-lsp: Ruby 3.0 or newer is required."
else
    echo "Skipping ruby-lsp: RubyGems is not installed."
fi
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
    if [[ "$relative" == ".gitignore" ]]; then
        target="$HOME/.gitignore_global"
    else
        target="$HOME/$relative"
    fi
    link_config "$source" "$target"
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
    is_generated_extension_entry "$source" && continue

    relative="${source#"$pi_extensions_dir"/}"
    if [[ -d "$source" && ! -L "$source" ]]; then
        if [[ -f "$source/package.json" ]]; then
            echo "Installing dependencies for Pi extension $relative..."
            npm install --prefix "$source"
        fi
        link_extension_directory "$source" "$pi_extension_target_dir/$relative" "$pi_extension_backup_dir/$relative"
        if [[ -d "$source/node_modules" ]]; then
            link_extension "$source/node_modules" "$pi_extension_target_dir/$relative/node_modules" "$pi_extension_backup_dir/$relative"
        fi
    else
        link_extension "$source" "$pi_extension_target_dir/$relative" "$pi_extension_backup_dir"
    fi
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
