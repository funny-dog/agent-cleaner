# dsh-agent-cleaner

[English](README.md) | [简体中文](README.zh-CN.md)

适用于 DeepSeek Harness (DSH) 的存储清理、孤儿 MCP 进程查杀与配置修复插件。支持扫描管理 Claude Code、OpenCode、Codex CLI、DSH、Gemini/Antigravity、Cursor、Aider、Ollama 等本地 AI 编程工具的缓存与会话残留。

## 功能概览

- **侧边栏与主面板视图**：按工具查看磁盘占用分布，支持按「推荐清理 / 建议复核 / 活跃豁免」筛选，提供 Dry-Run 预演与按项勾选清理。
- **内置 Agent 工具**：向 DSH 注册 `agent_cleaner_scan`、`agent_cleaner_clean`、`agent_cleaner_doctor`、`agent_cleaner_mcp` 四个工具，支持对话式诊断与清理。
- **可逆回收站**：清理文件统一移入 `~/.agent-cleaner/trash/<batchId>/` 并记录清单，随时可按批次原路还原。
- **孤儿 MCP 进程查杀**：识别父进程已退出的 `PPID=1` 僵尸 stdio MCP 进程并分级终止，不影响常驻 SSE/HTTP 服务。
- **保注释配置修复**：无损修复 JSON、JSONC、TOML、YAML 中的失效 MCP 路径并自动备份原文件。

## 前置依赖

本插件依赖底层的 `agent-cleaner`（或 `ac`）原生命令行程序（默认查找 `~/.local/bin/agent-cleaner`、`~/.cargo/bin/agent-cleaner` 或系统 `$PATH`）。

从仓库根目录编译安装 CLI：

```bash
cargo install --path crates/cleaner-cli
```

## 安装方式

通过 DSH 命令行安装：

```bash
dsh plugin add dsh-agent-cleaner
```

或从 GitHub 子目录安装：

```bash
dsh plugin add github:funny-dog/agent-cleaner#path:/plugins/dsh
```

## 可选配置

可在 DSH profile 的 `cordis.patch.yml` 中自定义二进制路径与默认保护时长：

```yaml
- id: agent-cleaner
  name: dsh-agent-cleaner
  config:
    binaryPath: /Users/you/.cargo/bin/agent-cleaner
    exemptRecentHours: 24
```

## 许可证

MIT
