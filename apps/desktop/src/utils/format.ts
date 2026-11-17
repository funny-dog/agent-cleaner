export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let val = bytes;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return idx === 0 ? `${bytes} B` : `${val.toFixed(1)} ${units[idx]}`;
}

export function formatTimeAgo(ms: number | null | undefined): string {
  if (!ms) return '--';
  const diff = Math.max(0, Date.now() - ms);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

const AGENT_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  opencode: 'OpenCode',
  codex: 'Codex CLI',
  dsh: 'DeepSeek Harness',
  gemini: 'Gemini / Antigravity',
  workbuddy: 'WorkBuddy',
  qoder: 'Qoder',
  kimi: 'Kimi CLI',
  kiro: 'Kiro CLI',
  ollama: 'Ollama',
  aider: 'Aider',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  trae: 'Trae',
  codebuddy: 'CodeBuddy',
  zcode: 'ZCode',
  devin: 'Devin',
  continue: 'Continue',
  copilot: 'GitHub Copilot CLI',
  zed: 'Zed',
  'pkg-cache': 'npx / uv 冷缓存',
};

export function agentLabel(agent: string): string {
  return AGENT_LABELS[agent] ?? agent;
}
