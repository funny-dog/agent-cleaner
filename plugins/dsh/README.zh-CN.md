# dsh-agent-cleaner

[English](README.md) | [简体中文](README.zh-CN.md)

DeepSeek Harness (DSH) 磁盘清理与配置自愈插件。无需离开 DSH，即可在侧边栏面板或对话中一键扫描并清理本地 AI 编程工具堆积的冗余缓存、孤儿会话、僵尸 `PPID=1` MCP 进程与失效配置。

支持 **Claude Code**、**OpenCode**、**Codex CLI**、**DSH**、**Gemini / Antigravity**、**Cursor**、**Aider**、**Ollama**。

![Agent Cleaner DSH 面板（暗色主题）](https://raw.githubusercontent.com/funny-dog/agent-cleaner/main/plugins/dsh/assets/preview-dark.png)

![Agent Cleaner DSH 面板（亮色主题）](https://raw.githubusercontent.com/funny-dog/agent-cleaner/main/plugins/dsh/assets/preview-light.png)

## 功能特性

- **DSH 侧边栏可视化面板**：从左侧栏打开 **Agent Cleaner**，在雷达遮罩中实时查看扫描进度，查看各工具磁盘占用分布，按「推荐清理 / 建议复核 / 活跃豁免（24h）」筛选，支持条目卡片快捷「忽略此路径」、移入回收站或彻底删除。
- **内置 8 个对话工具（Cordis Tools）**：向 DSH 注册 `agent_cleaner_overview`、`agent_cleaner_scan`、`agent_cleaner_clean`、`agent_cleaner_doctor`、`agent_cleaner_mcp`、`agent_cleaner_restore`、`agent_cleaner_config`、`agent_cleaner_backups`，可直接在对话中操控：
  - *“帮我扫描一下各 AI 编程助手占用的冗余空间和孤儿 MCP 进程”*
  - *“检查跨 Agent 的 MCP 冲突与死链并选择性修复”*
- **设置 / 白名单标签页**：在面板内直接管理 `exempt_hours`、`cold_threshold_days`、`trash_max_age_days`、`trash_max_size_mb`、`backup_max_count`、`auto_prune_trash` 以及 `ignored_paths`、`ignored_agents`。
- **可逆回收站与过期淘汰**：清理项先移入 `~/.agent-cleaner/trash/<batchId>/` 并留存清单，展示保留策略与容量上限，支持「立即清理过期批次」与一键原路还原。
- **孤儿 MCP 与冲突雷达**：识别跨 Agent 同名冲突（`conflicts`）、重复配置、冷缓存及孤儿 stdio MCP 进程（支持 Unix `PPID=1` 与 Windows 父进程已退出检测），不误杀 SSE/HTTP 常驻服务。
- **保注释选择性自愈与备份回滚**：支持全局或按单条问题单独「修复」JSON、JSONC、TOML、YAML 中的失效配置并保留注释，在「配置自愈」标签页直接浏览历史备份与一键回滚。

## 安装方式

### DSH Desktop（桌面端）

打开 DSH 应用内的 **设置 → 插件（市场）**，搜索 `dsh-agent-cleaner` 一键安装并启用即可。

### DSH Web / CLI 版

```bash
dsh plugin --profile web add dsh-agent-cleaner
```

或从 GitHub 子目录直接安装：

```bash
dsh plugin --profile web add github:funny-dog/agent-cleaner#path:/plugins/dsh
```

> **开箱即用（支持 macOS / Linux / Windows）**：首次触发扫描时，插件会自动下载并原生解压适配当前系统的预编译引擎（`.tar.gz` / `.zip`）到 `~/.agent-cleaner/bin/`，无需本地安装 Rust 工具链。

### 多平台一键插件注入与独立命令行（`npx` / `npm`）

无需安装全局 CLI，即可直接为本机 Claude Code、Cursor、Gemini/Antigravity、Codex CLI、OpenCode、DSH 一键注入 MCP + Skill + 斜杠命令（`/clean`、`/doctor`、`/mcp-audit`、`/restore`）：

```bash
npx -y dsh-agent-cleaner setup
npx -y dsh-agent-cleaner setup --status
```

或直接通过 `npx` 启动独立交互命令行：

```bash
npx dsh-agent-cleaner
```

## 可选配置

如需修改默认保护时长、指定本地二进制路径或配置自定义下载镜像，可在 DSH profile 的 `cordis.patch.yml` 中配置：

```yaml
- id: agent-cleaner
  name: dsh-agent-cleaner
  config:
    exemptRecentHours: 24
    # binaryPath: /path/to/agent-cleaner
    # downloadUrl: https://your-mirror/agent-cleaner-darwin-arm64.tar.gz
```

## 许可证

MIT
