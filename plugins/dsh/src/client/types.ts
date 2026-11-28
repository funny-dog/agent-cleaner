export type Lang = 'zh' | 'en';
export type Recommendation = 'recommended' | 'optional' | 'exempt';
export type TabKey = 'scan' | 'mcp' | 'doctor' | 'trash' | 'settings';

export interface ScanProgress {
  active: boolean;
  completed: number;
  total: number;
  agent: string;
  currentBytes: number;
  updatedAt?: number;
}

export interface CleanerConfig {
  exempt_hours: number;
  cold_threshold_days: number;
  lang: Lang;
  ignored_agents: string[];
  ignored_paths: string[];
  trash_max_age_days: number;
  trash_max_size_mb: number;
  auto_prune_trash: boolean;
  backup_max_count: number;
}

export interface BackupEntry {
  id: string;
  originalPath: string;
  backupPath: string;
  sizeBytes: number;
  createdAtMs: number;
}

export interface ScanItem {
  id: string;
  agent: string;
  category: string;
  path: string;
  sizeBytes: number;
  mtimeMs: number;
  description: string;
  status: string;
  recommendation: Recommendation;
  recommendationReason: string;
}

export interface ScanResult {
  agent: string;
  items: ScanItem[];
  totalBytes: number;
  diskUsageBytes: number;
}

export interface DoctorIssue {
  id: string;
  message: string;
  severity?: 'error' | 'warning' | 'info';
  autoFixable?: boolean;
}

export interface DoctorReport {
  agent: string;
  path: string;
  healthy: boolean;
  issues: DoctorIssue[];
}

export interface TrashBatch {
  batchId: string;
  timestamp: number;
  totalBytes: number;
  items: Array<{ id: string; agent: string; originalPath: string; sizeBytes: number }>;
}

export interface McpEntry {
  agent: string;
  name: string;
  transport?: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  configPath?: string;
}

export interface McpOrphanProcess {
  pid: number;
  command: string;
  rssKb: number;
  matchedName?: string;
  matchedAgent?: string;
}

export interface OverviewPayload {
  agents: ScanResult[];
  doctors: DoctorReport[];
  mcpAudit: {
    audit: {
      entries: unknown[];
      deadLinks: McpEntry[];
      duplicates?: McpEntry[][];
      conflicts?: McpEntry[][];
      orphanProcesses: McpOrphanProcess[];
      coldCaches: Array<{ source: string; path: string; sizeBytes: number; lastAccessDays: number }>;
    };
  };
  trash: TrashBatch[];
  disk?: { totalBytes: number; availableBytes: number } | null;
  exemptHours: number;
  scannedAt?: number;
}

export type RunActionFn = (label: string, url: string, body?: unknown) => Promise<void>;
