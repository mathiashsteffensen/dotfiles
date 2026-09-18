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
- `.gitignore` - Global Git ignore patterns (installed as `~/.gitignore_global`)

### Local Configuration Files (not tracked by Git)
- `.bash_profile.local` - Machine-specific login shell settings
- `.bashrc.local` - Machine-specific interactive shell settings
- `.gitconfig.local` - Machine-specific Git user settings

### Application Configuration
- `config/ghostty/config` - Ghostty terminal settings
- `config/zed/settings.json` - Zed editor settings

### Pi Configuration
- `config/pi/agent/settings.json` - Global Pi settings
- `config/pi/agent/models.json` - Custom Pi model providers
- `config/pi/agent/APPEND_SYSTEM.md` - Global appended system instructions
- `git:github.com/DietrichGebert/ponytail@v4.9.0` - Ponytail package with always-on minimal-code guidance and six skills/commands
- `config/pi/agent/extensions/ask-user-question.ts` - Structured clarification questions with single- and multi-select support
- `config/pi/agent/extensions/auto-approve/` - Custom auto-approve extension source
- `config/pi/agent/extensions/usage-display/` - Model-aware Codex subscription and OpenRouter budget usage status
- `config/pi/agent/extensions/notify.ts` - Terminal notification when an agent settles
- `config/pi/agent/extensions/plan-mode/` - Read-only planning with an explicit tool allowlist, plus tracked execution
- `config/pi/agent/extensions/pi-openai-fast-mode/` - Priority-service configuration for supported OpenAI models
- `config/pi/agent/extensions/ui-review/` - `/ux-review`, reusable manual login state, browser screenshots, and automated axe accessibility audits
- `config/pi/agent/extensions/linear/` - Linear team and issue tools; requires `LINEAR_API_KEY`

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
* Pi agent harness
* Ghostty terminal
* Go compiler and `gopls`
* `rbenv`, `ruby-build`, and the latest stable Ruby
* Ruby LSP via RubyGems
* lazygit
* lazysql
* Zed text editor
* Node.js runtime

The installer links Ghostty and Zed settings under `${XDG_CONFIG_HOME:-$HOME/.config}`. It installs `rbenv`, `ruby-build`, and the latest stable Ruby known to `ruby-build`, then selects it as rbenv’s global default. Zed is configured to automatically install its Ruby and Terraform extensions; TypeScript and Go support are built in. The installer also installs `gopls`, `ruby-lsp`, and Zed’s Terraform extension-managed `terraform-ls`. It links Pi configuration into `~/.pi/agent` (or the directory set by `PI_CODING_AGENT_DIR`); Pi installs the pinned packages in that configuration on startup. Existing files and directories are backed up as `.bak` (or `.bak.1`, `.bak.2`, etc. when needed) before being replaced with symbolic links.

Ghostty notifications require `desktop-notifications = true` (configured here) and notifications enabled for Ghostty in macOS System Settings. To test the terminal independently of Pi, run this while Ghostty is unfocused:
```bash
sleep 3; printf '\033]777;notify;Ghostty Test;OSC 777 is working\007'
```

### Linear setup

Run `/linear-login` in an interactive Pi session. It opens [Linear Security & Access](https://linear.app/settings/account/security), prompts for the key, and stores it in macOS Keychain. The key is never stored in this repository. For manual setup, add it to the ignored `.bash_profile.local` file:

```bash
export LINEAR_API_KEY="lin_api_..."
```

Reload Pi with `/reload` after installing the extension. It provides Linear team/issue tools; mutating calls are checked by auto-approve instead of using a second confirmation prompt.

This configuration includes custom extensions to:
* Ask structured clarification questions with selectable options, free-text answers, and working multi-select support
* Classify Bash and every edit/write call with an auto-approve LLM; reading, searching, and listing files never prompt
* Display weekly Codex subscription usage or OpenRouter budget usage for the selected provider, refreshing every minute and when the agent settles
* Send a terminal notification when an agent is ready for input
* Provide read-only plan mode limited to already-active `read`, `grep`, `find`, `ls`, and `ask_user_question` tools; shells, subagents, and other tools are blocked
* Enable priority service tiers for supported OpenAI models
* Review rendered web UIs with screenshots and automated axe accessibility audits
* Apply Ponytail’s minimal-code guidance and provide its six skills/commands

## Pi Usage Budget

The usage footer switches automatically with the selected model: Codex shows weekly subscription usage; OpenRouter shows the API key's spend against a configurable USD budget. Other providers hide the status.

Edit `config/pi/agent/extensions/usage-display/config.json` (linked to `~/.pi/agent/extensions/usage-display/config.json`):

```json
{
  "openrouter": {
    "limit": 50,
    "period": "monthly"
  }
}
```

`limit` must be a positive number; `period` accepts `daily`, `weekly`, or `monthly`. Each is the current UTC calendar period (weeks run Monday–Sunday), not a rolling window. Changes take effect on the next refresh. This is a display-only budget, not a change to OpenRouter's enforced API-key limit. Percentages can exceed 100% if you exceed the configured display budget.

Usage comes from OpenRouter's [current-key endpoint](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key), using Pi's existing OpenRouter credentials. It includes all OpenRouter-credit spending on that key, not just this Pi session, plus BYOK spending when the key's `include_byok_in_limit` setting is enabled. Missing usage or request/configuration errors show `unavailable` rather than 0%.

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
