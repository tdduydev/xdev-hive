import { useEffect, useRef, useState } from "react";
import { type ContextProject, contextStatus, contextSync, type HubSnapshot } from "@/lib/context-sync.ts";
import { hub } from "@/lib/hub-rpc.ts";
import { type Dict, getLang } from "@/lib/i18n.ts";
import { localProjects } from "@/lib/local-projects.ts";
import type { OptimizePlan, OptimizePolicies } from "@/lib/optimize-all.ts";
import { errorText } from "@/lib/tauri.ts";

/*
 * Phần "Từ hub" của ngữ cảnh dùng chung (spec 029 US3): kéo memory đã duyệt của dự án bằng PAT (qua hub_rpc), đưa nguyên
 * danh sách cho `context_sync`; Rust ghi file tạm rồi xoá, sidecar lọc bí mật, tính ngân sách và ghi các file đích.
 */

/** Hỏi lại mỗi phút như thông báo của đội: đủ mịn cho chu kỳ tối thiểu 15 phút, và vẫn chạy khi cửa sổ ẩn ở khay. */
export const SCHEDULE_TICK_MS = 60_000;

/** Số memory tối đa hub cho một lần liệt kê; ghim đứng đầu nên phần bị cắt là mục cũ nhất. */
const PULL_LIMIT = 200;

/**
 * HubSnapshot đủ cho sidecar nhận (hub.go): thêm trường memory.list trả và `error`. Kiểu của context-sync.ts chưa có các
 * trường này nên mở rộng tại đây.
 */
type HubPull = Omit<HubSnapshot, "items"> & {
  items: (HubSnapshot["items"][number] & { supersededBy: string | null; status: string })[];
  /** Không lấy được từ hub: sidecar giữ bản lần trước và ghi lỗi này (FR-025). */
  error?: string;
};

export interface HubSyncOutcome {
  /** Null khi chính lệnh `context_sync` không chạy được; khi chỉ hub lỗi thì vẫn có dự án với bản cũ. */
  project: ContextProject | null;
  items: number;
  omitted: { budget: number; secret: number };
  syncedAt: string | null;
  error: string | null;
}

const TEXT: Dict<{ unbound: string }> = {
  vi: { unbound: "Thư mục này chưa gắn với dự án trên hub nên chưa có memory để kéo." },
  en: { unbound: "This folder is not linked to a hub project yet, so there is no memory to pull." },
};

const failed = (error: string): HubSyncOutcome => ({
  project: null,
  items: 0,
  omitted: { budget: 0, secret: 0 },
  syncedAt: null,
  error,
});

const outcomeOf = (project: ContextProject, pullError: string | undefined): HubSyncOutcome => ({
  project,
  items: project.hub?.items ?? 0,
  omitted: project.hub?.omitted ?? { budget: 0, secret: 0 },
  syncedAt: project.hub?.syncedAt ?? null,
  error: project.hub?.lastError ?? pullError ?? null,
});

async function pull(project: ContextProject): Promise<HubSyncOutcome> {
  const projectId = project.projectId;
  if (!projectId) return failed(TEXT[getLang()].unbound);
  let snapshot: HubPull;
  try {
    const memories = await hub.memory.list({ project: projectId, status: "approved", limit: PULL_LIMIT });
    snapshot = {
      projectId,
      items: memories.map((m) => ({
        id: m.id,
        kind: m.kind,
        pinned: m.pinned,
        createdAt: m.createdAt,
        content: m.content,
        supersededBy: m.supersededBy,
        status: m.status,
      })),
    };
  } catch (e) {
    snapshot = { projectId, items: [], error: errorText(e) };
  }
  try {
    return outcomeOf(await contextSync(project.key, snapshot), snapshot.error);
  } catch (e) {
    return failed(errorText(e));
  }
}

/** Lần thử gần nhất của từng dự án, kể cả lần lỗi: hub hỏng thì hẹn giờ không dội lại mỗi phút. */
const attempts = new Map<string, number>();
/** Lần đang chạy: nút bấm và hẹn giờ cùng gọi thì dùng chung một lần, không chạy chồng hai lần. */
const inflight = new Map<string, Promise<HubSyncOutcome>>();
/** Màn đang mở nghe mọi lần kéo xong, kể cả lần do hẹn giờ của app-shell chạy. */
const listeners = new Set<(project: ContextProject) => void>();

/** Kéo memory hub của một dự án rồi ghi ngữ cảnh. Không bao giờ ném lỗi: lỗi nằm trong kết quả. */
export function syncHubContext(project: ContextProject): Promise<HubSyncOutcome> {
  const running = inflight.get(project.key);
  if (running) return running;
  attempts.set(project.key, Date.now());
  const run = pull(project)
    .then((outcome) => {
      if (outcome.project) for (const listener of listeners) listener(outcome.project);
      return outcome;
    })
    .finally(() => inflight.delete(project.key));
  inflight.set(project.key, run);
  return run;
}

/** Công tắc tự đồng bộ đặt trên máy. Sidecar chỉ lưu lịch do chính sách đặt nên phần của máy nhớ tại đây. */
const AUTO_KEY = "hive.context.autosync";

