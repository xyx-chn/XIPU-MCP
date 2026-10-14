# 测试与验证

默认测试使用本机临时目录、证书和模拟服务，不连接真实学校／邮箱。运行：

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run typecheck
npm run build
npm test
```

当前 58 项测试通过。覆盖课程排序、直接文件／嵌入预览／文件夹／外链、Unicode 响应头、索引刷新、下载取消／中断／原子写入／重复校验、路径及跨域限制、截止时间优先级、日历分页去重、文档出处、MCP 参数权限及多客户端 broker。

邮箱模拟测试验证 IMAP／POP3 的隐式 TLS 和 STARTTLS、错误凭据、拒绝明文降级、旧邮件及验证码歧义、IMAP EXAMINE／BODY.PEEK、非匹配邮件不读取正文、POP3 UIDL／TOP 能力缺失与无 DELE。不修改系统信任证书。

部署测试覆盖完整 App 复制、失败时保留旧安装、运行中 App／broker 和符号链接拒绝替换；客户端配置合并保留其他设置、私有备份、损坏配置拒绝写入、配置幂等、Codex 注册验证和 CLI 缺失。

源码安装脚本已从只包含公开源码的独立目录运行成功：校验并准备 Node 22.23.3／Electron，安装锁定依赖、检查类型、构建、运行全部测试、安装 ARM App 到临时目录，验证新 App 的 9 个 MCP 工具和配置导出。真实 Codex CLI 在临时 `CODEX_HOME` 验证注册、保留其他服务器及重复执行幂等；Claude Desktop／Cursor 使用隔离配置文件验证。没有修改实际客户端设置。

运行时依赖检查 `npm audit --omit=dev` 为 0 个已知漏洞。构建工具链有 8 个 moderate 传递依赖告警，位于 electron-builder 构建依赖链，不作为 App 运行时依赖打包。

## 仍需真实环境验证

- 另一台无开发环境的 Apple Silicon Mac 安装与客户端重载。
- 学校要求邮箱挑战时，新增验证码邮件到达、解析并提交 SSO 的完整流程。
- 不同课程插件、权限及个人延期场景的覆盖；查询有 `warnings` 时需核实来源。
- 提供 Developer ID 证书后的签名、公证和 Gatekeeper 验证。

开发入口 `scripts/smoke-auth.ts`、`smoke-mail.ts`、`inspect-materials.ts` 及带 `--live` 的 MCP 检查，只供开发者在本人已配置并授权的本机环境主动联调，不属于自动安装步骤。个人账户、课程、课件、DDL、邮件和网络诊断记录不进入公开仓库或安装包。
