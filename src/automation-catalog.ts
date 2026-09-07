export const BEARER_SETTINGS = [
  { key: "auto_review_enabled", flag: "--auto-review", label: "Auto review" },
  { key: "auto_patch_enabled", flag: "--auto-patch", label: "Auto patch" },
  { key: "vortex_show_thinking_traces", flag: "--vortex-thinking", label: "Vortex thinking traces" },
  { key: "repo_overview_enabled", flag: "--repo-overview", label: "Repo overview" },
  { key: "review_unit_land_prs_enabled", flag: "--review-unit-land", label: "Review Unit land PRs" },
  { key: "cyclone_review_unit_land_prs_enabled", flag: "--cyclone-review-unit-land", label: "Cyclone Review Unit land PRs" },
  { key: "cyclone_skip_ci_enabled", flag: "--cyclone-skip-ci", label: "Skip CI on Cyclone commits" },
  { key: "vortex_seam_specialist_enabled", flag: "--vortex-seam", label: "Vortex seam specialist" },
  { key: "auto_land_default", flag: "--auto-land", label: "Auto land (new stacks)" },
] as const;

export type BearerSettingsKey = (typeof BEARER_SETTINGS)[number]["key"];

export const BEARER_SETTINGS_KEYS = BEARER_SETTINGS.map((r) => r.key) as unknown as readonly BearerSettingsKey[];

export const BEARER_SETTINGS_FLAGS: Record<string, BearerSettingsKey> = Object.fromEntries(
  BEARER_SETTINGS.map((r) => [r.flag, r.key]),
) as Record<string, BearerSettingsKey>;

export const BEARER_SETTINGS_LABELS: Record<BearerSettingsKey, string> = Object.fromEntries(
  BEARER_SETTINGS.map((r) => [r.key, r.label]),
) as Record<BearerSettingsKey, string>;