export function machineAutoSyncKeys(): string[] {
  try {
    const raw = localStorage.getItem(AUTO_KEY);
    const keys: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

export function setMachineAutoSync(key: string, on: boolean): string[] {
  const keys = machineAutoSyncKeys().filter((k) => k !== key);
  if (on) keys.push(key);
  try {
    localStorage.setItem(AUTO_KEY, JSON.stringify(keys));
  } catch {
    /* Không nhớ được thì công tắc trở về tắt ở lần mở sau: không tự kéo memory ngoài ý người dùng. */
  }
  return keys;
}

/** Chính sách dự án bật thì theo chính sách và người dùng không tắt được trên máy; không thì theo công tắc của máy. */
export const autoSyncActive = (project: ContextProject, machineKeys: string[]): boolean =>
  project.autoSync.source === "policy" ? project.autoSync.enabled : machineKeys.includes(project.key);

function isDue(project: ContextProject, machineKeys: string[], now: number): boolean {
  if (!project.enabled || !project.projectId || !autoSyncActive(project, machineKeys)) return false;
  const synced = project.hub?.syncedAt ? Date.parse(project.hub.syncedAt) : Number.NaN;
  const last = Math.max(attempts.get(project.key) ?? 0, Number.isNaN(synced) ? 0 : synced);
  return now - last >= project.autoSync.minutes * 60_000;
}

/**
 * Hẹn giờ tự đồng bộ khi đã đăng nhập hub: mỗi phút xem dự án nào đến hạn (theo chu kỳ của dự án) thì kéo memory. Đọc lại
 * trạng thái mỗi lần để công tắc và chính sách đổi có tác dụng ngay. `onSynced` nhận dự án mới để màn đang mở cập nhật.
 */
export function useHubContextSchedule(signedIn: boolean, onSynced?: (project: ContextProject) => void): void {
  const notify = useRef(onSynced);
  notify.current = onSynced;
  useEffect(() => {
    const listener = (project: ContextProject) => notify.current?.(project);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  useEffect(() => {
    if (!signedIn) return;
    let stopped = false;
    const tick = async () => {
      let projects: ContextProject[];
      try {
        projects = (await contextStatus()).projects;
      } catch {
        return;
      }
      const keys = machineAutoSyncKeys();
      for (const project of projects) {
        if (stopped || !isDue(project, keys, Date.now())) continue;
        await syncHubContext(project);
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), SCHEDULE_TICK_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [signedIn]);
}

/*
 * Chính sách tối ưu của dự án (spec 029 US4): máy kéo `settings.devOptimizer` của các dự án đã gắn thư mục để nút "Tối ưu"
 * lấy làm đích và thẻ điểm báo máy lệch ở mục nào. Chỉ đọc: chính sách không tự áp dụng khi người dùng chưa bấm (FR-032).
 */

export interface ProjectPolicies {
  /** `{ [projectId]: DevOptimizerPolicy }` đưa cho `optimize all --preview`; dự án chưa đặt chính sách không có mặt. */
  policies: OptimizePolicies;
  /** Số dự án đã gắn mà hub không trả được chính sách (mất mạng, hết quyền): không tính vào đích. */
  failed: number;
}

/** Đọc chính sách của mọi dự án đã gắn thư mục còn trên máy. Lỗi của từng dự án chỉ tính vào `failed`. */
export async function loadProjectPolicies(): Promise<ProjectPolicies> {
  const ids = [
    ...new Set((await localProjects()).projects.filter((p) => p.projectId && p.exists).map((p) => p.projectId)),
  ];
  const results = await Promise.allSettled(ids.map((id) => hub.projects.get({ id })));
  const policies: OptimizePolicies = {};
  let failed = 0;
  results.forEach((result, i) => {
    const id = ids[i];
    if (result.status === "rejected") failed++;
    else if (id && result.value.settings.devOptimizer) policies[id] = result.value.settings.devOptimizer;
  });
  return { policies, failed };
}

/** Chính sách các dự án đã gắn, đọc một lần khi đã đăng nhập hub. Ngoài Tauri hay chưa đăng nhập thì không có chính sách. */
export function useProjectPolicies(signedIn: boolean): ProjectPolicies {
  const [state, setState] = useState<ProjectPolicies>({ policies: {}, failed: 0 });
  useEffect(() => {
    if (!signedIn) {
      setState({ policies: {}, failed: 0 });
      return;
    }
    let live = true;
    loadProjectPolicies().then(
      (next) => live && setState(next),
      () => live && setState({ policies: {}, failed: 0 }),
    );
    return () => {
      live = false;
    };
  }, [signedIn]);
  return state;
}

/** Mục chính sách mà máy có thể lệch; nhãn chữ do thẻ điểm giữ. */
export type DriftItem = "level" | "compact" | "rtk" | "codegraph";

export interface PolicyDrift {
  item: DriftItem;
  /** "Theo chính sách dự án …" do sidecar ghi, để biết dự án nào đòi mục này. */
  reason: string;
}

/**
 * Mục chính sách máy chưa đạt, suy từ bản xem trước: mỗi bước kế hoạch là một chỗ máy còn khác đích. Dùng chính kế hoạch
 * của sidecar để thẻ điểm và nút "Tối ưu" không bao giờ nói hai điều khác nhau. Bước theo mặc định (không có chính sách đòi)
 * và bước không thuộc chính sách (tính lại điểm, đồng bộ ngữ cảnh) không phải lệch.
 */
export function policyDrift(plan: OptimizePlan): PolicyDrift[] {
  const found = new Map<string, PolicyDrift>();
  const add = (item: DriftItem, reason: string) => found.set(`${item}|${reason}`, { item, reason });
  for (const step of plan.steps) {
    if (!step.reason.startsWith("Theo chính sách")) continue;
    if (step.id === "optimizer.enable") {
      add("level", step.reason);
      if (step.changes.some((c) => /compact/i.test(c.key))) add("compact", step.reason);
    } else if (step.id === "fix.optimizer.rtk" || step.id === "tool.rtk") {
      add("rtk", step.reason);
    } else if (step.id === "tool.codegraph" || step.id.startsWith("fix.codegraph.")) {
      add("codegraph", step.reason);
    }
  }
  return [...found.values()];
}
