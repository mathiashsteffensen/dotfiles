# Dotfiles

My personal dotfiles configuration for Bash, omp, Ghostty, Zed, and Neovim.

## Overview

This repository contains my Bash configuration files and scripts to manage them across different machines. It follows the standard dotfiles pattern using symbolic links and separates machine-specific configurations from the shared ones.

## Files

### Standard Configuration Files

- `.bash_profile` - Login shell configuration
- `.bashrc` - Interactive shell configuration
- `.bash_functions` - Custom helper functions
- `.gitconfig` - Git global configuration
- `.gitignore` - Global Git ignore patterns (installed as `~/.gitignore_global`)

### Local Configuration Files (not tracked by Git)

- `.bash_profile.local` - Machine-specific login shell settings
- `.bashrc.local` - Machine-specific interactive shell settings
- `.gitconfig.local` - Machine-specific Git user settings

### Application Configuration

- `config/ghostty/config` - Ghostty terminal settings
- `config/zed/settings.json` - Zed editor settings
- `config/nvim/` - Neovim settings and pinned plugin versions

### omp Configuration

- `config/omp/agent/config.yml` - Native omp settings: Codex default model, thinking level, theme, and extension status visibility
- `config/omp/agent/extensions/usage-display/index.ts` - Weekly Codex subscription usage in the footer

## Installation

1. Clone this repository to your home directory:

   ```bash
   cd ~
   git clone git@github.com:mathiashsteffensen/dotfiles.git
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

- [omp agent harness](https://omp.sh/)
- Ghostty terminal
- Go compiler and `gopls`
- `rbenv`, `ruby-build`, and the latest stable Ruby
- Ruby LSP via RubyGems
- lazygit
- lazysql
- Zed and Neovim text editors
- Node.js runtime
- Neovim language servers for JavaScript/TypeScript, Terraform, Dockerfiles, HTML/CSS/JSON, YAML, and Helm
- Terraform and Helm CLIs, Prettier, and ripgrep

The installer links Ghostty, Zed, and Neovim settings under `${XDG_CONFIG_HOME:-$HOME/.config}`. It installs `rbenv`, `ruby-build`, and the latest stable Ruby known to `ruby-build`, then selects it as rbenv’s global default. Zed is configured to automatically install its Ruby and Terraform extensions; TypeScript and Go support are built in. The installer also installs `gopls`, `ruby-lsp`, RuboCop, and a standalone `terraform-ls` for Neovim. Existing files and directories are backed up as `.bak` (or `.bak.1`, `.bak.2`, etc. when needed) before being replaced with symbolic links.

When `omp` is missing, the installer uses the [official installer](https://omp.sh/): `curl -fsSL https://omp.sh/install | sh`. It uses an existing Bun installation when available; otherwise it installs a standalone binary. The shell adds `${PI_INSTALL_DIR:-$HOME/.local/bin}` and `${BUN_INSTALL:-$HOME/.bun}/bin` to `PATH`.

omp configuration is linked into `~/.omp/agent` (or `PI_CODING_AGENT_DIR` when set). The installer links `config.yml` and merges the tracked extension into `extensions/`, preserving unrelated local extensions. Replaced extension entries are backed up under the agent directory's `backups/extensions/`, outside extension discovery. No extension package installation is needed.

### Neovim

Run `nvim .` from a project directory. Zed remains installed and is still the shell/Git default editor. Neovim uses [Ayu Dark](https://github.com/Shatur/neovim-ayu), matching Zed's theme; font and font size come from Ghostty.

Requires Neovim 0.11.3+ and TypeScript 7+ (which includes the native `tsc --lsp` server). The installer adds missing tools but does not upgrade existing ones; use `brew upgrade neovim typescript` if needed. On first launch, [lazy.nvim](https://lazy.folke.io/) downloads the plugins; this needs internet access. Plugin revisions are tracked in `config/nvim/lazy-lock.json`. Use `:Lazy restore` after pulling changes to restore those revisions, or `:Lazy update` to deliberately update them and the lockfile.

Language support uses Neovim's built-in LSP client with [nvim-lspconfig](https://github.com/neovim/nvim-lspconfig), Blink completion, and [Conform](https://github.com/stevearc/conform.nvim) for format-on-save:

| Language                            | Language server              | Save formatter                      |
| ----------------------------------- | ---------------------------- | ----------------------------------- |
| Ruby                                | `ruby-lsp` + `rubocop --lsp` | RuboCop safe autocorrection         |
| Go                                  | `gopls`                      | `gofmt`                             |
| JavaScript / TypeScript / JSX / TSX | TypeScript 7's native `tsc`  | Prettier                            |
| Terraform                           | `terraform-ls`               | `terraform fmt`                     |
| Dockerfile                          | `docker-langserver`          | None                                |
| HTML / CSS / JSON                   | VS Code language servers     | Prettier                            |
| YAML / Helm values                  | `yaml-language-server`       | Prettier                            |
| Helm templates                      | `helm_ls`                    | Disabled to protect template syntax |

Ruby executables come from the active rbenv version, without a `bundle exec` wrapper, matching Zed's launch behavior. Install `ruby-lsp` and `rubocop` for each Ruby version you use. Ruby LSP can manage its own bundle internally. RuboCop alone owns Ruby linting and save formatting to avoid duplicate diagnostics/formatters. Prettier prefers a project's local installation when available. Helm file associations preserve Zed's `templates/**/*.tpl`, `templates/**/*.yaml`, and `templates/**/*.yml` patterns.

Core Vim motions and editing commands are retained. These shortcuts add IDE features (`Space` is the leader):

| Keys                                      | Action                                                      |
| ----------------------------------------- | ----------------------------------------------------------- |
| `Space ff` / `Space fg` / `Space fb`      | Find files / search project text / switch buffers           |
| `gd` / `gr` / `K`                         | Definition / references / documentation (with LSP attached) |
| `Space rn` / `Space ca`                   | Rename symbol / code action                                 |
| `Space e` / `[d` / `]d`                   | Diagnostic details / previous / next diagnostic             |
| `Ctrl-n` / `Ctrl-p` / `Ctrl-y` / `Ctrl-e` | Next / previous / accept / dismiss completion               |

Searches use the current working directory, so launch Neovim from the project root. `:Explore` opens the built-in file browser. `:Tutor` starts the interactive Vim tutorial; `:checkhealth vim.lsp` and `:ConformInfo` diagnose language servers and formatters. No Nerd Font, tmux, or GUI is required. Filetype syntax highlighting uses Neovim's runtime plus `vim-helm`; there is no Treesitter parser installation to maintain.

## Local Configuration Management

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
