# Dotfiles

My personal dotfiles configuration for Bash and Pi.

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

### Pi Configuration
- `config/pi/agent/settings.json` - Global Pi settings
- `config/pi/agent/models.json` - Custom Pi model providers
- `config/pi/agent/APPEND_SYSTEM.md` - Global appended system instructions
- `config/pi/agent/extensions/auto-approve/` - Custom auto-approve extension source
- `config/pi/agent/extensions/codex-usage/` - Codex subscription weekly usage status extension

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
* Go compiler
* lazygit
* lazysql
* Zed text editor

The installer also links the Pi configuration into `~/.pi/agent` (or the directory set by `PI_CODING_AGENT_DIR`). Existing regular files are backed up as `.bak` files.
This configuration includes custom extensions to:
* Run a auto-approve LLM model on all agent commands to determine wether the risk factor requires a human review (like codex and claude-code has an auto-approve mode)
* Display weekly codex subscription usage in the TUI and keep it up-to-date

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
- The install script handles backup and linking of existing files
- Machine-specific overrides are loaded automatically

## Contributing

Feel free to fork and modify for your own use. If you find improvements, PRs are welcome!

## License

MIT
