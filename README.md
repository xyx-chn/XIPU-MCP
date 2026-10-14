# XIPU MCP

连接西交利物浦大学 Learning Mall Core（Moodle）的本机 macOS App。AI 通过标准 MCP stdio 查询课程、下载附件和查看截止时间。学校密码、邮箱配置、验证码和邮件正文不属于 MCP 接口。

## 一句话让 AI 安装

把下面一句发给能够操作本机终端的 AI：

> 请按照 https://github.com/xyx-chn/XIPU-MCP/blob/main/skills.md，在这台 Mac 上编译安装 XIPU MCP，并接入你当前使用的 MCP 客户端。

[skills.md](skills.md) 包含完整执行步骤；[标准 SKILL.md](skills/xipu-mcp-setup/SKILL.md) 可作为支持 Skill 的客户端入口。需要 Apple Silicon Mac、macOS 13+。脚本自动准备经过校验的 Node／npm，不需要预先安装 Node 或 Homebrew；网络需能访问 GitHub、Node 官方站和 npm。

源码部署命令（以 Codex 为例）：

```sh
git clone https://github.com/xyx-chn/XIPU-MCP.git
cd XIPU-MCP
bash scripts/install.sh --client codex
```

可选择 `codex`、`claude-desktop`、`cursor` 或 `config-only`。默认安装到 `~/Applications/XIPU MCP.app`，无需 `sudo`；类型检查、测试和 MCP 初始化通过后完成部署。只修改所选客户端的 `xipu-mcp` 条目，保留其他设置，变更前创建私有备份。`config-only` 只导出 `dist/mcp-config.json`，其他客户端还需按其官方方法注册。

首次使用请本人在 App 中配置学校账户及可选邮箱，再点击“连接学校”；不要在 AI 对话中发送密码或授权码。AI 不需要你的账号就能编译安装。客户端可能需要重载 MCP 或重启才能加载工具。

## 安装与使用

