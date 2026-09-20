export const BEARER_SETTINGS = [
  { key: "auto_review_enabled", flag: "--auto-review", label: "Auto review" },
  { key: "auto_patch_enabled", flag: "--auto-patch", label: "Auto patch" },
  { key: "vortex_show_thinking_traces", flag: "--vortex-thinking", label: "Vortex thinking traces" },
  { key: "repo_overview_enabled", flag: "--repo-overview", label: "Repo overview" },
  { key: "review_unit_land_prs_enabled", flag: "--review-unit-land", label: "Review Unit land PRs" },
  { key: "cyclone_review_unit_land_prs_enabled", flag: "--cyclone-review-unit-land", label: "Cyclone Review Unit land PRs" },
  { key: "cyclone_skip_ci_enabled", flag: "--cyclone-skip-ci", label: "Skip CI on Cyclone commits" },
  { key: "cyclone_patch_unverified_languages", flag: "--cyclone-patch-unverified", label: "Patch languages we cannot typecheck" },
  { key: "vortex_auto_overflow_enabled", flag: "--vortex-auto-overflow", label: "Vortex auto overflow" },
  { key: "vortex_skip_all_clear_comments", flag: "--vortex-skip-all-clear", label: "Vortex skip All-clear comments" },
  { key: "vortex_seam_specialist_enabled", flag: "--vortex-seam", label: "Vortex seam specialist" },
  { key: "auto_land_default", flag: "--auto-land", label: "Auto land (new stacks)" },
  { key: "ignored_bot_logins", flag: "--ignore-bot", label: "Ignored bot logins", kind: "logins" },
  { key: "vortex_bot_skip_check", flag: "--vortex-skip-check", label: "Vortex bot skip check", kind: "enum", values: ["none", "neutral"] },
  { key: "vortex_findings_check", flag: "--vortex-findings", label: "Vortex findings check", kind: "enum", values: ["failure", "neutral", "success"] },
  { key: "cyclone_patch_failure_check", flag: "--cyclone-fail-check", label: "Cyclone patch failure check", kind: "enum", values: ["failure", "neutral"] },
] as const;

export type BearerSettingsKey = (typeof BEARER_SETTINGS)[number]["key"];

export const BEARER_SETTINGS_KEYS = BEARER_SETTINGS.map((r) => r.key) as unknown as readonly BearerSettingsKey[];

export const BEARER_SETTINGS_FLAGS: Record<string, BearerSettingsKey> = Object.fromEntries(
  BEARER_SETTINGS.map((r) => [r.flag, r.key]),
) as Record<string, BearerSettingsKey>;

export const BEARER_SETTINGS_LABELS: Record<BearerSettingsKey, string> = Object.fromEntries(
  BEARER_SETTINGS.map((r) => [r.key, r.label]),
) as Record<BearerSettingsKey, string>;

/** Omitted kind means boolean for the original toggle rows. */
export type BearerSettingsValues = {
  [Row in (typeof BEARER_SETTINGS)[number] as Row["key"]]:
    Row extends { kind: "logins" } ? string[] :
    Row extends { values: readonly (infer Value)[] } ? Value : boolean;
};

export const BEARER_BOOLEAN_SETTINGS_KEYS = BEARER_SETTINGS
  .filter((row) => !("kind" in row))
  .map((row) => row.key);
