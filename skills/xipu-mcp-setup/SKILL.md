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

Choose `codex`, `claude-desktop`, `cursor`, or `config-only` for the current or explicitly selected client. If the target is unclear, ask which client; do not configure every client. For `config-only`, complete registration with the target client's documented mechanism before reporting MCP connected.

The installer bootstraps verified local Node, uses locked dependencies, tests and builds the App, installs in `~/Applications`, verifies nine MCP tools and safely updates the chosen client's configuration. Existing source edits, unrelated client settings and App user data must be preserved.

Passwords, email authorization codes and school verification codes are entered by the user in the App. Do not request them in chat, read App secrets, or put them in MCP config. First login, Keychain and macOS security prompts require the user's interaction. Do not bypass platform security to finish deployment.

Report the installation path, chosen client, actual verification and any remaining login or reload step. Distinguish a configured client from tools actually loaded into the current conversation.
