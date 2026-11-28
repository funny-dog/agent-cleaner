export const AGENT_COLORS = [
  '#b76745',
  '#737a45',
  '#b6883d',
  '#6e8554',
  '#8b7765',
  '#a95d4a',
  '#6f8469',
];

export const SCOPED_CSS = `
.ac-dsh-root {
  --ac-canvas: 48 33% 95%;
  --ac-surface: 48 50% 98%;
  --ac-surface-hover: 45 42% 94%;
  --ac-input-bg: 48 40% 97%;
  --ac-ink: 60 3% 8%;
  --ac-text-primary: hsl(var(--ac-ink));
  --ac-text-secondary: hsl(50 5% 30%);
  --ac-text-muted: hsl(50 5% 36%);
  --ac-border: hsl(48 20% 89%);
  --ac-border-strong: hsl(48 6% 75%);
  --ac-hover-bg: hsl(48 33% 93%);
  --ac-active-bg: hsl(43 30% 88%);
  --ac-track-bg: hsl(48 20% 86%);
  --ac-accent: hsl(18 47% 50%);
  --ac-accent-strong: hsl(16 51% 42%);
  --ac-accent-soft: hsl(18 52% 93%);
  --ac-accent-border: hsl(18 32% 73%);
  --ac-on-accent: hsl(48 50% 98%);
  --ac-success-text: hsl(103 15% 35%);
  --ac-success-bg: hsl(103 22% 92%);
  --ac-success-border: hsl(103 14% 76%);
  --ac-warn-text: hsl(31 49% 35%);
  --ac-warn-bg: hsl(38 54% 91%);
  --ac-warn-border: hsl(34 34% 73%);
  --ac-danger-text: hsl(0 50% 38%);
  --ac-danger-bg: hsl(0 45% 94%);
  --ac-danger-border: hsl(0 25% 76%);
  --ac-danger-solid-bg: hsl(0 50% 38%);
  --ac-info-text: hsl(28 12% 38%);
  --ac-info-bg: hsl(30 15% 88%);
  --ac-exempt-text: hsl(50 5% 36%);
  --ac-exempt-bg: hsl(48 20% 91%);
  --ac-exempt-border: hsl(48 12% 78%);
  --ac-overlay-bg: hsl(40 20% 20% / 0.38);
  --ac-overlay-card: hsl(48 50% 98%);
  --ac-overlay-shadow: 0 18px 50px hsl(38 20% 15% / 0.16), 0 0 0 1px hsl(var(--ac-border));
  --ac-ring-track: hsl(18 30% 83%);
  --ac-shadow-card: 0 1px 2px hsl(38 20% 15% / 0.03), 0 0 0 1px hsl(var(--ac-border) / 0.55);
  --ac-font-display: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
  --ac-font-ui: Inter, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
  --ac-font-mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  --ac-transition-ui: 160ms cubic-bezier(0.2, 0.7, 0.2, 1);

  height: 100%;
  display: flex;
  flex-direction: column;
  color-scheme: light;
  color: var(--ac-text-primary);
  background: hsl(var(--ac-canvas));
  font-family: var(--ac-font-ui);
  box-sizing: border-box;
}
body[data-ds-dark-theme] .ac-dsh-root {
  --ac-canvas: 35 12% 12%;
  --ac-surface: 35 10% 16%;
  --ac-surface-hover: 34 10% 20%;
  --ac-input-bg: 34 9% 19%;
  --ac-ink: 43 30% 93%;
  --ac-text-primary: hsl(var(--ac-ink));
  --ac-text-secondary: hsl(38 12% 78%);
  --ac-text-muted: hsl(36 9% 67%);
  --ac-border: hsl(34 8% 29%);
  --ac-border-strong: hsl(32 8% 40%);
  --ac-hover-bg: hsl(34 9% 22%);
  --ac-active-bg: hsl(32 10% 25%);
  --ac-track-bg: hsl(34 8% 27%);
  --ac-accent: hsl(18 60% 63%);
  --ac-accent-strong: hsl(16 56% 57%);
  --ac-accent-soft: hsl(18 28% 24%);
  --ac-accent-border: hsl(18 30% 43%);
  --ac-success-text: hsl(95 25% 68%);
  --ac-success-bg: hsl(100 16% 21%);
  --ac-success-border: hsl(96 14% 36%);
  --ac-warn-text: hsl(38 65% 69%);
  --ac-warn-bg: hsl(35 30% 22%);
  --ac-warn-border: hsl(35 26% 38%);
  --ac-danger-text: hsl(5 70% 72%);
  --ac-danger-bg: hsl(0 25% 23%);
  --ac-danger-border: hsl(0 25% 42%);
  --ac-danger-solid-bg: hsl(0 48% 47%);
  --ac-info-text: hsl(32 25% 75%);
  --ac-info-bg: hsl(30 12% 23%);
  --ac-exempt-text: hsl(36 9% 72%);
  --ac-exempt-bg: hsl(34 8% 24%);
  --ac-exempt-border: hsl(34 8% 36%);
  --ac-overlay-bg: hsl(30 12% 5% / 0.72);
  --ac-overlay-card: hsl(35 10% 16%);
  --ac-overlay-shadow: 0 20px 44px hsl(30 12% 5% / 0.55);
  --ac-ring-track: hsl(18 24% 31%);
  --ac-shadow-card: 0 1px 2px hsl(30 12% 5% / 0.12), 0 0 0 1px hsl(var(--ac-border) / 0.55);
  color-scheme: dark;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-ds-theme-source]) .ac-dsh-root {
    --ac-canvas: 35 12% 12%;
    --ac-surface: 35 10% 16%;
    --ac-surface-hover: 34 10% 20%;
    --ac-input-bg: 34 9% 19%;
    --ac-ink: 43 30% 93%;
    --ac-text-primary: hsl(var(--ac-ink));
    --ac-text-secondary: hsl(38 12% 78%);
    --ac-text-muted: hsl(36 9% 67%);
    --ac-border: hsl(34 8% 29%);
    --ac-border-strong: hsl(32 8% 40%);
    --ac-hover-bg: hsl(34 9% 22%);
    --ac-active-bg: hsl(32 10% 25%);
    --ac-track-bg: hsl(34 8% 27%);
    --ac-accent: hsl(18 60% 63%);
    --ac-accent-strong: hsl(16 56% 57%);
    --ac-accent-soft: hsl(18 28% 24%);
    --ac-accent-border: hsl(18 30% 43%);
    --ac-success-text: hsl(95 25% 68%);
    --ac-success-bg: hsl(100 16% 21%);
    --ac-success-border: hsl(96 14% 36%);
    --ac-warn-text: hsl(38 65% 69%);
    --ac-warn-bg: hsl(35 30% 22%);
    --ac-warn-border: hsl(35 26% 38%);
    --ac-danger-text: hsl(5 70% 72%);
    --ac-danger-bg: hsl(0 25% 23%);
    --ac-danger-border: hsl(0 25% 42%);
    --ac-danger-solid-bg: hsl(0 48% 47%);
    --ac-info-text: hsl(32 25% 75%);
    --ac-info-bg: hsl(30 12% 23%);
    --ac-exempt-text: hsl(36 9% 72%);
    --ac-exempt-bg: hsl(34 8% 24%);
    --ac-exempt-border: hsl(34 8% 36%);
    --ac-overlay-bg: hsl(30 12% 5% / 0.72);
    --ac-overlay-card: hsl(35 10% 16%);
    --ac-overlay-shadow: 0 20px 44px hsl(30 12% 5% / 0.55);
    --ac-ring-track: hsl(18 24% 31%);
    --ac-shadow-card: 0 1px 2px hsl(30 12% 5% / 0.12), 0 0 0 1px hsl(var(--ac-border) / 0.55);
    color-scheme: dark;
  }
}
.ac-dsh-root * { box-sizing: border-box; }
.ac-dsh-root ::selection { background: hsl(var(--ac-accent) / 0.2); color: var(--ac-text-primary); }
.ac-drag-strip {
  flex: none;
  height: calc(28px + var(--dsh-frame-top-clearance, 0px));
  min-height: 28px;
  width: 100%;
  -webkit-app-region: drag;
  user-select: none;
}
.ac-header-wrap {
  flex: none;
  padding: 8px 28px 0;
}
.ac-body-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.ac-scroll-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 28px 40px;
  scrollbar-width: thin;
  scrollbar-color: hsl(var(--ac-border-strong)) transparent;
}
.ac-scroll-body::-webkit-scrollbar { width: 7px; height: 7px; }
.ac-scroll-body::-webkit-scrollbar-track { background: transparent; }
.ac-scroll-body::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: 999px;
  background: hsl(var(--ac-border-strong));
  background-clip: padding-box;
}
.ac-num {
  font-variant-numeric: tabular-nums;
  font-family: var(--ac-font-mono);
}
.ac-display { font-family: var(--ac-font-display); letter-spacing: -0.025em; }
.ac-header {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 12px 0 18px;
  margin-bottom: 20px;
  border-bottom: 1px solid var(--ac-border);
  -webkit-app-region: drag;
}
.ac-header > div:first-child > div:last-child > div:first-child {
  font-family: var(--ac-font-display);
  font-size: 21px !important;
  font-weight: 600 !important;
  letter-spacing: -0.025em;
  line-height: 1.15;
}
.ac-no-drag { -webkit-app-region: no-drag; }
.ac-card {
  padding: 16px;
  border-radius: 14px;
  border: 1px solid var(--ac-border);
  background: var(--ac-surface);
  box-shadow: var(--ac-shadow-card);
  transition: border-color var(--ac-transition-ui), background-color var(--ac-transition-ui), box-shadow var(--ac-transition-ui);
}
.ac-row-card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  cursor: pointer;
}
.ac-row-card:hover {
  border-color: var(--ac-accent-border);
  background: var(--ac-surface-hover);
  box-shadow: 0 4px 16px hsl(30 15% 20% / 0.05);
}
.ac-btn {
  display: inline-flex;
  min-height: 34px;
  align-items: center;
  justify-content: center;
  gap: 7px;
  border: 1px solid transparent;
  border-radius: 10px;
  padding: 7px 13px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.2;
  cursor: pointer;
  transition:
    background-color var(--ac-transition-ui),
    border-color var(--ac-transition-ui),
    color var(--ac-transition-ui),
    box-shadow var(--ac-transition-ui),
    transform var(--ac-transition-ui);
  -webkit-app-region: no-drag;
}
.ac-btn:not(:disabled):active { transform: translateY(1px); }
.ac-btn:focus-visible, .ac-input:focus-visible, .ac-select:focus-visible, .ac-checkbox:focus-visible {
  outline: 2px solid hsl(207 86% 56%);
  outline-offset: 2px;
}
.ac-btn:disabled { opacity: 0.42; cursor: not-allowed; }
.ac-btn-primary {
  border-color: var(--ac-accent-strong);
  background: var(--ac-accent-strong);
  color: var(--ac-on-accent);
  box-shadow: 0 0 0 1px var(--ac-accent-strong);
}
.ac-btn-primary:hover:not(:disabled) {
  border-color: var(--ac-accent);
  background: var(--ac-accent);
  box-shadow: 0 0 0 1px var(--ac-accent);
}
.ac-btn-ghost {
  border-color: hsl(var(--ac-border-strong) / 0.7);
  background: var(--ac-hover-bg);
  color: var(--ac-text-secondary);
  box-shadow: 0 0 0 1px hsl(var(--ac-border-strong) / 0.2);
}
.ac-btn-ghost:hover:not(:disabled) {
  border-color: var(--ac-border-strong);
  background: var(--ac-surface);
  color: var(--ac-text-primary);
}
.ac-btn-danger {
  border-color: hsl(0 50% 38% / 0.2);
  background: var(--ac-danger-bg);
  color: var(--ac-danger-text);
  font-weight: 600;
}
.ac-btn-danger:hover:not(:disabled) { border-color: hsl(0 50% 38% / 0.35); }
.ac-btn-danger-solid {
  border-color: var(--ac-danger-solid-bg);
  background: var(--ac-danger-solid-bg);
  color: hsl(48 50% 98%);
  font-weight: 600;
}
.ac-btn-danger-solid:hover:not(:disabled) { filter: brightness(1.08); }
.ac-checkbox {
  width: 16px;
  height: 16px;
  margin-top: 3px;
  border-radius: 5px;
  accent-color: var(--ac-accent-strong);
  cursor: pointer;
}
.ac-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: var(--ac-overlay-bg);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}
.ac-modal-card {
  max-width: 440px;
  width: 100%;
  padding: 24px;
  border-radius: 16px;
  border: 1px solid var(--ac-danger-border);
  background: var(--ac-overlay-card);
  box-shadow: var(--ac-overlay-shadow);
  -webkit-app-region: no-drag;
}
.ac-input, .ac-select {
  min-height: 34px;
  border: 1px solid var(--ac-border);
  background: var(--ac-input-bg);
  color: var(--ac-text-primary);
  border-radius: 10px;
  font-size: 12px;
  transition: border-color var(--ac-transition-ui), background-color var(--ac-transition-ui), box-shadow var(--ac-transition-ui);
  -webkit-app-region: no-drag;
}
.ac-input:focus, .ac-select:focus {
  border-color: hsl(var(--ac-accent) / 0.65);
  background: var(--ac-surface);
  box-shadow: 0 0 0 3px hsl(var(--ac-accent) / 0.1);
  outline: none;
}
.ac-input::placeholder { color: var(--ac-text-muted); opacity: 1; }
.ac-input { padding: 7px 11px 7px 30px; min-width: 200px; }
.ac-input-plain {
  min-height: 34px;
  border: 1px solid var(--ac-border);
  background: var(--ac-input-bg);
  color: var(--ac-text-primary);
  border-radius: 10px;
  font-size: 12px;
  padding: 7px 11px;
  transition: border-color var(--ac-transition-ui), background-color var(--ac-transition-ui), box-shadow var(--ac-transition-ui);
  -webkit-app-region: no-drag;
}
.ac-input-plain:focus {
  border-color: hsl(var(--ac-accent) / 0.65);
  background: var(--ac-surface);
  box-shadow: 0 0 0 3px hsl(var(--ac-accent) / 0.1);
  outline: none;
}
.ac-progress-track {
  width: 100%;
  height: 6px;
  border-radius: 999px;
  background: var(--ac-track-bg);
  overflow: hidden;
  margin-top: 12px;
}
.ac-progress-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--ac-accent);
  transition: width 180ms ease-out;
}
.ac-form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 10px;
}
.ac-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 11px;
  color: var(--ac-text-secondary);
}
.ac-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 11px;
  border: 1px solid var(--ac-border);
  background: var(--ac-hover-bg);
  color: var(--ac-text-primary);
}
.ac-select { padding: 6px 10px; cursor: pointer; }
.ac-select option { background: var(--ac-surface); color: var(--ac-text-primary); }
.ac-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border-radius: 999px;
  padding: 3px 9px;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.4;
  white-space: nowrap;
}
@keyframes ac-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
.ac-spin {
  animation: ac-spin 0.9s linear infinite;
}
.ac-spin-reverse {
  animation: ac-spin 1.25s linear infinite reverse;
}
.ac-loading-overlay {
  position: absolute;
  inset: 0;
  z-index: 25;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--ac-overlay-bg);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
}
.ac-loading-card {
  max-width: 340px;
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 26px 28px;
  border-radius: 16px;
  border: 1px solid var(--ac-accent-border);
  background: var(--ac-overlay-card);
  box-shadow: var(--ac-overlay-shadow);
}
.ac-radar {
  position: relative;
  width: 76px;
  height: 76px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.ac-radar-outer {
  position: absolute;
  inset: 0;
  border-radius: 9999px;
  border: 3px solid var(--ac-ring-track);
  border-top-color: var(--ac-accent);
}
.ac-radar-inner {
  position: absolute;
  inset: 10px;
  border-radius: 9999px;
  border: 2px solid var(--ac-border);
  border-bottom-color: var(--ac-accent);
}
.ac-radar-core {
  width: 38px;
  height: 38px;
  border-radius: 9999px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--ac-accent-soft);
  color: var(--ac-accent);
  border: 1px solid var(--ac-accent-border);
}
.ac-loading-card > div:nth-child(2), #ac-confirm-permanent-title {
  font-family: var(--ac-font-display);
  letter-spacing: -0.02em;
}
@media (max-width: 560px) {
  .ac-header-wrap { padding-inline: 16px; }
  .ac-scroll-body { padding-inline: 16px; }
  .ac-header { gap: 12px; }
  .ac-card { padding: 13px; }
  .ac-input { min-width: 160px; }
}
@media (prefers-reduced-motion: reduce) {
  .ac-card, .ac-btn, .ac-input, .ac-select { transition: none !important; }
  .ac-spin, .ac-spin-reverse { animation: none !important; }
}
`;
