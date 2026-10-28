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

function remove_managed_link() {
    local source="$1"
    local target="$2"

    if [[ -L "$target" && "$(readlink "$target")" == "$source" ]]; then
        echo "Removing retired dotfile link $target"
        rm "$target"
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
export PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$PATH"
initialize_homebrew
install_command_if_not_present "brew" "Homebrew" "curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh | sh"
initialize_homebrew
install_command_if_not_present "crush" "Crush" "brew install charmbracelet/tap/crush"
install_command_if_not_present "ghostty" "Ghostty" "brew install --cask ghostty"
install_command_if_not_present "kero" "Kero" "brew install --cask kero"
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
install_command_if_not_present "nvim" "Neovim" "brew install neovim"
install_command_if_not_present "shellcheck" "ShellCheck" "brew install shellcheck"
install_command_if_not_present "bash-language-server" "Bash language server" "brew install bash-language-server"
install_command_if_not_present "rg" "ripgrep" "brew install ripgrep"
install_command_if_not_present "tsc" "TypeScript (with native language server)" "brew install typescript"
install_command_if_not_present "terraform" "Terraform" "brew install hashicorp/tap/terraform"
install_command_if_not_present "terraform-ls" "Terraform language server" "brew install terraform-ls"
install_command_if_not_present "docker-langserver" "Dockerfile language server" "brew install dockerfile-language-server"
install_command_if_not_present "vscode-html-language-server" "HTML, CSS, and JSON language servers" "brew install vscode-langservers-extracted"
install_command_if_not_present "yaml-language-server" "YAML language server" "brew install yaml-language-server"
install_command_if_not_present "helm" "Helm" "brew install helm"
install_command_if_not_present "helm_ls" "Helm language server" "brew install helm-ls"
install_command_if_not_present "prettier" "Prettier" "brew install prettier"
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
crush_config_dir="${CRUSH_GLOBAL_CONFIG:-$xdg_config_dir/crush}"
mkdir -p "$xdg_config_dir/ghostty" "$xdg_config_dir/kero" "$xdg_config_dir/zed" "$crush_config_dir"
link_config "$DOTFILES_DIR/config/ghostty/config" "$xdg_config_dir/ghostty/config"
link_config "$DOTFILES_DIR/config/kero/config" "$xdg_config_dir/kero/config"
link_config "$DOTFILES_DIR/config/zed/settings.json" "$xdg_config_dir/zed/settings.json"
link_config "$DOTFILES_DIR/config/nvim" "$xdg_config_dir/nvim"

# Remove only symlinks created by the previous OMP dotfile setup. Preserve
# independent user configs and all backups.
legacy_omp_dir="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"
remove_managed_link "$DOTFILES_DIR/config/omp/agent/config.yml" "$legacy_omp_dir/config.yml"
remove_managed_link "$DOTFILES_DIR/config/omp/agent/config.yml.lock" "$legacy_omp_dir/config.yml.lock"
remove_managed_link "$DOTFILES_DIR/config/omp/agent/extensions/usage-display/index.ts" \
    "$legacy_omp_dir/extensions/usage-display/index.ts"

link_config "$DOTFILES_DIR/config/crush/crush.json" "$crush_config_dir/crush.json"
link_config "$DOTFILES_DIR/config/crush/sandbox.mjs" "$crush_config_dir/sandbox.mjs"
section_end

title "Done! Your configuration is linked."
echo "Open a new terminal or run: source ~/.bash_profile"
echo ""
echo "To set up local configurations:"
echo "1. Copy any .example file to remove the .example extension"
echo "2. Customize the copied file with your machine-specific settings"
echo "3. Run this script again to link the new files"
section_end
