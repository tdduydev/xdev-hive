import type { SdlcMode } from "../sdlc.ts";
import { aidlcEnterprise } from "./aidlc-enterprise.ts";
import { aidlcExpress } from "./aidlc-express.ts";
import { aidlcFeature } from "./aidlc-feature.ts";
import { bmadMethod } from "./bmad-method.ts";
import { bmadQuick } from "./bmad-quick.ts";
import { bugfix } from "./bugfix.ts";
import { kiroBugfix, kiroDesign, kiroRequirements } from "./kiro.ts";
import { openspec } from "./openspec.ts";
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

/** Preset theo id, đã qua `sdlcMode.parse` (mỗi file preset parse lúc nạp nên preset sai làm hỏng test ngay). */
export const SDLC_PRESETS: Readonly<Record<SdlcPresetId, SdlcMode>> = {
  bugfix,
  small,
  "aidlc-express": aidlcExpress,
  "aidlc-feature": aidlcFeature,
  "aidlc-enterprise": aidlcEnterprise,
  speckit,
  "bmad-quick": bmadQuick,
  "bmad-method": bmadMethod,
  "kiro-requirements": kiroRequirements,
  "kiro-design": kiroDesign,
  "kiro-bugfix": kiroBugfix,
  openspec,
};

export const isSdlcPresetId = (ref: string): ref is SdlcPresetId =>
  (SDLC_PRESET_IDS as readonly string[]).includes(ref);
