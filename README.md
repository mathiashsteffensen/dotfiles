# Dotfiles

My personal dotfiles configuration for Bash, Crush, Ghostty, Kero, Zed, and Neovim.

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
- `config/kero/config` - Kero terminal settings
- `config/zed/settings.json` - Zed editor settings
- `config/nvim/` - Neovim settings and pinned plugin versions

### Crush Configuration

- `config/crush/crush.json` - Default OpenAI ChatGPT model and sandbox-only tool configuration
- `config/crush/sandbox.mjs` - macOS sandbox MCP extension with independent escalation review

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

- [Crush coding harness](https://github.com/charmbracelet/crush)
- Ghostty and Kero terminals
- Go compiler and `gopls`
- `rbenv`, `ruby-build`, and the latest stable Ruby
- Ruby LSP via RubyGems
- lazygit
- lazysql
- Zed and Neovim text editors
- Node.js runtime
- Neovim language servers for JavaScript/TypeScript, Terraform, Dockerfiles, HTML/CSS/JSON, YAML, and Helm
- Terraform and Helm CLIs, Prettier, and ripgrep

The installer links Ghostty, Kero, Zed, and Neovim settings under `${XDG_CONFIG_HOME:-$HOME/.config}`. It installs `rbenv`, `ruby-build`, and the latest stable Ruby known to `ruby-build`, then selects it as rbenv’s global default. Zed is configured to automatically install its Ruby and Terraform extensions; TypeScript and Go support are built in. The installer also installs `gopls`, `ruby-lsp`, RuboCop, and a standalone `terraform-ls` for Neovim. Existing files and directories are backed up as `.bak` (or `.bak.1`, `.bak.2`, etc. when needed) before being replaced with symbolic links.

Kero's configuration enables a Tailscale listener on port 7373. By default, Kero permits connections from the Tailscale user who owns the machine; authorized connections can run programs as the local account.

When Crush is missing, the installer uses the official Homebrew tap, then links the global Crush config and sandbox extension under `${CRUSH_GLOBAL_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/crush}`. The config selects `gpt-6-astra` through the OpenAI/ChatGPT provider. After installation, sign in with `crush login openai` to use a ChatGPT subscription for the main agent. The installer removes only symlinks created by the previous OMP setup and preserves independent configuration and backups.

### Sandbox and automatic escalation review

Requires macOS, `/usr/bin/sandbox-exec`, and Node.js 22 or newer. Launch Crush from a trusted project directory, not your home directory. The `sandbox` MCP extension replaces host filesystem, shell, web, subagent and LSP tools with one sandboxed `execute` tool. Automatic LSP discovery is disabled. No extension dependencies are needed. The previous `crushout` hook is no longer registered.

Routine commands run without review, can write within the initial project directory and a private temporary directory, and cannot use the network. Child commands inherit Seatbelt restrictions. Standard configuration paths, Git metadata, agent instructions and extension code cannot be written. Commands receive a minimal environment without API keys, and HOME points to private scratch space. Commands time out after 60 seconds by default (maximum 300); output is bounded and background descendants are killed on completion. Failed commands are never automatically retried because they may already have produced side effects.

An explicit `escalation` can request network access or additional absolute writable roots. Only this exact call is reviewed, with its command, cwd, requested capabilities and a trusted intent supplied when starting Crush. Network grants permit arbitrary destinations, not a domain allowlist. Escalation never disables Seatbelt. Only low/medium-risk approvals execute. Denials, malformed responses, missing credentials, review timeouts and audit failures block execution. Three consecutive denials or ten denials in the last fifty reviews stop further escalations until the MCP session restarts. Routine sandboxed work remains available.

The reviewer defaults to **`openai/gpt-6-luna` through your existing Crush subscription login**. No separate API key or endpoint is needed. Each review runs a fresh, tool-free local Crush process with isolated workspace/configuration and the original global OAuth store, preserving Crush's cross-process token refresh locking. It does not reuse the main agent session or recursively start the sandbox MCP server. Shared machine/system configuration containing hooks, MCP or LSP entries is rejected rather than inherited unsafely.

```bash
crush login openai
export CRUSH_REVIEW_INTENT='Run the project tests and download missing public dependencies; do not upload project data.'
crush
```

`CRUSH_REVIEW_INTENT` is optional: without it the reviewer permits only routine, non-destructive development work and has no authorization for uploads of private data, credentials, publishing, deployment or security changes. Set `CRUSH_REVIEW_MODEL=provider/model` to override Luna, or `CRUSH_REVIEW_BIN` to choose a Crush executable. Review calls consume subscription usage; authentication/model errors and the 45-second deadline block escalation. The reviewer receives the proposed command, so do not include secrets in command text. Crush also receives that prompt as a process argument. The reviewer has no tools or conversation transcript; trusted intent remains fixed for the MCP session. Temporary reviewer workspace/session files are removed after each call.

An optional separate API backend remains available: setting `CRUSH_REVIEW_URL` selects a complete HTTPS OpenAI-compatible Chat Completions endpoint and then requires `CRUSH_REVIEW_MODEL`, `CRUSH_REVIEW_API_KEY` and `CRUSH_REVIEW_INTENT`. That backend requires JSON response format and temperature 0. Keep keys out of tracked files. Reviewer environment variables are not passed to sandboxed commands.

Review records contain timestamps, request hashes, risk and rationale, not raw commands. They are stored in `${XDG_STATE_HOME:-$HOME/.local/state}/crush-sandbox/` with private permissions. Scratch directories remain in the system temporary directory after exit; do not use them for durable storage. There is no automatic human override or desktop-style review panel; denied calls report a reason to Crush.

**Security boundary:** this contains extension-launched commands, not the Crush host process. File reads are broadly permitted for runtime compatibility, with standard SSH, AWS, GPG, Keychain and Crush credential directories denied; this is not comprehensive secret isolation. Repository `.env` files and credentials outside those standard paths can still be readable. Network escalation can expose readable data if the reviewer misjudges a command. LLM approval is not a security guarantee. Only open trusted projects: Crush loads project configuration and context before this extension runs. Additional MCP servers, explicit LSP configurations, project overrides, hooks or newly added built-in tools can bypass the intended tool restriction and must be audited. This configuration targets Crush v0.97.1; inspect effective tools after upgrades. It is deliberately not presented as a full port of Codex's host-integrated security boundary.

Run the regression checks with:

```bash
node --test tests/crush-sandbox.test.mjs
bash tests/shell.test.sh
bash -n install.sh
```

The Node suite includes real macOS sandbox checks for writes, symlinks, descendants, network denial, protected paths and timeouts, plus broker/MCP tests. On other platforms the real sandbox tests are skipped and the extension refuses to start.

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
