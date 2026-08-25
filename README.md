# Dotfiles

My personal dotfiles configuration for Bash, Pi, Ghostty, and Zed.

## Overview

This repository contains my Bash configuration files and scripts to manage them across different machines. It follows the standard dotfiles pattern using symbolic links and separates machine-specific configurations from the shared ones.

## Files

### Standard Configuration Files
- `.bash_profile` - Login shell configuration
- `.bashrc` - Interactive shell configuration  
- `.bash_functions` - Custom helper functions
- `.gitconfig` - Git global configuration
- `.gitignore` - Global git ignore patterns

### Local Configuration Files (not tracked by Git)
- `.bash_profile.local` - Machine-specific login shell settings
- `.bashrc.local` - Machine-specific interactive shell settings
- `.gitconfig.local` - Machine-specific Git user settings

### Application Configuration
- `config/ghostty/config` - Ghostty terminal settings
- `config/zed/settings.json` - Zed editor settings and Pi ACP integration

### Pi Configuration
- `config/pi/agent/settings.json` - Global Pi settings
- `config/pi/agent/models.json` - Custom Pi model providers
- `config/pi/agent/APPEND_SYSTEM.md` - Global appended system instructions
- `config/pi/agent/extensions/auto-approve/` - Custom auto-approve extension source
- `config/pi/agent/extensions/codex-usage/` - Codex subscription weekly usage status extension
- `config/pi/agent/extensions/pi-openai-fast-mode/` - Priority-service configuration for supported OpenAI models

## Installation

1. Clone this repository to your home directory:
   ```bash
   cd ~
   git clone https://github.com/yourusername/dotfiles.git
   ```

2. Run the install script:
   ```bash
   cd dotfiles
   ./install.sh
   ```

3. Open a new terminal or run:
   ```bash
   source ~/.bash_profile
   ```

The installer also installs the tooling I regularly use from the terminal during my development workflow:
* Pi agent harness
* Ghostty terminal
* Go compiler
* lazygit
* lazysql
* Zed text editor
* Node.js runtime
* Pi ACP adapter

The installer links Ghostty and Zed settings under `${XDG_CONFIG_HOME:-$HOME/.config}`. It also links Pi configuration into `~/.pi/agent` (or the directory set by `PI_CODING_AGENT_DIR`). Existing files and directories are backed up as `.bak` before being replaced with symbolic links.
This configuration includes custom extensions to:
* Run an auto-approve LLM model on all agent commands to determine whether the risk factor requires human review
* Display weekly Codex subscription usage in the TUI and keep it up-to-date
* Enable priority service tiers for supported OpenAI models

## Local Configuration Management

The repository includes a helper script to manage local configurations:

```bash
./manage-local-configs.sh
```

This script explains:
- Which local files exist and which are missing
- How to create local configuration files from examples
- What kind of settings belong in each local file

To set up local configurations:
1. Copy any `.example` file to remove the `.example` extension
2. Customize the copied file with your machine-specific settings
3. Run the install script again to link the new files

## Structure

The configuration follows these conventions:
- Standard configs are tracked in Git
- Local configs are intentionally ignored by Git
- The install script handles backup and linking of existing files and directories
- Machine-specific overrides are loaded automatically

## Contributing

Feel free to fork and modify for your own use. If you find improvements, PRs are welcome!

## License

MIT
