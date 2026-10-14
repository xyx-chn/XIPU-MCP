# 让 AI 在本机部署 XIPU MCP

用户可以对具有本机终端和文件权限的 AI 说：

> 请按照 https://github.com/xyx-chn/XIPU-MCP/blob/main/skills.md，在这台 Mac 上编译安装 XIPU MCP，并接入你当前使用的 MCP 客户端。

本指南用于部署本机 App，不需要模型 API Key。支持 Apple Silicon、macOS 13+；不支持 Intel、Windows、Linux 或云端执行器。仅能浏览网页的 AI 无法替用户操作本机。

## 给执行部署的 AI

目标是从本仓库源码编译 ARM App，安装到当前用户的 `~/Applications/XIPU MCP.app`，配置用户选择的本机 MCP 客户端，并验证 MCP 初始化。用户要求部署即授权完成这些操作；系统或工具的权限提示遵循所在环境的规则。保持用户原有的客户端设置及其他 MCP 服务器。

### 1. 取得源码并选择当前客户端

检查系统和架构：`uname -s`、`uname -m`、`sw_vers -productVersion`。如果终端运行在 Rosetta 中，改用原生 ARM 终端执行；不要构建 Intel 包。

在用户可写的位置获取源码，例如：

```sh
git clone https://github.com/xyx-chn/XIPU-MCP.git "$HOME/XIPU-MCP"
cd "$HOME/XIPU-MCP"
```

目标目录已经存在时，先检查远程地址及工作区修改，复用对应仓库。不要覆盖不相关目录、丢弃本地修改或强制重置。没有可用 Git 时，可以用 `curl` 下载 GitHub 的 `https://api.github.com/repos/xyx-chn/XIPU-MCP/tarball/main`，解压到新目录；安装脚本不依赖 Git、Homebrew 或预装 Node。

执行前阅读本地 `scripts/install.sh`、`scripts/install-app.mjs` 和 `scripts/setup-mcp.mjs`，确认它们来自本仓库。

从当前执行环境判断客户端，或者遵循用户明确选择：

| 环境 | 安装参数 | 配置方式 |
|---|---|---|
| Codex CLI／桌面 App | `--client codex` | 本机 `codex mcp add`，遵循 `CODEX_HOME` |
| Claude Desktop | `--client claude-desktop` | 合并用户目录中的 `claude_desktop_config.json` |
| Cursor | `--client cursor` | 合并 `~/.cursor/mcp.json` |
| 其他本机 stdio 客户端 | `--client config-only` | 生成 JSON，再用该客户端官方支持的方法注册 |

Claude Code 与 Claude Desktop 是不同客户端。无法确定目标时，只询问“你希望接入哪个 MCP 客户端？”，不要向所有已安装客户端写配置。使用 `config-only` 后还须完成目标客户端的注册，才能报告接入成功。

### 2. 执行编译、安装和配置

例如当前客户端为 Codex：

```sh
bash scripts/install.sh --client codex
```

其他客户端替换 `--client` 的值即可；`--app-dir /绝对路径` 可指定安装目录，`--no-open` 可用于不打开设置窗口的部署。默认不需要 `sudo`。

脚本会：

- 从 Node 官方站下载固定 Node 22.23.3，校验预置 SHA256，准备仓库内的 Node／npm 工具链，不修改系统 Node。
- 使用锁文件执行 `npm ci`，通过类型检查与自动测试后才继续。
- 下载并校验锁定版本的官方 Electron，构建 ARM `.app`，复制完整 App 后原子替换安装目录。
- 验证 stdio 初始化、9 个工具及 `auth_status`；此检查不查询课程、不读取邮件。
- 导出 `dist/mcp-config.json`，配置明确选择的客户端。已有配置变更前生成 `0600` 权限的备份，保留其他服务器及设置。
- 打开 App，供用户本人完成账户配置。

安装路径中的空格必须作为单个参数传递。客户端使用 App 内 `Contents/Resources/xipu-mcp` 启动器；不要配置开发目录中的 `build/bridge.cjs` 或依赖全局 Node。配置中不需要任何学校／邮箱秘密。

### 3. 完成接入验证

脚本退出码必须为 0。安装后的 MCP 命令示例：

```sh
"$HOME/Applications/XIPU MCP.app/Contents/Resources/xipu-mcp"
```

这是 stdio 服务，不是普通交互命令；验证请用脚本：

```sh
".cache/node-v22.23.3-darwin-arm64/bin/node" scripts/smoke-mcp.mjs \
  "$HOME/Applications/XIPU MCP.app/Contents/Resources/xipu-mcp"
```

需要看到 `toolCount: 9` 和 `brokerConnected: true`。重新加载客户端的 MCP，必要时由用户保存当前工作后重启客户端。客户端重载后调用 `auth_status`；若当前会话不能即时加载新工具，明确说明已完成配置、还需重载，不能声称工具已经可用。

首次状态为 `unconfigured` 或 `signed_out` 是正常的；`needs_user` 表示需要人工验证。请用户在 App 的“账户与邮箱”亲自输入账户信息并点击“连接学校”。不要让用户把密码、邮箱授权码或验证码发给 AI，不把它们写到 `.env`、MCP 配置、日志或源码。邮箱自动取码是可选功能；通用 IMAP／POP3 可自定义服务器，也可人工完成学校验证。

登录后可调用 `list_courses` 验证用户课程；这需要用户完成学校认证。随后 AI 可查询材料、下载和 DDL。不要把未登录或接口 warnings 误报成“没有课程／DDL”。

### 4. 故障与更新

构建、校验或配置失败时保留错误状态并修复具体原因，不通过跳过测试、禁用 TLS 校验、移除隔离属性、关闭 Gatekeeper 或读取个人邮件兜底。测试包尚未 Developer ID 签名公证；学校登录、钥匙串及 macOS 安全提示由用户本人处理。

当前用户已有 XIPU MCP App 正在运行时，即使它位于其他目录，安装器也会停止替换，避免验证到旧版后台。等待下载结束，告知用户从应用菜单退出后重试；不要强杀 App。网络错误可以重试下载，校验失败的缓存会重新下载。系统全局代理不由安装脚本修改。

客户端配置失败而 App 已装好时，只重试配置步骤，无需再次编译：

```sh
".cache/node-v22.23.3-darwin-arm64/bin/node" scripts/setup-mcp.mjs \
  --client codex --app "$HOME/Applications/XIPU MCP.app" \
  --config-output "$PWD/dist/mcp-config.json"
```

Codex CLI 不在 PATH 时先寻找当前客户端附带或已安装的 `codex` 可执行文件，将其所在目录加入本次进程 PATH；不要因此安装另一套 AI 客户端。找不到时保留导出的配置，使用 [Codex 官方 MCP 设置](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) 完成注册。其他客户端参考 [Cursor MCP](https://cursor.com/docs/mcp) 或 [Claude Desktop 本地 MCP](https://modelcontextprotocol.io/docs/develop/connect-local-servers)。

更新时先确认用户源码没有未提交改动，再使用正常 Git 更新流程，重新运行安装脚本。安装不会删除 App 用户数据、账户设置或课件。客户端配置备份名包含 `.xipu-backup-`；回退配置时保留更新后由用户新增的其他设置。

交付给用户：实际安装路径、已配置的客户端、MCP 验证结果、是否需要重载／首次登录，以及尚未完成的步骤。
