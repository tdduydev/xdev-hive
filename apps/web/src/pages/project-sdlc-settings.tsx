import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  DEFAULT_ORG_SDLC_POLICY,
  isHeavySdlc,
  type OrgSdlcPolicy,
  type Project,
  type ProjectSdlcSettings,
  projectSdlcSettings,
  type SdlcBlocking,
  type SdlcMode,
  type SdlcModeView,
} from "@xdev-hive/contracts";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { Textarea } from "@xdev-hive/ui/textarea";
import { LockIcon } from "lucide-react";
import { useId, useState } from "react";
import { ChipInput } from "@/components/page/chip-input.tsx";
import { FormRow, RadioCards, type SectionSave, SettingsSection, SwitchRow } from "@/components/page/settings.tsx";
import { UnitField } from "@/components/page/unit-field.tsx";
import { UnsavedChangesGuard } from "@/components/page/unsaved-guard.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { useOrg } from "@/shell/org-context.ts";

/*
 * Mục AI SDLC và Tự duyệt AI trong cài đặt dự án (specs/011 T054, ProjectSettings.dc.html #sdlc, #sdlc-auto). Cả hai mục
 * cùng ghi `settings.sdlc` nhưng lưu riêng: lưu một mục thì phần của mục kia lấy từ bản đã lưu, không lấy bản nháp.
 */

