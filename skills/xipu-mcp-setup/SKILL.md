---
name: xipu-mcp-setup
description: Build and install the XIPU MCP macOS ARM App from its GitHub repository and register it with the user's local MCP client when the user asks to set up XIPU MCP.
---

# XIPU MCP setup

Deploy https://github.com/xyx-chn/XIPU-MCP on the user's Apple Silicon Mac (macOS 13+). This needs a local terminal and filesystem; a remote executor cannot install an App on the user's Mac.

Read the repository's [deployment instructions](https://github.com/xyx-chn/XIPU-MCP/blob/main/skills.md), or the local `skills.md` after obtaining the source. Follow its installation and verification workflow. The supported entrypoint is:

```sh
bash scripts/install.sh --client codex
```

When desktop DDL widgets were requested (macOS 14+ and full Xcode), use instead:

```sh
bash scripts/install.sh --client codex --with-widget
```

Choose `codex`, `claude-desktop`, `cursor`, or `config-only` for the current or explicitly selected client. If the target is unclear, ask which client; do not configure every client. For `config-only`, complete registration with the target client's documented mechanism before reporting MCP connected.

The installer bootstraps verified local Node, uses locked dependencies, tests and builds the App, installs in `~/Applications`, verifies nine MCP tools and safely updates the chosen client's configuration. Existing source edits, unrelated client settings and App user data must be preserved.

The two commands above are alternatives. Use `--with-widget` when the user requests desktop DDL widgets; the base App keeps macOS 13 support without Xcode. Widget mode requires full Xcode selected by `xcode-select` and its completed first-launch setup/license. Do not accept licenses for the user. The widget, native bridge and host App compile from source with automatic local ad-hoc signing; no Developer ID certificate, Team ID or notarization credentials are needed. A failed widget prerequisite/build must not be reported as a successful widget installation or silently replaced by base-only installation.

After the new App has opened once, enable the widget in its deadline page. Right-click the desktop, choose Edit Widgets and add both XIPU deadline sizes. Verify the small widget shows up to two deadlines and the medium widget up to four, manual refresh reaches the desktop, and clicking opens the App/selected deadline. The App syncs the next 30 days from all Moodle courses in Shanghai time; macOS schedules actual widget redraws. Closing the window keeps background sync; quitting the App leaves cached data. Widget enablement defaults login startup on, and the user may turn it off. Report GUI checks as pending when the current environment cannot perform them; MCP smoke success alone does not prove a desktop widget works.

Passwords, email authorization codes and school verification codes are entered by the user in the App. Do not request them in chat, read App secrets, or put them in MCP config. First login, Keychain and macOS security prompts require the user's interaction. Do not bypass platform security to finish deployment.

Report the installation path, chosen client, whether widgets were included, actual verification and any remaining login, widget-addition or reload step. Distinguish a configured client from tools actually loaded into the current conversation.
