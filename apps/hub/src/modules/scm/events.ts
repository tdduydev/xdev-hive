import type { GitProviderKind } from "./types.ts";

/**
 * Sự kiện Git đã chuẩn hoá, chung cho GitHub và GitLab. Module khác (tasks, runs) chỉ đọc kiểu này, không đọc
 * payload gốc, để thêm nhà cung cấp hay đổi định dạng payload chỉ phải sửa ở đây.
 */
export type ScmEvent = PullRequestEvent | PushEvent | IssueEvent | MentionEvent;
export type ScmEventKind = ScmEvent["kind"];

export const SCM_EVENT_KINDS = [
  "pull_request.opened",
  "pull_request.closed",
  "pull_request.merged",
  "push",
  "issue.opened",
  "issue.labeled",
  "issue.commented",
  "comment.mentioned",
] as const satisfies readonly ScmEventKind[];

interface Base {
  provider: GitProviderKind;
  /** Đường dẫn đầy đủ của repo (`owner/name`, GitLab có thể lồng group). */
  repo: string;
  /** Người gây ra sự kiện (login GitHub, username GitLab). */
  actor: string | null;
}

export interface PullRequestInfo {
  /** GitLab: iid của merge request. */
  number: number;
  title: string;
  url: string;
  head: string;
  base: string;
  headSha: string | null;
}

export interface PullRequestEvent extends Base {
  kind: "pull_request.opened" | "pull_request.closed" | "pull_request.merged";
  pullRequest: PullRequestInfo;
}

export interface PushEvent extends Base {
  kind: "push";
  branch: string;
  sha: string;
}

export interface IssueInfo {
  /** GitLab: iid của issue. */
  number: number;
  title: string;
  body: string;
  labels: string[];
  /** GitLab chỉ gửi id người tạo; biết được tên khi chính người đó mở issue. */
  author: string | null;
  url: string | null;
}

export interface CommentInfo {
  id: string;
  body: string;
  author: string | null;
  url: string | null;
}

export type IssueEvent =
  | (Base & { kind: "issue.opened"; issue: IssueInfo })
  | (Base & { kind: "issue.labeled"; issue: IssueInfo; label: string })
  | (Base & { kind: "issue.commented"; issue: IssueInfo; comment: CommentInfo });

/** Bình luận trên issue hoặc PR có nhắc tới bot (`@<mention>` trong cấu hình dự án). */
export interface MentionEvent extends Base {
  kind: "comment.mentioned";
  target: { type: "issue" | "pull_request"; number: number; title: string; url: string | null };
  comment: CommentInfo;
}

