import type { SdlcMode } from "../sdlc.ts";
import { aidlcExpress } from "./aidlc-express.ts";
import { bugfix } from "./bugfix.ts";
import { small } from "./small.ts";
import { speckit } from "./speckit.ts";

/** Preset của FR-002. Chỉ đọc; quản trị nhân bản thành chế độ riêng để sửa. */
export const SDLC_PRESET_IDS = [
  "bugfix",
  "small",
  "aidlc-express",
  "aidlc-feature",
  "aidlc-enterprise",
  "speckit",
  "bmad-quick",
  "bmad-method",
  "kiro-requirements",
  "kiro-design",
  "kiro-bugfix",
  "openspec",
] as const;
export type SdlcPresetId = (typeof SDLC_PRESET_IDS)[number];

/**
 * Preset theo id, đã qua `sdlcMode.parse` (mỗi file preset parse lúc nạp nên preset sai làm hỏng test ngay). MVP có
 * `bugfix`, `small`, `aidlc-express`, `speckit` (T002); phần còn lại ở T083, nên kiểu là Partial.
 */
export const SDLC_PRESETS: Readonly<Partial<Record<SdlcPresetId, SdlcMode>>> = {
  bugfix,
  small,
  "aidlc-express": aidlcExpress,
  speckit,
};

export const isSdlcPresetId = (ref: string): ref is SdlcPresetId =>
  (SDLC_PRESET_IDS as readonly string[]).includes(ref);