const text: Dict<{
  sdlcTitle: string;
  sdlcHint: string;
  sdlcOn: string;
  sdlcOnHint: string;
  defMode: string;
  defModeNone: string;
  blocking: string;
  blockingHint: string;
  bMode: string;
  bSoft: string;
  bHard: string;
  allowedModes: string;
  allowedModesHint: string;
  heavy: string;
  modesLoading: string;
  modesFailed: (e: string) => string;
  repoSync: string;
  readonlyNote: string;
  syncPr: string;
  syncPrHint: string;
  syncDirect: string;
  syncDirectHint: string;
  syncOff: string;
  syncOffHint: string;
  docsRoot: string;
  docsRootHint: string;
  parallel: string;
  parallelHint: string;
  autoWaves: string;
  autoWavesHint: string;
  runner: string;
  runTeam: string;
  runTeamHint: string;
  runRequester: string;
  runRequesterHint: string;
  labels: string;
  labelsHint: string;
  labelAdd: string;
  risk: string;
  riskHint: string;
  riskAdd: string;
  partNote: string;
  autoTitle: string;
  autoHint: string;
  orgOnBadge: string;
  orgOffBadge: string;
  orgOn: (floor: number) => string;
  orgOff: string;
  orgOffHint: string;
  orgLink: string;
  autoOn: string;
  autoOnHint: string;
  minScore: string;
  minScoreHint: (floor: number) => string;
  revoke: string;
  revokeHint: string;
  hours: string;
  phases: string;
  phasesHint: (mode: string) => string;
  phasesNoMode: string;
  phasesNone: string;
  phaseLocked: string;
  phaseHeavy: string;
  phaseAt: (score: number, hours: number) => string;
  contractNote: string;
  keywords: string;
  keywordsHint: string;
  keywordAdd: string;
  fromOrg: string;
  paths: string;
  pathsHint: string;
  effective: (mode: string) => string;
  effectiveBody: (auto: string, manual: string) => string;
  effectiveNone: string;
  effectiveOrgOff: string;
  pickPhase: string;
  notNumber: string;
  invalid: string;
  saved: string;
}> = {
  vi: {
    sdlcTitle: "AI SDLC",
    sdlcHint:
      "Bật chế độ vòng đời cho dự án: hạng mục đi từ ý tưởng tới tài liệu đã duyệt, task có phụ thuộc, PR đã review.",
    sdlcOn: "Bật AI SDLC cho dự án",
    sdlcOnHint: "Tắt thì task, run, review và merge chạy như cũ; hạng mục đang mở chuyển sang Tạm dừng.",
    defMode: "Chế độ mặc định",
    defModeNone: "Chưa chọn",
    blocking: "Mức chặn",
    blockingHint: "Chỉ chặt hơn chế độ: chọn mức thấp hơn thì chế độ vẫn giữ mức của nó.",
    bMode: "Theo chế độ",
    bSoft: "Cảnh báo (soft)",
    bHard: "Chặn cứng (hard)",
    allowedModes: "Chế độ được dùng",
    allowedModesHint: "Bỏ chọn hết thì chỉ dùng chế độ mặc định.",
    heavy: "Nặng",
    modesLoading: "Đang tải chế độ…",
    modesFailed: (e) => `Không tải được chế độ: ${e}`,
    repoSync: "Ghi tài liệu đã duyệt vào repo",
    readonlyNote: "Kết nối Git chỉ đọc thì chỉ lưu trên hub; agent vẫn đọc tài liệu qua seed file.",
    syncPr: "Pull request (mặc định)",
    syncPrHint: "Mỗi repo một PR hive/sdlc/NNN-slug, vào hàng merge, không review code lại.",
    syncDirect: "Commit thẳng",
    syncDirectHint: "Vào nhánh mặc định không bảo vệ.",
    syncOff: "Không ghi vào repo",
    syncOffHint: "Tài liệu chỉ nằm trên hub.",
    docsRoot: "Thư mục gốc tài liệu",
    docsRootHint: "Bỏ trống là đường dẫn của chế độ. Mục này áp cho khuôn dùng {docsRoot}.",
    parallel: "Mức song song",
    parallelHint: "Số run code của hạng mục chạy cùng lúc, từ 1 đến 10.",
    autoWaves: "Tự chạy đợt",
    autoWavesHint: "Task xong thì hub xét đợt kế mà không chờ người bấm Chạy đợt.",
    runner: "Nơi chạy agent",
    runTeam: "Máy AI SDLC dùng chung của đội (mặc định)",
    runTeamHint: "Run không gắn người, chỉ chạy trên máy dùng chung có nhãn yêu cầu.",
    runRequester: "Máy của người bấm",
    runRequesterHint: "Run của người nào chạy trên máy của người đó.",
    labels: "Nhãn máy yêu cầu",
    labelsHint: "Run chỉ giao cho máy có đủ nhãn. Tối đa 5.",
    labelAdd: "Thêm nhãn",
    risk: "Từ khoá rủi ro",
    riskHint: "Dùng để gợi ý cỡ L khi ý tưởng có từ khoá. Không phải danh sách tự duyệt.",
    riskAdd: "Thêm từ khoá",
    partNote:
      "Khi dự án này là dự án tham gia của hạng mục khác, mức song song, nhãn máy và nơi chạy lấy từ mục này cho task của dự án.",
    autoTitle: "Tự duyệt AI",
    autoHint:
      "Hub tự quyết cổng người khi review AI của giai đoạn đạt ngưỡng. Dự án chỉ siết thêm được so với chế độ và tổ chức.",
    orgOnBadge: "Tổ chức cho phép",
    orgOffBadge: "Tổ chức đã tắt",
    orgOn: (floor) =>
      `Sàn ngưỡng của tổ chức là ${floor}/10. Từ khoá và đường dẫn nhạy cảm của tổ chức luôn áp dụng. Xem`,
    orgOff: "Tổ chức đã tắt tự duyệt; cài đặt dưới đây chưa có tác dụng.",
    orgOffHint: "Quản trị tổ chức bật lại ở",
    orgLink: "Chính sách agent",
    autoOn: "Bật tự duyệt cho dự án",
    autoOnHint: "Mặc định tắt. Bật thì chỉ giai đoạn chế độ cho phép mới tự duyệt.",
    minScore: "Ngưỡng điểm",
    minScoreHint: (floor) => `Chỉ có tác dụng khi cao hơn ngưỡng của chế độ và sàn tổ chức (${floor}).`,
    revoke: "Hạn thu hồi",
    revokeHint: "Chỉ có tác dụng khi dài hơn hạn của chế độ. Từ 1 đến 168.",
    hours: "giờ",
    phases: "Giai đoạn được tự duyệt",
    phasesHint: (mode) => `Theo chế độ mặc định ${mode}. Bỏ chọn là bớt giai đoạn.`,
    phasesNoMode: "Chọn chế độ mặc định ở mục AI SDLC để chọn giai đoạn.",
    phasesNone: "Chế độ này không có cổng người nào.",
    phaseLocked: "Chế độ không cho tự duyệt",
    phaseHeavy: "Chế độ nặng, yêu cầu luôn cần người",
    phaseAt: (score, hours) => `≥ ${score} · ${hours} giờ`,
    contractNote: "Contract liên repo luôn cần người duyệt.",
    keywords: "Từ khoá nhạy cảm của dự án",
    keywordsHint: "Thêm vào danh sách của tổ chức, không thay thế. Chip có khoá là của tổ chức.",
    keywordAdd: "Thêm từ khoá nhạy cảm",
    fromOrg: "Từ chính sách tổ chức",
    paths: "Đường dẫn nhạy cảm của dự án",
    pathsHint: "Mỗi dòng một mẫu glob, cộng với danh sách của tổ chức.",
    effective: (mode) => `Hiệu lực với hạng mục chế độ ${mode}`,
    effectiveBody: (auto, manual) =>
      `${auto} tự duyệt khi review AI đạt ngưỡng ghi bên cạnh.${manual ? ` ${manual} luôn chờ người.` : ""}`,
    effectiveNone: "Chưa giai đoạn nào tự duyệt.",
    effectiveOrgOff: "Tổ chức đã tắt tự duyệt nên mọi cổng chờ người.",
    pickPhase: "Chọn ít nhất một giai đoạn, hoặc tắt tự duyệt.",
    notNumber: "Nhập một số.",
    invalid: "Có ô chưa hợp lệ, xem lỗi ở từng ô.",
    saved: "Đã lưu",
  },
  en: {
    sdlcTitle: "AI SDLC",
    sdlcHint:
      "Turn on the lifecycle mode: items go from an idea to approved documents, tasks with dependencies and reviewed PRs.",
    sdlcOn: "Enable AI SDLC for this project",
    sdlcOnHint: "When off, tasks, runs, reviews and merges work as before; open items move to Paused.",
    defMode: "Default mode",
    defModeNone: "Not chosen",
    blocking: "Blocking",
    blockingHint: "Only tightens the mode: a looser choice keeps the mode's own level.",
    bMode: "Follow the mode",
    bSoft: "Warn (soft)",
    bHard: "Block (hard)",
    allowedModes: "Allowed modes",
    allowedModesHint: "Leave all unchecked to use only the default mode.",
    heavy: "Heavy",
    modesLoading: "Loading modes…",
    modesFailed: (e) => `Could not load modes: ${e}`,
    repoSync: "Write approved documents to the repo",
    readonlyNote: "With a read-only Git connection they stay on the hub; agents still read them through seed files.",
    syncPr: "Pull request (default)",
    syncPrHint: "One PR per repo on hive/sdlc/NNN-slug, queued for merge, no second code review.",
    syncDirect: "Direct commit",
    syncDirectHint: "Into an unprotected default branch.",
    syncOff: "Do not write to the repo",
    syncOffHint: "Documents stay on the hub only.",
    docsRoot: "Documents root",
    docsRootHint: "Empty uses the mode path. Applies to templates that use {docsRoot}.",
    parallel: "Parallelism",
    parallelHint: "Code runs of an item running at once, 1 to 10.",
    autoWaves: "Run waves automatically",
    autoWavesHint: "When tasks finish, the hub starts the next wave without waiting for Run wave.",
    runner: "Where agents run",
    runTeam: "Team shared AI SDLC machines (default)",
    runTeamHint: "Runs belong to no person and use only shared machines with the required labels.",
    runRequester: "Requester machine",
    runRequesterHint: "Each run uses the machine of whoever started it.",
    labels: "Required machine labels",
    labelsHint: "Runs only go to machines with every label. Up to 5.",
    labelAdd: "Add label",
    risk: "Risk keywords",
    riskHint: "Suggest size L when the idea has one. Not the auto-approval list.",
    riskAdd: "Add keyword",
    partNote:
      "When this project takes part in another project's item, its tasks use the parallelism, labels and runner set here.",
    autoTitle: "AI auto-approval",
    autoHint:
      "The hub decides a human gate when the AI review of the phase reaches the threshold. Projects can only tighten the mode and the organization.",
    orgOnBadge: "Allowed by the organization",
    orgOffBadge: "Turned off by the organization",
    orgOn: (floor) =>
      `The organization floor is ${floor}/10. Organization sensitive keywords and paths always apply. See`,
    orgOff: "The organization turned auto-approval off; the settings below have no effect.",
    orgOffHint: "Organization admins can turn it back on in",
    orgLink: "Agent policies",
    autoOn: "Enable auto-approval for this project",
    autoOnHint: "Off by default. When on, only phases the mode allows are auto-approved.",
    minScore: "Score threshold",
    minScoreHint: (floor) => `Only applies when higher than the mode threshold and the organization floor (${floor}).`,
    revoke: "Revoke window",
    revokeHint: "Only applies when longer than the mode window. 1 to 168.",
    hours: "hours",
    phases: "Phases auto-approved",
    phasesHint: (mode) => `From the default mode ${mode}. Uncheck to drop a phase.`,
    phasesNoMode: "Pick a default mode in AI SDLC to choose phases.",
    phasesNone: "This mode has no human gate.",
    phaseLocked: "The mode does not allow it",
    phaseHeavy: "Heavy mode, requirements always need a person",
    phaseAt: (score, hours) => `≥ ${score} · ${hours} h`,
    contractNote: "Cross-repo contracts always need a person.",
    keywords: "Project sensitive keywords",
    keywordsHint: "Added to the organization list, not replacing it. Locked chips come from the organization.",
    keywordAdd: "Add sensitive keyword",
    fromOrg: "From the organization policy",
    paths: "Project sensitive paths",
    pathsHint: "One glob per line, on top of the organization list.",
    effective: (mode) => `In effect for ${mode} items`,
    effectiveBody: (auto, manual) =>
      `${auto} auto-approve when the AI review reaches the threshold shown.${manual ? ` ${manual} always wait for a person.` : ""}`,
    effectiveNone: "No phase is auto-approved.",
    effectiveOrgOff: "The organization turned auto-approval off, so every gate waits for a person.",
    pickPhase: "Pick at least one phase, or turn auto-approval off.",
    notNumber: "Enter a number.",
    invalid: "Some fields are invalid; see the errors on each field.",
    saved: "Saved",
  },
};