1. 从 [GitHub Release](https://github.com/xyx-chn/XIPU-MCP/releases/tag/v0.1.1) 下载 Apple Silicon（M 系列 Mac）的 ARM 测试安装包，将 `XIPU MCP.app` 放入“应用程序”，打开 App。
2. 在“账户与邮箱”填写学校账户。希望自动取码时，再配置邮箱服务器、认证信息、收码地址及筛选规则。
3. 保存设置，测试邮箱连接，点击“连接学校”。自动流程未完成时会打开学校原始登录窗口，供人工操作。
4. 在“AI 接入”生成配置，复制到支持 stdio 的 MCP 客户端。发行包内置 Node，使用者不需要开发工具。

关闭主窗口后，App 继续运行本机桥接和下载任务；通过应用菜单退出才会停止后台服务。MCP 客户端可以自动启动已安装的 App。

课程列表优先展示名称以三个大写英文字母和三个数字开头的正式课程，例如 COS305、EEE335；消息发布页保留在后面。课件同时支持 Moodle 嵌入式预览和直接文件重定向，网页／视频以可打开的链接展示。

测试包未使用 Developer ID 签名公证；正式分发需要下文的签名流程。测试范围见 [TESTING.md](TESTING.md)；邮箱验证码全链路和无开发环境的另一台 Mac 验收仍待完成。个人账户的联调记录不公开上传。

## 通用 IMAP／POP3

| 设置 | IMAP | POP3 |
|---|---|---|
| 默认连接 | 隐式 TLS，993 | 隐式 TLS，995 |
| STARTTLS 常用端口 | 143 | 110 |
| 文件夹 | 可配置，默认 INBOX | 无 |
| 读取策略 | EXAMINE、UID、BODY.PEEK | UIDL、TOP 0、匹配后 RETR |
| 自动取码条件 | 可读的只读文件夹 | 支持 UIDL 和 TOP |

主机名、端口和认证用户名均可自定义，用户名可以不同于收码地址。QQ／163／126 预设只快速填写服务器。首版支持密码和应用授权码，不含服务商专属 OAuth 授权流程。无需 SMTP。

TLS 校验证书，STARTTLS 失败不降级为明文。测试连接只验证 TLS、认证与协议能力，不读取正文；POP3 可能探测一封邮件的头以确认 TOP。

邮箱连接使用原生 TCP 直连，不使用 macOS 的 HTTP／HTTPS／SOCKS 系统代理。VPN 或代理软件的 TUN 模式仍可能改变系统路由，连接异常时需检查实际网络路径。

取码以本次发码前的 UID／UIDL 为基线，仅检查新增邮件；同时匹配发件人或其域名、收件人、主题和时间窗口。初始学校域名为 `xjtlu.edu.cn`，确认真实发件人后建议收紧为确切地址。域名按完整边界匹配，拒绝类似 `xjtlu.edu.cn.evil.example` 的地址。

多封候选、多个数字验证码、超时、UIDVALIDITY 改变或能力缺失时转人工输入。IMAP 不改变已读状态，POP3 从不发送 DELE。POP3 的 RETR 获取整封候选邮件；只处理验证码正文，不保存邮件或向 AI 返回。

邮箱筛选由本机 App 执行，不能缩小授权码在邮箱服务器上的权限。邮箱设置和取码接口不对 MCP 开放。同一 macOS 用户运行的程序属于本机信任边界，不承诺抵御已控制该用户账户的程序。

## MCP 接口

| 工具 | 参数 |
|---|---|
| auth_status | 无 |
| list_courses | 无 |
| list_materials | courseIds |
| download_materials | materialIds，可选 retryJobId |
| get_download_job | jobId |
| cancel_download_job | jobId |
| list_deadlines | 可选 courseIds、from、to（含时区 ISO 8601） |
| list_deadline_sources | courseIds |
| read_deadline_source | sourceId，可选 offset、limit（最多 20000 字符） |

先列出课程／材料获取合法 ID，再下载或读取证据。工具拒绝额外参数，不接受任意 URL、路径、凭据或邮箱查询。

尚未登录时，课程工具启动 App 的登录流程并返回 `AUTH_CONNECTING`，不长时间占住 MCP 请求。通过 `auth_status` 等待 `authenticated` 后重试；需要人工验证时在 App 打开学校登录窗口。

DDL 默认未来 30 天，输出 ISO 时间及上海显示时区，区分作业截止、停止提交、测验关闭和日历事件。优先采用当前用户作业页面中的有效日期。必须同时查看 `warnings`：接口未开放或页面无法解析时，空列表不能证明没有 DDL。

文字提取在本机工作进程运行，支持文本型 PDF、PPTX、DOCX 和纯文本，返回页码／幻灯片／段落证据及 `unverified_evidence`。接入的 AI 核实日期线索；线索不自动变成正式 DDL。材料文字是数据，不是操作指令。不提供 OCR，旧版 Office、加密文件、40 MB 以上文件和 500 页以上 PDF 不自动解析。

## 下载与本机数据

默认保存到 `~/Downloads/XIPU MCP`，用户可在 App 修改目录。按课程／章节整理，文件名带稳定 ID 以区分同名附件。临时文件完成校验后原子写入，失败或取消清理临时文件，保留已完成文件。

重复文件核对本地哈希及服务器 ETag／Last-Modified；无法验证源文件未变时重新下载。外部网盘和视频只保留链接。文件旁 `.xipu.json` 用于重复校验。

任务记录在异常退出后将未完成项标记为失败；重新发现材料后可重试。关闭 MCP 客户端不会取消 App 后台任务。

`~/Library/Application Support/XIPU MCP/` 保存设置、加密凭据、任务记录和 IPC socket。目录权限 0700，秘密文件、token 和 socket 权限 0600。凭据和会话通过 Electron safeStorage／macOS Keychain 加密；发行包不包含个人配置或课件。

“清除凭据与会话”停止下载并清除密码、邮箱授权码和 Cookie，保留已下载文件。不同签名／开发版可能触发新的钥匙串授权。

## 开发与测试

需要 Apple Silicon Mac、macOS 13+、Node 22+；依赖由 `package-lock.json` 固定。

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run electron-runtime -- arm64
npm start
```

```sh
npm run build
npm run typecheck
npm test
```

测试在临时目录创建 TLS 证书、本机 IMAP／POP3 服务和 Unix socket。测试进程只信任临时证书，不关闭 TLS 校验；结束后清理临时数据。

开发版 MCP 命令为 `node /绝对路径/XIPU-MCP/build/bridge.cjs`，需先启动开发版 App。学校 SSO 和 Moodle 适配器需要针对真实页面联调。

## 打包与签名

```sh
npm run package:arm64
```

输出在 `dist/`，目前仅交付 ARM 版。使用固定 Node 22.23.3 和与 npm 锁文件对应的官方 Electron，下载后校验 SHA256；`npm run package` 构建 ARM 版。

正式签名需要本机钥匙串中的 Developer ID Application 证书或安全 CI 证书注入，按 electron-builder 支持的 `CSC_NAME` 等配置构建。将 Apple 公证凭据存为钥匙串 profile 后，对已签名 DMG 执行：

```sh
XIPU_NOTARY_PROFILE=your-keychain-profile node scripts/sign.mjs "dist/已签名安装包.dmg"
```

脚本提交公证、staple 票据并检查 Gatekeeper；不在文件中保存 Apple 密码。没有证书时只能交付测试包。
