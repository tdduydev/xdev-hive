import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { buttonVariants } from "@xdev-hive/ui/button";
import { Pill } from "@xdev-hive/ui/pill";
import { CheckIcon } from "lucide-react";
import type { ReactNode } from "react";
import { CreateProjectButton } from "@/components/create-project-dialog.tsx";
import { CreateTaskButton } from "@/components/create-task-dialog.tsx";
import { Card } from "@/components/ui/card.tsx";
import { type Dict, useT } from "@/lib/i18n.ts";
import { type OnboardingStepId, onboardingPending, onboardingSteps } from "@/lib/onboarding.ts";
import { usePermissions } from "@/lib/permissions.ts";
import { teamRoleLookup } from "@/lib/projects.ts";
import { isOrgAdmin } from "@/lib/roles.ts";
import { useMe } from "@/shell/me-context.ts";
import type { CurrentOrg } from "@/shell/org-context.ts";

const text: Dict<{
  title: string;
  lead: string;
  progress: (done: number, total: number) => string;
  steps: string;
  done: string;
  waiting: (step: string) => string;
  noSystem: string;
  step: Record<OnboardingStepId, { title: string; desc: string; action: string }>;
  addSystem: string;
}> = {
  vi: {
    title: "Bắt đầu",
    lead: "Vài bước để agent nhận việc đầu tiên của tổ chức.",
    progress: (d, n) => `${d}/${n} bước xong`,
    steps: "Các bước bắt đầu",
    done: "Đã xong",
    waiting: (s) => `Làm bước “${s}” trước.`,
    noSystem: "Đội chưa có hệ thống: thêm một hệ thống (ví dụ “Cổng thanh toán”) rồi tạo dự án trong đó.",
    step: {
      scm: {
        title: "Kết nối GitHub hoặc GitLab",
        desc: "Hub dùng kết nối này để tạo repo, mở PR và nhận webhook.",
        action: "Kết nối GitHub/GitLab",
      },
      project: {
        title: "Tạo hệ thống và dự án đầu tiên",
        desc: "Nối một repo có sẵn hoặc tạo repo mới cho agent làm việc.",
        action: "Tạo dự án",
      },
      machine: {
        title: "Đăng ký một máy",
        desc: "Cài worker trên máy dev hoặc máy chủ; agent chạy bằng CLI đã đăng nhập trên máy đó.",
        action: "Đăng ký máy",
      },
      shared: {
        title: "Cho đội dùng chung một máy",
        desc: "Leader, AI duyệt tài liệu và việc từ webhook chỉ chạy trên máy dùng chung.",
        action: "Chọn máy dùng chung",
      },
      task: {
        title: "Giao task đầu tiên",
        desc: "Tạo việc trong dự án và giao cho agent làm.",
        action: "Giao task",
      },
    },
    addSystem: "Thêm hệ thống",
  },
  en: {
    title: "Get started",
    lead: "A few steps until agents pick up the organization’s first task.",
    progress: (d, n) => `${d}/${n} steps done`,
    steps: "Getting started steps",
    done: "Done",
    waiting: (s) => `Finish “${s}” first.`,
    noSystem: "Your team has no systems yet: add one (e.g. “Payment gateway”), then create the project in it.",
    step: {
      scm: {
        title: "Connect GitHub or GitLab",
        desc: "The hub uses this connection to create repos, open PRs and receive webhooks.",
        action: "Connect GitHub/GitLab",
      },
      project: {
        title: "Create a system and the first project",
        desc: "Link an existing repo or create a new one for agents to work in.",
        action: "New project",
      },
      machine: {
        title: "Register a machine",
        desc: "Install the worker on a dev machine or server; agents use the CLIs signed in there.",
        action: "Register a machine",
      },
      shared: {
        title: "Share a machine with the team",
        desc: "The Leader, AI doc reviews and webhook tasks only run on shared machines.",
        action: "Pick a shared machine",
      },
      task: {
        title: "Assign the first task",
        desc: "Create a task in a project and hand it to an agent.",
        action: "Assign a task",
      },
    },
    addSystem: "Add a system",
  },
};

/**
 * Thẻ "Bắt đầu" của trang chủ cho tổ chức chưa chạy được việc đầu tiên. Chỉ hiện bước người đang xem làm được (theo
 * cùng quy tắc với hub, xem lib/roles.ts) và ẩn khi các bước đó đã xong. Dữ liệu nào không tải được thì ẩn cả thẻ:
 * thẻ chỉ là lời hướng dẫn, báo sai bước còn thiếu tệ hơn không báo.
 */