type Section = "sdlc" | "sdlc-auto";
type Errors = Record<string, string>;

interface MainForm {
  enabled: boolean;
  defaultMode: string;
  modes: string[];
  blocking: "" | SdlcBlocking;
  repoSync: ProjectSdlcSettings["repoSync"];
  docsRoot: string;
  maxParallel: string;
  autoRunWaves: boolean;
  runner: ProjectSdlcSettings["runner"];
  labels: string[];
  riskKeywords: string[];
}

interface AutoForm {
  enabled: boolean;
  minScore: string;
  revokeHours: string;
  /** null: mọi giai đoạn chế độ cho phép (hub coi danh sách rỗng là không giới hạn). */
  phases: string[] | null;
  denyKeywords: string[];
  denyPaths: string;
}

const current = (project: Project) => projectSdlcSettings.parse(project.settings.sdlc ?? {});

function mainForm(s: ProjectSdlcSettings): MainForm {
  return {
    enabled: s.enabled,
    defaultMode: s.defaultMode ?? "",
    modes: s.modes,
    blocking: s.blocking ?? "",
    repoSync: s.repoSync,
    docsRoot: s.docsRoot ?? "",
    maxParallel: String(s.maxParallel),
    autoRunWaves: s.autoRunWaves,
    runner: s.runner,
    labels: s.labels,
    riskKeywords: s.riskKeywords,
  };
}

