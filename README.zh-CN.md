# agent-cleaner

面向本地 AI 编程工具（Claude Code、OpenCode、Codex CLI、DeepSeek Harness、Gemini/Antigravity、Cursor、Aider、Ollama）的磁盘清理、孤儿 MCP 进程查杀与配置修复工具。

[English](README.md) | [简体中文](README.zh-CN.md)

![Agent Cleaner 面板预览](plugins/dsh/assets/preview-dark.png)

## 简介

日常使用多个 AI 编程助手时，本地往往会堆积数 GB 的 Shadow Git 快照、孤儿会话记录、安装中断残留的 `node_modules`、长期未访问的 `npx`/`uv` 缓存，以及父进程退出后残留的 `PPID=1` 僵尸 MCP 进程。

`agent-cleaner` 基于统一的 Rust 核心库（`cleaner-core`），同时提供命令行与插件两种使用方式：

- **命令行 (`ac` / `agent-cleaner`)**：支持终端扫描、交互式勾选清理、配置修复、孤儿进程查杀，并内置标准 stdio MCP Server。
- **客户端插件 (`plugins/`)**：
  - `plugins/universal`：适用于 Claude Code、Cursor、Antigravity 的通用插件（MCP + `SKILL.md` + 斜杠命令）。
  - `plugins/dsh`（[`dsh-agent-cleaner`](plugins/dsh/README.zh-CN.md)）：适用于 DeepSeek Harness (DSH) 的 Cordis 插件与侧边栏面板。
- **桌面应用 (`apps/desktop`)**：Claude 风格的 Tauri 仪表盘与托盘，显示主目录所在磁盘的剩余空间（低于 10% 时高亮警告）。

## 安全机制与特性

1. **Claude Code 孤儿会话精准识别**：流式读取最新 `.jsonl` 前 30 行提取真实工作目录 `cwd`，避免按目录名连字符拆分导致误判；自动识别并保护未挂载的 `/Volumes/*`、`/mnt/*`、`/run/media/*` 与 Windows 盘符/UNC 路径，同时检测 `> 10MB` 的膨胀会话文件。
2. **多工具与 Windows 深度覆盖**：支持清理 OpenCode Shadow Git 快照、Codex `sessions/` 历史日志、DSH profile 下未声明的残留包（含 `@scope/pkg`）、长期未访问的 `npm/_npx` / `uv` / `pnpm` / `playwright` 冷缓存，以及 Windows `AppData/Roaming` 与 `AppData/Local` 下的应用与 MCP 配置。
3. **保注释配置修复与备份回滚 (`doctor` / `backups`)**：基于 `jsonc-parser`、`toml_edit` 与 YAML CST/AST 全局或按 `issueIds` 选择性修复失效 MCP 配置，完整保留原有注释与缩进，写入前自动备份至 `~/.agent-cleaner/backups/` 并支持一键回滚（`ac backups restore <id>`）。
4. **孤儿 MCP 进程查杀与冲突审计 (`mcp`)**：检测跨 Agent 同名冲突（`conflicts`）与重复配置，通过 `sysinfo` 定位孤儿 stdio MCP 进程（Unix `PPID=1` 与 Windows 父进程已退出的孤儿进程），按 `SIGTERM -> SIGKILL`（Windows `taskkill /T -> /F /T`）优雅退出，不触碰常驻 SSE/HTTP 服务。
5. **跨平台可逆回收站与白名单 (`trash` / `config`)**：默认豁免 24 小时内修改过的活跃文件及 `~/.agent-cleaner/config.toml` 白名单路径。清理项通过盘符安全的相对路径移入 `~/.agent-cleaner/trash/<batchId>/`，支持跨分区回退、过期/超额自动淘汰（`ac restore --prune`）以及一键原路还原（`ac restore <batchId>`）。

## 目录结构

```text
agent-cleaner/
├── Cargo.toml
├── crates/
│   ├── cleaner-core/       # Rust 核心库（扫描、回收站、MCP 审计、配置修复、MCP Server）
│   └── cleaner-cli/        # 命令行二进制 (`ac` 与 `agent-cleaner`)
└── plugins/
    ├── universal/          # 通用插件（plugin.json + mcp.json + SKILL.md + commands）
    └── dsh/                # DSH 插件 (`dsh-agent-cleaner`)
```