export function GettingStarted({ current }: { current: CurrentOrg }) {
  const t = useT(text);
  const me = useMe();
  const can = usePermissions();
  const { api, org } = current;
  const members = useQuery(api.orgMembers.list.queryOptions());
  const teams = useQuery(api.teams.list.queryOptions());
  const connections = useQuery(api.scmConnections.list.queryOptions());
  const systems = useQuery(api.systems.list.queryOptions({ input: {} }));
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const tasks = useQuery(api.tasks.list.queryOptions({ input: {} }));
  const roleOf = teamRoleLookup(org.role, members.data, me.id);
  const adminTeams = members.data ? (teams.data ?? []).filter((team) => roleOf(team.id) === "admin") : [];
  const machines = useQueries({
    // Danh sách máy chỉ mở cho quản trị đội; đội khác không hỏi để khỏi nhận 403.
    queries: adminTeams.map((team) => api.machines.list.queryOptions({ input: { teamId: team.id } })),
  });
  const queries = [members, teams, connections, systems, projects, tasks, ...machines];
  if (queries.some((q) => q.isPending || q.isError)) return null;

  const workTeams = (teams.data ?? []).filter((team) => roleOf(team.id) === "admin" || roleOf(team.id) === "member");
  const ownSystems = (systems.data ?? []).filter((s) => roleOf(s.teamId) === "admin").length;
  const managesTeam = adminTeams.length > 0;
  const steps = onboardingSteps({
    can: {
      scm: isOrgAdmin(org.role),
      project: managesTeam,
      machine: managesTeam,
      shared: managesTeam,
      task: workTeams.length > 0 || can("tasks.create"),
    },
    connections: connections.data?.length ?? 0,
    ownSystems,
    projects: projects.data?.length ?? 0,
    machines: machines.flatMap((q) => q.data ?? []),
    tasks: tasks.data?.length ?? 0,
  });
  if (!onboardingPending(steps)) return null;

  const linkClass = buttonVariants({ variant: "default", size: "sm" });
  const action = (id: OnboardingStepId): ReactNode => {
    const s = t.step[id];
    switch (id) {
      case "scm":
        return (
          <Link to="/admin/git" className={linkClass}>
            {s.action}
          </Link>
        );
      case "project":
        return ownSystems === 0 ? (
          <Link to="/admin/teams" className={linkClass}>
            {t.addSystem}
          </Link>
        ) : (
          <CreateProjectButton label={s.action} />
        );
      case "machine":
        return (
          <Link to="/machines" search={{ them: true }} className={linkClass}>
            {s.action}
          </Link>
        );
      case "shared":
        return (
          <Link to="/machines" className={linkClass}>
            {s.action}
          </Link>
        );
      case "task":
        return (
          <CreateTaskButton projects={(projects.data ?? []).filter((p) => p.state === "active")} label={s.action} />
        );
    }
  };
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <Card className="grid gap-4 p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-heading text-lg font-semibold">{t.title}</h2>
        <span className="font-mono text-xs text-muted-foreground">{t.progress(doneCount, steps.length)}</span>
        <p className="basis-full text-sm text-muted-foreground">{t.lead}</p>
      </div>
      <ol aria-label={t.steps} className="grid gap-2.5">
        {steps.map((step, index) => {
          const s = t.step[step.id];
          return (
            <li
              key={step.id}
              aria-label={s.title}
              data-done={step.done}
              className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-lg border border-border p-3 data-[done=true]:bg-muted/40"
            >
              <span
                aria-hidden="true"
                className={
                  step.done
                    ? "grid size-6 place-items-center rounded-full bg-success-soft text-success"
                    : "grid size-6 place-items-center rounded-full border border-border font-mono text-xs text-muted-foreground"
                }
              >
                {step.done ? <CheckIcon className="size-3.5" /> : index + 1}
              </span>
              <div className="grid min-w-0 gap-0.5">
                <span className="flex flex-wrap items-center gap-2">
                  <b
                    className={
                      step.done ? "font-medium text-muted-foreground line-through" : "font-medium text-foreground"
                    }
                  >
                    {s.title}
                  </b>
                  {step.done && (
                    <Pill tone="ok" small>
                      {t.done}
                    </Pill>
                  )}
                </span>
                {!step.done && (
                  <span className="text-sm text-muted-foreground">
                    {step.id === "project" && ownSystems === 0 && !step.waitingFor ? t.noSystem : s.desc}
                  </span>
                )}
                {!step.done && step.waitingFor && (
                  <span className="text-xs text-muted-foreground">{t.waiting(t.step[step.waitingFor].title)}</span>
                )}
              </div>
              {!step.done && !step.waitingFor && <div className="col-start-2">{action(step.id)}</div>}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
