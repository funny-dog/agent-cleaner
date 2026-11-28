pub mod config;
pub mod doctor;
pub mod fs_safe;
pub mod mcp_auditor;
pub mod mcp_server;
pub mod recommendation;
pub mod scanner;
pub mod targets;
pub mod trash;
pub mod types;

use types::{CleanRecommendation, CleanerContext, OverviewReport, OverviewSummary, ScanOptions};

pub fn get_overview(ctx: &CleanerContext, options: &ScanOptions) -> OverviewReport {
    let agents = scanner::scan_all(ctx, options);
    let mcp = mcp_auditor::audit_mcp(ctx);
    let doctors = doctor::run_all_doctors(ctx);
    let batches = trash::list_batches(ctx);

    let total_disk_usage_bytes = agents.iter().map(|a| a.disk_usage_bytes).sum();
    let total_reclaimable_bytes = agents.iter().map(|a| a.total_bytes).sum();
    let recommended_bytes = agents
        .iter()
        .flat_map(|a| a.items.iter())
        .filter(|i| i.recommendation == CleanRecommendation::Recommended)
        .map(|i| i.size_bytes)
        .sum();

    let doctor_issue_count = doctors.iter().map(|d| d.issues.len()).sum();

    OverviewReport {
        summary: OverviewSummary {
            total_disk_usage_bytes,
            total_reclaimable_bytes,
            recommended_bytes,
            orphan_mcp_count: mcp.orphan_processes.len(),
            doctor_issue_count,
            trash_batch_count: batches.len(),
            scanned_at: ctx.now(),
        },
        agents,
        mcp,
        doctors,
    }
}