## 快速开始

### 1. 命令行 (`ac` / `agent-cleaner`)

#### 方式一：一键脚本安装（推荐，免安装 Rust）

**macOS / Linux：**

```bash
curl -fsSL https://raw.githubusercontent.com/funny-dog/agent-cleaner/main/install.sh | sh
```

**Windows (PowerShell)：**

```powershell
irm https://raw.githubusercontent.com/funny-dog/agent-cleaner/main/install.ps1 | iex
```

#### 方式二：通过 `npx` / `npm` 免编译运行

```bash
# 免安装直接运行
npx dsh-agent-cleaner

# 或全局安装后直接使用 `ac` / `agent-cleaner`
npm install -g dsh-agent-cleaner
```

#### 方式三：从本地仓库一键安装

```bash
npm run install:cli
```

#### 日常使用

直接运行 `ac` 即可查看健康总览并进入交互式向导菜单，也可以直接使用子命令：

```bash
ac                  # 启动交互式向导菜单（非 TTY 管道环境下输出总览）
ac overview         # 输出磁盘占用、配置诊断、MCP 审计与回收站总览
ac scan [--progress-json]
ac clean --dry-run
ac clean --only-recommended
ac doctor --fix [--ids <id1,id2>]
ac mcp --kill
ac restore <batchId>
ac restore --prune
ac config [show|set|ignore|ignore-agent]
ac backups [list|restore <id>|delete <id>|prune]
```

内置 Stdio MCP Server（`ac mcp-server` / `npx -y dsh-agent-cleaner mcp-server`）提供 8 个工具：`cleaner_overview`、`cleaner_scan`、`cleaner_clean`、`cleaner_doctor`、`cleaner_mcp_audit`、`cleaner_restore`、`cleaner_config`、`cleaner_backups`。

### 2. 插件接入（免装全局 CLI，开箱即用）

#### 方式一：多平台一键插件注入（不安装全局 CLI、不修改 PATH）

自动探测本机已安装的 **Claude Code、Cursor、Gemini / Antigravity、Codex CLI、OpenCode、DSH**，修改前自动备份至 `~/.agent-cleaner/backups/`，并保注释写入 **MCP Server（`npx -y dsh-agent-cleaner mcp-server`）+ 双通道 Skill + 斜杠快捷命令（`/clean`、`/doctor`、`/mcp-audit`、`/restore`）**：

```bash
# 交互式确认安装（或加 --yes 自动安装到本机所有已探测平台）
npx -y dsh-agent-cleaner setup
npx -y dsh-agent-cleaner setup --yes

# 或使用单行脚本一键注入插件
curl -fsSL https://raw.githubusercontent.com/funny-dog/agent-cleaner/main/install-plugin.sh | sh

# 查看安装状态、指定平台或无损卸载
npx -y dsh-agent-cleaner setup --status
npx -y dsh-agent-cleaner setup --agent claude,cursor,gemini,codex,opencode,dsh
npx -y dsh-agent-cleaner setup --uninstall
```

#### 方式二：各平台原生插件 / Skill 命令直装

- **Claude Code**：
  ```text
  /plugin marketplace add funny-dog/agent-cleaner
  /plugin install agent-cleaner
  ```
- **通用 Skills 生态（Cursor / Codex / Gemini / Claude / OpenCode）**：
  ```bash
  npx skills add funny-dog/agent-cleaner
  ```
- **DeepSeek Harness (DSH)**：
  ```bash
  dsh plugin --profile web add dsh-agent-cleaner
  ```
  详见 [`plugins/dsh/README.zh-CN.md`](plugins/dsh/README.zh-CN.md)。

## 构建与测试

```bash
cargo build --release -p cleaner-cli
cargo test --workspace
npm run typecheck
npm --workspace=dsh-agent-cleaner run build
npm --workspace=dsh-agent-cleaner test
```

## 许可证

[MIT](LICENSE)