function autoForm(s: ProjectSdlcSettings): AutoForm {
  const a = s.autoApprove;
  return {
    enabled: a.enabled,
    minScore: a.minScore === undefined ? "" : String(a.minScore),
    revokeHours: a.revokeHours === undefined ? "" : String(a.revokeHours),
    phases: a.phases?.length ? a.phases : null,
    denyKeywords: a.denyKeywords,
    denyPaths: a.denyPaths.join("\n"),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Số tuỳ chọn: ô trống là bỏ, chữ không phải số thì báo lỗi ở ô đó thay vì gửi NaN lên hub. */
function optionalNumber(value: string, field: string, errors: Errors, message: string): number | undefined {
  const v = value.trim().replace(",", ".");
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isNaN(n)) errors[field] = message;
  return n;
}

/** Ghép bản nháp của một mục với phần đã lưu của mục kia, rồi kiểm bằng schema của hub để lỗi hiện đúng ô. */
export function buildSdlcSettings(
  section: Section,
  main: MainForm,
  auto: AutoForm,
  saved: ProjectSdlcSettings,
  messages: { notNumber: string; pickPhase: string },
): { ok: true; value: ProjectSdlcSettings } | { ok: false; errors: Errors } {
  const errors: Errors = {};
  let value: Record<string, unknown> = { ...saved };
  if (section === "sdlc") {
    const maxParallel = optionalNumber(main.maxParallel, "maxParallel", errors, messages.notNumber);
    value = {
      ...value,
      enabled: main.enabled,
      defaultMode: main.defaultMode || null,
      modes: main.modes,
      blocking: main.blocking || undefined,
      repoSync: main.repoSync,
      docsRoot: main.docsRoot.trim() || undefined,
      maxParallel: maxParallel ?? saved.maxParallel,
      autoRunWaves: main.autoRunWaves,
      runner: main.runner,
      labels: main.labels,
      riskKeywords: main.riskKeywords,
    };
  } else {
    if (auto.enabled && auto.phases?.length === 0) errors["autoApprove.phases"] = messages.pickPhase;
    value = {
      ...value,
      autoApprove: {
        enabled: auto.enabled,
        minScore: optionalNumber(auto.minScore, "autoApprove.minScore", errors, messages.notNumber),
        revokeHours: optionalNumber(auto.revokeHours, "autoApprove.revokeHours", errors, messages.notNumber),
        phases: auto.phases?.length ? auto.phases : undefined,
        denyPaths: auto.denyPaths
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean),
        denyKeywords: auto.denyKeywords,
      },
    };
  }
  // undefined trong object vẫn là khoá có mặt; bỏ hẳn để `.strict()` và bản vá của hub không thấy khoá rỗng.
  const clean = JSON.parse(JSON.stringify(value));
  const parsed = projectSdlcSettings.strict().safeParse(clean);
  if (!parsed.success)
    for (const issue of parsed.error.issues) {
      const field = issue.path.slice(0, issue.path[0] === "autoApprove" ? 2 : 1).join(".");
      errors[field] ??= issue.message;
    }
  if (Object.keys(errors).length || !parsed.success) return { ok: false, errors };
  return { ok: true, value: parsed.data };
}