export interface NormalizeOptions {
  /** Tên bot được nhắc, không có `@`. */
  mention: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Đọc payload. Payload đã qua kiểm chữ ký nhưng định dạng vẫn có thể đổi theo phiên bản nhà cung cấp: thiếu trường
// thì bỏ sự kiện (ghi `ignored`) chứ không ném lỗi để nhà cung cấp gửi lại mãi.

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const at = (v: unknown, ...path: string[]): unknown => path.reduce<unknown>((o, k) => obj(o)?.[k], v);

class Missing extends Error {}
function need<T>(v: T | null, what: string): T {
  if (v === null) throw new Missing(what);
  return v;
}

const BRANCH_PREFIX = "refs/heads/";
const ZERO_SHA = /^0+$/;

/** Nhắc tên đứng riêng: `@hive` khớp, `@hive-ops`, `@hivex`, `email@hive` thì không. */
export function mentions(body: string, name: string): boolean {
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w@./-])@${escaped}(?![\\w-])`, "i").test(body);
}

function safely(fn: () => ScmEvent[]): ScmEvent[] {
  try {
    return fn();
  } catch (e) {
    if (e instanceof Missing) return [];
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// GitHub

function ghIssue(i: unknown): IssueInfo {
  return {
    number: need(num(at(i, "number")), "issue.number"),
    title: str(at(i, "title")) ?? "",
    body: str(at(i, "body")) ?? "",
    labels: arr(at(i, "labels"))
      .map((l) => str(at(l, "name")))
      .filter((l): l is string => l !== null),
    author: str(at(i, "user", "login")),
    url: str(at(i, "html_url")),
  };
}

/** `event` là header X-GitHub-Event. Sự kiện không quan tâm (ping, check_run...) trả mảng rỗng. */
export function normalizeGitHub(event: string, payload: unknown, opts: NormalizeOptions): ScmEvent[] {
  return safely(() => {
    const base: Base = {
      provider: "github",
      repo: need(str(at(payload, "repository", "full_name")), "repository.full_name"),
      actor: str(at(payload, "sender", "login")),
    };
    const action = str(at(payload, "action"));
    switch (event) {
      case "pull_request": {
        const pr = at(payload, "pull_request");
        const kind =
          action === "opened"
            ? "pull_request.opened"
            : action === "closed"
              ? at(pr, "merged") === true
                ? "pull_request.merged"
                : "pull_request.closed"
              : null;
        if (!kind) return [];
        return [
          {
            ...base,
            kind,
            pullRequest: {
              number: need(num(at(pr, "number")), "pull_request.number"),
              title: str(at(pr, "title")) ?? "",
              url: need(str(at(pr, "html_url")), "pull_request.html_url"),
              head: need(str(at(pr, "head", "ref")), "pull_request.head.ref"),
              base: need(str(at(pr, "base", "ref")), "pull_request.base.ref"),
              headSha: str(at(pr, "head", "sha")),
            },
          },
        ];
      }
      case "push": {
        const ref = need(str(at(payload, "ref")), "ref");
        const sha = need(str(at(payload, "after")), "after");
        // Tag và nhánh bị xoá không có gì để chạy.
        if (!ref.startsWith(BRANCH_PREFIX) || at(payload, "deleted") === true || ZERO_SHA.test(sha)) return [];
        return [{ ...base, kind: "push", branch: ref.slice(BRANCH_PREFIX.length), sha }];
      }
      case "issues": {
        // GitHub gửi PR qua sự kiện pull_request; payload issues có `pull_request` thì bỏ cho chắc.
        if (at(payload, "issue", "pull_request")) return [];
        const issue = ghIssue(at(payload, "issue"));
        if (action === "opened") return [{ ...base, kind: "issue.opened", issue }];
        if (action === "labeled") {
          const label = need(str(at(payload, "label", "name")), "label.name");
          return [{ ...base, kind: "issue.labeled", issue, label }];
        }
        return [];
      }
      case "issue_comment": {
        if (action !== "created") return [];
        const c = at(payload, "comment");
        const comment: CommentInfo = {
          id: String(need(num(at(c, "id")), "comment.id")),
          body: str(at(c, "body")) ?? "",
          author: str(at(c, "user", "login")),
          url: str(at(c, "html_url")),
        };
        const isPr = Boolean(at(payload, "issue", "pull_request"));
        const issue = ghIssue(at(payload, "issue"));
        const out: ScmEvent[] = isPr ? [] : [{ ...base, kind: "issue.commented", issue, comment }];
        // Bot (kể cả chính Hive) nhắc tên nhau thì bỏ, tránh vòng lặp bình luận qua lại.
        if (at(c, "user", "type") !== "Bot" && mentions(comment.body, opts.mention)) {
          out.push({
            ...base,
            kind: "comment.mentioned",
            target: { type: isPr ? "pull_request" : "issue", number: issue.number, title: issue.title, url: issue.url },
            comment,
          });
        }
        return out;
      }
      default:
        return [];
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------
// GitLab

const glLabels = (v: unknown) =>
  arr(v)
    .map((l) => str(at(l, "title")))
    .filter((l): l is string => l !== null);

/** URL của issue/MR từ URL bình luận (`.../issues/17#note_1241`), vì payload note không phải lúc nào cũng có. */
const stripNote = (url: string | null) => (url ? url.replace(/#note_\d+$/, "") : null);

/** `event` là header X-Gitlab-Event (`Push Hook`, `Issue Hook`...). Định tuyến theo `object_kind` trong payload. */
export function normalizeGitLab(_event: string, payload: unknown, opts: NormalizeOptions): ScmEvent[] {
  return safely(() => {
    const base: Base = {
      provider: "gitlab",
      repo: need(str(at(payload, "project", "path_with_namespace")), "project.path_with_namespace"),
      actor: str(at(payload, "user", "username")) ?? str(at(payload, "user_username")),
    };
    const oa = at(payload, "object_attributes");
    const action = str(at(oa, "action"));
    switch (str(at(payload, "object_kind"))) {
      case "merge_request": {
        const kind =
          action === "open"
            ? "pull_request.opened"
            : action === "close"
              ? "pull_request.closed"
              : action === "merge"
                ? "pull_request.merged"
                : null;
        if (!kind) return [];
        return [
          {
            ...base,
            kind,
            pullRequest: {
              number: need(num(at(oa, "iid")), "object_attributes.iid"),
              title: str(at(oa, "title")) ?? "",
              url: need(str(at(oa, "url")), "object_attributes.url"),
              head: need(str(at(oa, "source_branch")), "object_attributes.source_branch"),
              base: need(str(at(oa, "target_branch")), "object_attributes.target_branch"),
              headSha: str(at(oa, "last_commit", "id")),
            },
          },
        ];
      }
      case "push": {
        const ref = need(str(at(payload, "ref")), "ref");
        const sha = need(str(at(payload, "after")), "after");
        if (!ref.startsWith(BRANCH_PREFIX) || ZERO_SHA.test(sha)) return [];
        return [{ ...base, kind: "push", branch: ref.slice(BRANCH_PREFIX.length), sha }];
      }
      case "issue": {
        const issue: IssueInfo = {
          number: need(num(at(oa, "iid")), "object_attributes.iid"),
          title: str(at(oa, "title")) ?? "",
          body: str(at(oa, "description")) ?? "",
          labels: glLabels(at(payload, "labels")),
          author: action === "open" ? base.actor : null,
          url: str(at(oa, "url")),
        };
        if (action === "open") return [{ ...base, kind: "issue.opened", issue }];
        // GitLab không có action "labeled": nhãn mới là nhãn có trong `changes.labels.current` mà chưa có ở `previous`.
        if (action === "update") {
          const before = new Set(glLabels(at(payload, "changes", "labels", "previous")));
          return glLabels(at(payload, "changes", "labels", "current"))
            .filter((l) => !before.has(l))
            .map((label) => ({ ...base, kind: "issue.labeled" as const, issue, label }));
        }
        return [];
      }
      case "note": {
        if (action !== null && action !== "create") return [];
        const type = str(at(oa, "noteable_type"));
        if (type !== "Issue" && type !== "MergeRequest") return [];
        const comment: CommentInfo = {
          id: String(need(num(at(oa, "id")), "object_attributes.id")),
          body: str(at(oa, "note")) ?? "",
          author: base.actor,
          url: str(at(oa, "url")),
        };
        const out: ScmEvent[] = [];
        let target: MentionEvent["target"];
        if (type === "Issue") {
          const i = at(payload, "issue");
          const issue: IssueInfo = {
            number: need(num(at(i, "iid")), "issue.iid"),
            title: str(at(i, "title")) ?? "",
            body: str(at(i, "description")) ?? "",
            labels: glLabels(at(i, "labels")),
            author: null,
            url: str(at(i, "url")) ?? stripNote(comment.url),
          };
          out.push({ ...base, kind: "issue.commented", issue, comment });
          target = { type: "issue", number: issue.number, title: issue.title, url: issue.url };
        } else {
          const mr = at(payload, "merge_request");
          target = {
            type: "pull_request",
            number: need(num(at(mr, "iid")), "merge_request.iid"),
            title: str(at(mr, "title")) ?? "",
            url: str(at(mr, "url")) ?? stripNote(comment.url),
          };
        }
        if (mentions(comment.body, opts.mention)) out.push({ ...base, kind: "comment.mentioned", target, comment });
        return out;
      }
      default:
        return [];
    }
  });
}

export function normalizeEvent(
  provider: GitProviderKind,
  event: string,
  payload: unknown,
  opts: NormalizeOptions,
): ScmEvent[] {
  return provider === "github" ? normalizeGitHub(event, payload, opts) : normalizeGitLab(event, payload, opts);
}

/** Tên sự kiện gốc ghi vào webhook_deliveries.event, để tra cứu khi sự kiện bị bỏ qua. */
export function rawEventName(provider: GitProviderKind, event: string, payload: unknown): string {
  const action = provider === "github" ? str(at(payload, "action")) : str(at(payload, "object_attributes", "action"));
  const kind = provider === "github" ? event : (str(at(payload, "object_kind")) ?? event);
  return action ? `${kind}.${action}` : kind;
}