interface PhaseRow {
  id: string;
  name: string;
  gates: string;
  /** Lý do khoá; null là chế độ cho tự duyệt. */
  locked: string | null;
  score: number;
  hours: number;
}

/** Giai đoạn có cổng người của chế độ, kèm ngưỡng và hạn thu hồi hiệu lực như hub tính (autoapprove.ts `decide`). */
function phaseRows(
  mode: SdlcMode,
  floor: number,
  auto: { minScore?: number | undefined; revokeHours?: number | undefined },
  t: { phaseLocked: string; phaseHeavy: string },
): PhaseRow[] {
  return mode.phases.flatMap((p) => {
    const human = p.gate.flatMap((g) => g.gates).filter((g) => g.kind === "human");
    if (!human.length) return [];
    const rule = p.autoApprove;
    const heavy = p.kind === "requirements" && isHeavySdlc(mode.sizes);
    return [
      {
        id: p.id,
        name: p.name,
        gates: human.map((g) => g.name).join(", "),
        locked: heavy ? t.phaseHeavy : rule ? null : t.phaseLocked,
        score: Math.max(rule?.minScore ?? 0, floor, auto.minScore ?? 0),
        hours: Math.max(rule?.revokeHours ?? 24, auto.revokeHours ?? 0),
      },
    ];
  });
}

export function ProjectSdlcSections({
  project,
  canEdit,
  orgPolicy,
}: {
  project: Project;
  canEdit: boolean;
  orgPolicy: OrgSdlcPolicy | undefined;
}) {
  const { api } = useOrg();
  const t = useT(text);
  const queryClient = useQueryClient();
  const org = (orgPolicy ?? DEFAULT_ORG_SDLC_POLICY).autoApprove;
  const [saved, setSaved] = useState(() => current(project));
  const [main, setMain] = useState(() => mainForm(saved));
  const [auto, setAuto] = useState(() => autoForm(saved));
  const [errors, setErrors] = useState<Errors>({});
  const [results, setResults] = useState<Partial<Record<Section, { done?: true; failure?: string }>>>({});
  const ids = { mode: useId(), blocking: useId(), docsRoot: useId(), paths: useId() };
  const modes = useQuery({
    ...api.sdlc.modes.list.queryOptions({ input: { teamId: project.teamId } }),
    retry: false,
  });
  const enabledModes = (modes.data ?? []).filter((m) => m.enabled);
  const defaultMode = enabledModes.find((m) => m.slug === main.defaultMode);

  const save = useMutation({
    mutationFn: ({ value }: { section: Section; value: ProjectSdlcSettings }) =>
      api.projects.updateSettings.call({ key: project.key, settings: { sdlc: value } }),
    onSuccess: async (next, { section }) => {
      const s = projectSdlcSettings.parse(next.sdlc ?? {});
      setSaved(s);
      if (section === "sdlc") setMain(mainForm(s));
      else setAuto(autoForm(s));
      setResults((r) => ({ ...r, [section]: { done: true } }));
      await queryClient.invalidateQueries({ queryKey: api.projects.key() });
    },
    onError: (error, { section }) => setResults((r) => ({ ...r, [section]: { failure: apiErrorMessage(error) } })),
  });

  const dirty: Record<Section, boolean> = {
    sdlc: !same(main, mainForm(saved)),
    "sdlc-auto": !same(auto, autoForm(saved)),
  };
  const ownFields = (section: Section) => (field: string) =>
    section === "sdlc-auto" ? field.startsWith("autoApprove") : !field.startsWith("autoApprove");
  const clear = (section: Section) =>
    setErrors((e) => Object.fromEntries(Object.entries(e).filter(([f]) => !ownFields(section)(f))));
  const touch = (section: Section) => {
    if (results[section]) setResults((r) => ({ ...r, [section]: {} }));
  };
  const setM = <K extends keyof MainForm>(k: K, v: MainForm[K]) => {
    touch("sdlc");
    setMain((f) => ({ ...f, [k]: v }));
  };
  const setA = <K extends keyof AutoForm>(k: K, v: AutoForm[K]) => {
    touch("sdlc-auto");
    setAuto((f) => ({ ...f, [k]: v }));
  };

  const sectionSave = (section: Section): SectionSave | undefined => {
    if (!canEdit) return undefined;
    return {
      dirty: dirty[section],
      saving: save.isPending && save.variables?.section === section,
      disabled: save.isPending,
      saved: results[section]?.done === true,
      error: results[section]?.failure,
      savedLabel: t.saved,
      onSave: () => {
        clear(section);
        const built = buildSdlcSettings(section, main, auto, saved, t);
        if (!built.ok) {
          setErrors((e) => ({ ...e, ...built.errors }));
          setResults((r) => ({ ...r, [section]: { failure: t.invalid } }));
          return;
        }
        setResults((r) => ({ ...r, [section]: {} }));
        save.mutate({ section, value: built.value });
      },
      onDiscard: () => {
        clear(section);
        setResults((r) => ({ ...r, [section]: {} }));
        if (section === "sdlc") setMain(mainForm(saved));
        else setAuto(autoForm(saved));
      },
    };
  };

  const disabled = !canEdit || save.isPending;
  const numberOr = (v: string) => {
    const n = Number(v.trim().replace(",", "."));
    return v.trim() && !Number.isNaN(n) ? n : undefined;
  };
  const rows = defaultMode
    ? phaseRows(
        defaultMode.definition,
        org.minScoreFloor,
        { minScore: numberOr(auto.minScore), revokeHours: numberOr(auto.revokeHours) },
        t,
      )
    : [];
  const free = rows.filter((r) => !r.locked);
  // Giai đoạn đã lưu mà chế độ mặc định không có (của chế độ khác) được giữ nguyên khi bỏ chọn ở đây.
  const others = (auto.phases ?? []).filter((id) => !free.some((r) => r.id === id));
  const chosen = (id: string) => auto.phases === null || auto.phases.includes(id);
  const flipPhase = (id: string, on: boolean) => {
    const next = free.filter((r) => (r.id === id ? on : chosen(r.id))).map((r) => r.id);
    setA("phases", next.length === free.length && !others.length ? null : [...others, ...next]);
  };
  const autoNames = free.filter((r) => chosen(r.id)).map((r) => r.name);
  const manualNames = rows.filter((r) => r.locked || !chosen(r.id)).map((r) => r.name);

  return (
    <>
      <UnsavedChangesGuard when={dirty.sdlc || dirty["sdlc-auto"]} />
      <SettingsSection id="sdlc" save={sectionSave("sdlc")} title={t.sdlcTitle} description={t.sdlcHint}>
        <SwitchRow
          label={t.sdlcOn}
          hint={t.sdlcOnHint}
          checked={main.enabled}
          onChange={(v) => setM("enabled", v)}
          disabled={disabled}
        />
        {main.enabled && (
          <>
            <FormRow label={t.defMode} htmlFor={ids.mode}>
              <ModeSelect
                id={ids.mode}
                modes={modes}
                list={enabledModes}
                value={main.defaultMode}
                onChange={(v) => setM("defaultMode", v)}
                disabled={disabled}
                error={errors.defaultMode}
              />
            </FormRow>
            <FormRow label={t.blocking} hint={t.blockingHint} htmlFor={ids.blocking}>
              <NativeSelect
                id={ids.blocking}
                value={main.blocking}
                onChange={(e) => setM("blocking", e.currentTarget.value as MainForm["blocking"])}
                disabled={disabled}
              >
                <option value="">{t.bMode}</option>
                <option value="soft">{t.bSoft}</option>
                <option value="hard">{t.bHard}</option>
              </NativeSelect>
            </FormRow>
            <FormRow label={t.allowedModes} hint={t.allowedModesHint}>
              <ul className="m-0 grid list-none gap-2 p-0">
                {enabledModes.map((m) => (
                  <li key={m.ref}>
                    {/* biome-ignore lint/a11y/noLabelWithoutControl: Checkbox của Base UI là button nằm trong nhãn. */}
                    <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-3 has-data-checked:border-primary has-data-checked:bg-accent/40">
                      <Checkbox
                        className="mt-0.5"
                        checked={main.modes.includes(m.slug)}
                        onCheckedChange={(on) =>
                          setM("modes", on ? [...main.modes, m.slug] : main.modes.filter((x) => x !== m.slug))
                        }
                        disabled={disabled}
                      />
                      <span className="grid min-w-0 flex-1 gap-0.5">
                        <strong className="font-medium text-foreground">{m.definition.name}</strong>
                        {m.definition.description && (
                          <span className="text-xs text-muted-foreground">{m.definition.description}</span>
                        )}
                      </span>
                      {isHeavySdlc(m.definition.sizes) && <Pill small>{t.heavy}</Pill>}
                    </label>
                  </li>
                ))}
              </ul>
              {errors.modes && <p className="text-xs text-destructive">{errors.modes}</p>}
            </FormRow>
            <FormRow label={t.repoSync} hint={t.readonlyNote}>
              <RadioCards
                name="sdlcRepoSync"
                label={t.repoSync}
                value={main.repoSync}
                onChange={(v) => setM("repoSync", v)}
                disabled={disabled}
                options={[
                  { value: "pr", title: t.syncPr, description: t.syncPrHint },
                  { value: "direct", title: t.syncDirect, description: t.syncDirectHint },
                  { value: "off", title: t.syncOff, description: t.syncOffHint },
                ]}
              />
            </FormRow>
            <FormRow label={t.docsRoot} hint={t.docsRootHint} htmlFor={ids.docsRoot}>
              <input
                id={ids.docsRoot}
                value={main.docsRoot}
                onChange={(e) => setM("docsRoot", e.currentTarget.value)}
                disabled={disabled}
                placeholder="specs/"
                spellCheck={false}
                aria-invalid={errors.docsRoot ? true : undefined}
                className="h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 aria-invalid:border-destructive dark:bg-input/30"
              />
              {errors.docsRoot && <p className="text-xs text-destructive">{errors.docsRoot}</p>}
            </FormRow>
            <div className="grid gap-4 sm:grid-cols-2">
              <UnitField
                label={t.parallel}
                hint={t.parallelHint}
                error={errors.maxParallel}
                value={main.maxParallel}
                onChange={(v) => setM("maxParallel", v)}
                disabled={disabled}
                inputMode="numeric"
              />
            </div>
            <SwitchRow
              label={t.autoWaves}
              hint={t.autoWavesHint}
              checked={main.autoRunWaves}
              onChange={(v) => setM("autoRunWaves", v)}
              disabled={disabled}
            />
            <FormRow label={t.runner}>
              <RadioCards
                name="sdlcRunner"
                label={t.runner}
                value={main.runner}
                onChange={(v) => setM("runner", v)}
                disabled={disabled}
                options={[
                  { value: "team", title: t.runTeam, description: t.runTeamHint },
                  { value: "requester", title: t.runRequester, description: t.runRequesterHint },
                ]}
              />
            </FormRow>
            <FormRow label={t.labels} hint={t.labelsHint}>
              <ChipInput
                boxed
                values={main.labels}
                onChange={(v) => setM("labels", v)}
                canWrite={!disabled}
                addLabel={t.labelAdd}
                placeholder={t.labelAdd}
              />
              {errors.labels && <p className="text-xs text-destructive">{errors.labels}</p>}
            </FormRow>
            <FormRow label={t.risk} hint={t.riskHint}>
              <ChipInput
                boxed
                values={main.riskKeywords}
                onChange={(v) => setM("riskKeywords", v)}
                canWrite={!disabled}
                addLabel={t.riskAdd}
                placeholder={t.riskAdd}
              />
              {errors.riskKeywords && <p className="text-xs text-destructive">{errors.riskKeywords}</p>}
            </FormRow>
            <p role="note" className="rounded-lg bg-muted px-3.5 py-2.5 text-xs text-muted-foreground">
              {t.partNote}
            </p>
          </>
        )}
      </SettingsSection>

      <SettingsSection
        id="sdlc-auto"
        save={sectionSave("sdlc-auto")}
        title={t.autoTitle}
        description={t.autoHint}
        actions={<Pill tone={org.allowed ? "ok" : "warn"}>{org.allowed ? t.orgOnBadge : t.orgOffBadge}</Pill>}
      >
        {org.allowed ? (
          <p className="text-xs text-muted-foreground">
            {t.orgOn(org.minScoreFloor)}{" "}
            <Link to="/admin/policies" hash="sdlc" className="font-medium text-primary hover:text-primary/90">
              {t.orgLink}
            </Link>
            .
          </p>
        ) : (
          <div role="status" className="rounded-lg bg-warning-soft px-3.5 py-2.5 text-sm text-warning">
            {t.orgOff}
            <p className="text-xs">
              {t.orgOffHint}{" "}
              <Link to="/admin/policies" hash="sdlc" className="font-semibold text-inherit underline">
                {t.orgLink}
              </Link>
              .
            </p>
          </div>
        )}
        <SwitchRow
          label={t.autoOn}
          hint={t.autoOnHint}
          checked={auto.enabled}
          onChange={(v) => setA("enabled", v)}
          disabled={disabled}
        />
        {auto.enabled && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <UnitField
                label={t.minScore}
                hint={t.minScoreHint(org.minScoreFloor)}
                error={errors["autoApprove.minScore"]}
                value={auto.minScore}
                onChange={(v) => setA("minScore", v)}
                disabled={disabled}
                inputMode="decimal"
                placeholder={String(org.minScoreFloor)}
                suffix="/ 10"
              />
              <UnitField
                label={t.revoke}
                hint={t.revokeHint}
                error={errors["autoApprove.revokeHours"]}
                value={auto.revokeHours}
                onChange={(v) => setA("revokeHours", v)}
                disabled={disabled}
                inputMode="numeric"
                placeholder="24"
                suffix={t.hours}
              />
            </div>
            <FormRow label={t.phases} hint={defaultMode ? t.phasesHint(defaultMode.definition.name) : t.phasesNoMode}>
              {defaultMode && !rows.length && <p className="text-sm text-muted-foreground">{t.phasesNone}</p>}
              {rows.length > 0 && (
                <ul className="m-0 grid list-none gap-2 p-0">
                  {rows.map((r) => (
                    <li
                      key={r.id}
                      className={`flex flex-wrap items-center gap-2.5 rounded-lg border border-border p-3 ${r.locked ? "bg-muted" : ""}`}
                    >
                      <Checkbox
                        aria-label={r.name}
                        checked={!r.locked && chosen(r.id)}
                        onCheckedChange={(on) => flipPhase(r.id, on)}
                        disabled={disabled || r.locked !== null}
                      />
                      <span className="grid min-w-0 flex-1 basis-40 gap-0.5">
                        <span className="font-medium text-foreground">{r.name}</span>
                        <span className="text-xs text-muted-foreground">{r.gates}</span>
                      </span>
                      {r.locked ? (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <LockIcon aria-hidden="true" className="size-3.5" />
                          {r.locked}
                        </span>
                      ) : (
                        <span className="font-mono text-xs text-muted-foreground">{t.phaseAt(r.score, r.hours)}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-muted-foreground">{t.contractNote}</p>
              {errors["autoApprove.phases"] && (
                <p className="text-xs text-destructive">{errors["autoApprove.phases"]}</p>
              )}
            </FormRow>
            <FormRow label={t.keywords} hint={t.keywordsHint}>
              <span className="flex flex-wrap gap-1">
                {org.denyKeywords.map((k) => (
                  <span
                    key={k}
                    title={t.fromOrg}
                    className="inline-flex h-6 items-center gap-1 rounded-full bg-muted px-2 font-mono text-xs text-muted-foreground"
                  >
                    <LockIcon aria-hidden="true" className="size-3" />
                    {k}
                  </span>
                ))}
              </span>
              <ChipInput
                boxed
                values={auto.denyKeywords}
                onChange={(v) => setA("denyKeywords", v)}
                canWrite={!disabled}
                addLabel={t.keywordAdd}
                placeholder={t.keywordAdd}
              />
              {errors["autoApprove.denyKeywords"] && (
                <p className="text-xs text-destructive">{errors["autoApprove.denyKeywords"]}</p>
              )}
            </FormRow>
            <FormRow label={t.paths} hint={t.pathsHint} htmlFor={ids.paths}>
              <Textarea
                id={ids.paths}
                rows={3}
                value={auto.denyPaths}
                onChange={(e) => setA("denyPaths", e.currentTarget.value)}
                disabled={disabled}
                spellCheck={false}
                placeholder={"src/billing/**\ndb/migrations/**"}
                className="font-mono text-sm"
                aria-invalid={errors["autoApprove.denyPaths"] ? true : undefined}
              />
              {errors["autoApprove.denyPaths"] && (
                <p className="text-xs text-destructive">{errors["autoApprove.denyPaths"]}</p>
              )}
            </FormRow>
            {defaultMode && (
              <p role="note" className="grid gap-0.5 rounded-lg bg-accent/40 px-3.5 py-2.5 text-sm">
                <strong className="font-medium text-foreground">{t.effective(defaultMode.definition.name)}</strong>
                <span className="text-xs text-muted-foreground">
                  {!org.allowed
                    ? t.effectiveOrgOff
                    : autoNames.length
                      ? t.effectiveBody(autoNames.join(", "), manualNames.join(", "))
                      : t.effectiveNone}
                </span>
              </p>
            )}
          </>
        )}
      </SettingsSection>
    </>
  );
}

function ModeSelect({
  id,
  modes,
  list,
  value,
  onChange,
  disabled,
  error,
}: {
  id: string;
  modes: { isPending: boolean; isError: boolean; error: unknown };
  list: SdlcModeView[];
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  error: string | undefined;
}) {
  const t = useT(text);
  if (modes.isPending)
    return (
      <p aria-busy="true" className="text-sm text-muted-foreground">
        {t.modesLoading}
      </p>
    );
  return (
    <>
      {modes.isError && <p className="text-xs text-destructive">{t.modesFailed(apiErrorMessage(modes.error))}</p>}
      <NativeSelect id={id} value={value} onChange={(e) => onChange(e.currentTarget.value)} disabled={disabled}>
        <option value="">{t.defModeNone}</option>
        {/* Chế độ đã lưu mà không còn trong danh sách (đã tắt) vẫn hiện để không đổi ngầm khi lưu mục. */}
        {value && !list.some((m) => m.slug === value) && <option value={value}>{value}</option>}
        {list.map((m) => (
          <option key={m.ref} value={m.slug}>
            {m.definition.name}
          </option>
        ))}
      </NativeSelect>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </>
  );
}
