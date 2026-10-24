import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { type Account, AccountContext } from "@/lib/account.ts";
import { saveFolder } from "@/lib/folder.ts";
import type { HubProject } from "@/lib/hub.ts";
import { setLang } from "@/lib/i18n.ts";
import {
  diffHunks,
  type HubSkillItem,
  type InstalledSkill,
  idleTokens,
  lineDiff,
  renderSkillFile,
  skillState,
} from "@/lib/skills.ts";
import { SkillsScreen } from "@/screens/skills-screen.tsx";

const ACCOUNT: Account = {
  name: "Phạm Hà",
  email: "ha@acme.vn",
  orgId: "o1",
  orgName: "Acme",
  orgRole: "member",
  teams: [{ id: "t1", name: "Thanh toán", role: "member" }],
};
const PROJECT: HubProject = {
  key: "PAY",
  name: "payment-api",
  state: "active",
  repo: {
    kind: "github",
    owner: "acme",
    name: "payment-api",
    httpUrl: "https://github.com/acme/payment-api.git",
    sshUrl: null,
    webUrl: null,
  },
};
const HUB: HubSkillItem[] = [
  {
    name: "db-migration",
    description: "Migration an toàn, ép RLS",
    scope: "project",
    version: 5,
    repoPath: "projects/PAY/db-migration/SKILL.md",
  },
  { name: "code-review", description: "Review chéo", scope: "org", version: 2 },
  { name: "incident-triage", description: "Đọc log", scope: "team", version: 1, teamId: "t1" },
];
const HIDDEN: HubSkillItem[] = [{ name: "db-migration", description: "Quy trình chung", scope: "org", version: 3 }];
const BODY: Record<string, string> = {
  "db-migration": "## Steps\n1. pnpm db:generate\n2. FORCE ROW LEVEL SECURITY\n3. pnpm test rls.db.test.ts",
  "code-review": "Đọc diff.",
  "incident-triage": "Đọc log trước.",
};
const OLD_DB = renderSkillFile(
  "db-migration",
  "Migration an toàn, ép RLS",
  "## Steps\n1. pnpm db:generate\n2. Nhớ bật RLS",
);
const LOCAL: InstalledSkill[] = [
  { name: "code-review", version: 2, modified: true, dirs: [".claude/skills", ".agents/skills"], text: "sửa tay" },
  { name: "db-migration", version: 4, modified: false, dirs: [".claude/skills", ".agents/skills"], text: OLD_DB },
  { name: "my-own", version: null, modified: false, dirs: [".claude/skills"], text: "của tôi" },
];

const HIVE: HubSkillItem = {
  name: "ui-ux-pro-max",
  description: "Thiết kế giao diện",
  scope: "hive",
  version: 1,
  license: "MIT",
  files: 3,
};
const PACK_FILES = [
  { path: "SKILL.md", text: "---\nname: ui-ux-pro-max\n---\nThiết kế.\n" },
  { path: "data/styles.csv", text: "a,b\n" },
  { path: "scripts/search.py", text: "print(1)\n" },
];

function fakeTauri(local: InstalledSkill[] = LOCAL, hub: HubSkillItem[] = HUB) {
  const calls: { command: string; args?: Record<string, unknown> | undefined }[] = [];
  const handlers: Record<string, (args?: Record<string, unknown>) => unknown> = {
    workspace_meta: () => ({
      folder: "/w/payment-api",
      name: "payment-api",
      isGit: true,
      branch: "main",
      remote: "git@github.com:acme/payment-api.git",
    }),
    hub_tool: (args) => {
      const a = args?.args as Record<string, unknown>;
      if (args?.name === "project_list") return { projects: [PROJECT] };
      if (args?.name === "skill_list") return { skills: hub, hidden: HIDDEN, truncated: false, nextOffset: null };
      if (args?.name === "skill_get") return { content: BODY[String(a.name)], offset: 0, nextOffset: null };
      throw new Error(`tool chưa giả: ${String(args?.name)}`);
    },
    installed_skills: () => local,
    skill_uses: () => ({ "db-migration": 14 }),
    install_skills: (args) => ({
      done: ((args?.files ?? []) as { name: string }[]).map((f) => f.name),
      conflicts: [],
    }),
    remove_skills: (args) => ({ done: args?.names, conflicts: [] }),
    propose_skill: () => ({ key: "p1", state: "queued" }),
    // Skill mặc định của Hive lấy đủ file qua API (oRPC sau lệnh hub_rpc), không qua MCP.
    hub_rpc: (a) => {
      const path = String(a?.path)
        .replace(/^\/rpc\//, "")
        .split("?")[0];
      const known = path === "skills/packFiles";
      return {
        status: known ? 200 : 404,
        contentType: "application/json",
        body: JSON.stringify(
          known
            ? { json: { name: "ui-ux-pro-max", hash: "h", files: PACK_FILES } }
            : { json: { defined: false, code: "NOT_FOUND", status: 404, message: "x" } },
        ),
      };
    },
  };
  window.__TAURI__ = {
    core: {
      invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        const h = handlers[command];
        if (!h) throw new Error(`lệnh chưa giả: ${command}`);
        return (await h(args)) as T;
      },
    },
  };
  return calls;
}

const renderSkills = (account: Account | null = ACCOUNT) =>
  render(
    <AccountContext.Provider value={account}>
      <SkillsScreen />
    </AccountContext.Provider>,
  );

const rowOf = async (name: string, nth = 0) =>
  (await screen.findAllByRole("button", { name: new RegExp(`^${name}`) }))[nth]?.closest("tr") as HTMLElement;

// Màn Skills gọi nhiều lệnh Tauri giả trước khi hiện nút đồng bộ; trên máy CI bận, quá 1 giây mặc định của findBy*
// thì test hỏng ngẫu nhiên.
const SLOW = { timeout: 10_000 };

describe("trạng thái và so bản", () => {
  it("phân loại skill trên máy so với hub", () => {
    const hub = HUB[0] as HubSkillItem;
    const at = (v: number | null, modified = false): InstalledSkill => ({
      name: hub.name,
      version: v,
      modified,
      dirs: [],
      text: "",
    });
    expect(skillState(hub, undefined, false)).toBe("missing");
    expect(skillState(hub, undefined, true)).toBe("off");
    expect(skillState(hub, at(4), false)).toBe("update");
    expect(skillState(hub, at(5), false)).toBe("installed");
    expect(skillState(hub, at(5, true), false)).toBe("modified");
    expect(skillState(hub, at(null), false)).toBe("own");
    expect(skillState(null, at(2), false)).toBe("gone");
    expect(skillState(null, at(null), false)).toBe("own");
  });

  it("SKILL.md giống file trong kho Git; nội dung đã có frontmatter thì giữ nguyên", () => {
    expect(renderSkillFile("a", 'Mô tả: có "ngoặc"', "Nội dung\n")).toBe(
      '---\nname: a\ndescription: "Mô tả: có \\"ngoặc\\""\n---\n\nNội dung\n',
    );
    expect(renderSkillFile("a", "x", "---\nname: a\n---\nBody")).toBe("---\nname: a\n---\nBody\n");
    expect(idleTokens({ name: "db-migration", description: "Migration an toàn, ép RLS" })).toBe(16);
  });

  it("so dòng, chỉ giữ chỗ đổi và một dòng quanh nó", () => {
    const d = lineDiff("a\nb\nc\nd\ne\nf", "a\nb\nC\nd\ne\nf");
    expect(d.filter((l) => l.kind !== "same")).toEqual([
      { kind: "del", text: "c" },
      { kind: "add", text: "C" },
    ]);
    expect(diffHunks(d)).toEqual([
      { kind: "same", text: "b" },
      { kind: "del", text: "c" },
      { kind: "add", text: "C" },
      { kind: "same", text: "d" },
    ]);
    expect(diffHunks(lineDiff("1\n2\n3\n4\n5\n6\n7", "0\n2\n3\n4\n5\n6\nX")).filter((l) => l === null)).toHaveLength(1);
  });
});

describe("SkillsScreen", () => {
  beforeEach(() => {
    setLang("vi");
    saveFolder("/w/payment-api");
  });

  it("ghép skill của hub với skill trên máy: nguồn, trạng thái, bản, lần dùng", async () => {
    const calls = fakeTauri();
    renderSkills();
    await screen.findByRole("button", { name: "Đồng bộ 2 bản mới" }, SLOW);
    const db = await rowOf("db-migration");
    expect(within(db).getByText("Dự án · payment-api")).toBeTruthy();
    expect(within(db).getByText("Có bản mới")).toBeTruthy();
    expect(within(db).getByText("v4 → v5")).toBeTruthy();
    expect(within(db).getByText("14")).toBeTruthy();
    const hidden = await rowOf("db-migration", 1);
    expect(within(hidden).getByText("Bị bản hẹp hơn che")).toBeTruthy();
    expect(within(hidden).getByText("Tổ chức")).toBeTruthy();
    expect(within(await rowOf("code-review")).getByText("Đã sửa trên máy")).toBeTruthy();
    const triage = await rowOf("incident-triage");
    expect(within(triage).getByText("Đội · Thanh toán")).toBeTruthy();
    expect(within(triage).getByText("— → v1")).toBeTruthy();
    expect(within(await rowOf("my-own")).getByText("Tự thêm")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Đồng bộ 2 bản mới" })).toBeTruthy();
    expect(screen.getByText(".claude/skills/ · 3 skill")).toBeTruthy();
    expect(screen.getByText(".agents/skills/ · 2 skill")).toBeTruthy();
    expect(calls.find((c) => c.args?.name === "skill_list")?.args).toEqual({
      name: "skill_list",
      args: { limit: 50, offset: 0, project: "PAY" },
    });
    expect(calls.find((c) => c.command === "installed_skills")?.args).toEqual({
      target: "project",
      folder: "/w/payment-api",
    });
  });

  it("skill mặc định của Hive: nhãn kèm giấy phép, cài cả file kèm theo", async () => {
    const calls = fakeTauri(LOCAL, [...HUB, HIVE]);
    renderSkills();
    const row = await rowOf("ui-ux-pro-max");
    expect(within(row).getByText("Hive mặc định · MIT")).toBeTruthy();
    expect(within(row).getByText("Chưa cài")).toBeTruthy();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Đồng bộ 3 bản mới" }, SLOW));
    expect(await screen.findByText("Đã cài 3 skill.")).toBeTruthy();
    const files = calls.find((c) => c.command === "install_skills")?.args?.files as { name: string }[];
    expect(files.find((f) => f.name === "ui-ux-pro-max")).toEqual({
      name: "ui-ux-pro-max",
      version: 1,
      text: PACK_FILES[0]?.text,
      extra: PACK_FILES.slice(1),
    });
    expect(calls.some((c) => c.command === "hub_rpc" && String(c.args?.path).includes("skills/packFiles"))).toBe(true);
    expect(
      calls.some(
        (c) => c.args?.name === "skill_get" && (c.args.args as { name?: string } | undefined)?.name === "ui-ux-pro-max",
      ),
    ).toBe(false);
  });

  it("Đồng bộ cài bản mới và skill chưa cài, không đụng skill đã sửa tay", async () => {
    const calls = fakeTauri();
    renderSkills();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Đồng bộ 2 bản mới" }, SLOW));
    expect(await screen.findByText("Đã cài 2 skill.")).toBeTruthy();
    const install = calls.find((c) => c.command === "install_skills")?.args;
    expect(install?.force).toBe(false);
    expect(install?.target).toBe("project");
    expect(install?.files).toEqual([
      {
        name: "db-migration",
        version: 5,
        text: renderSkillFile("db-migration", "Migration an toàn, ép RLS", BODY["db-migration"] as string),
      },
      { name: "incident-triage", version: 1, text: renderSkillFile("incident-triage", "Đọc log", "Đọc log trước.") },
    ]);
    expect(calls.filter((c) => c.command === "installed_skills").length).toBeGreaterThan(1);
  });

  it("chi tiết: thay đổi giữa bản trên máy và bản mới", async () => {
    fakeTauri();
    renderSkills();
    await screen.findByRole("button", { name: "Đồng bộ 2 bản mới" }, SLOW);
    await userEvent.setup().click((await screen.findAllByRole("button", { name: /^db-migration/ }))[0] as HTMLElement);
    expect(await screen.findByText("Thay đổi · v4 → v5")).toBeTruthy();
    expect((await screen.findByText(/2\. FORCE ROW LEVEL SECURITY/)).textContent).toBe("+ 2. FORCE ROW LEVEL SECURITY");
    expect(screen.getByText(/2\. Nhớ bật RLS/).textContent).toBe("- 2. Nhớ bật RLS");
    expect(screen.getByText("projects/PAY/db-migration/SKILL.md → .claude/skills/db-migration/")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cập nhật lên v5" })).toBeTruthy();
  });

  it("skill đã sửa tay: đề xuất sửa gửi bản trên máy; ghi đè phải bấm hai lần", async () => {
    const calls = fakeTauri();
    const user = userEvent.setup();
    renderSkills();
    await screen.findByRole("button", { name: "Đồng bộ 2 bản mới" }, SLOW);
    await user.click(await screen.findByRole("button", { name: /^code-review/ }));
    await user.click(await screen.findByRole("button", { name: "Đề xuất sửa" }));
    await user.type(screen.getByRole("textbox", { name: /Vì sao cần sửa/ }), "Thêm bước VAT.");
    await user.click(screen.getByRole("button", { name: "Gửi đề xuất" }));
    expect(await screen.findByText(/Đã xếp đề xuất/)).toBeTruthy();
    expect(calls.find((c) => c.command === "propose_skill")?.args).toEqual({
      name: "code-review",
      project: "PAY",
      baseVersion: 2,
      text: "sửa tay",
      note: "Thêm bước VAT.",
    });
    await user.click(screen.getByRole("button", { name: "Ghi đè bằng v2" }));
    expect(calls.some((c) => c.command === "install_skills")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Bấm lần nữa để bỏ bản sửa trên máy" }));
    expect(await screen.findByText("Đã cài 1 skill.")).toBeTruthy();
    expect(calls.find((c) => c.command === "install_skills")?.args?.force).toBe(true);
  });

  it("Tắt với tôi: gỡ bản đã cài, nhớ đã tắt để Đồng bộ bỏ qua", async () => {
    const calls = fakeTauri();
    const user = userEvent.setup();
    renderSkills();
    await screen.findByRole("button", { name: "Đồng bộ 2 bản mới" }, SLOW);
    await user.click(await screen.findByRole("checkbox", { name: "Chọn db-migration" }));
    await user.click(screen.getByRole("checkbox", { name: "Chọn incident-triage" }));
    await user.click(
      within(screen.getByRole("toolbar", { name: "Đã chọn 2" })).getByRole("button", { name: "Tắt với tôi" }),
    );
    expect(await screen.findByText(/Đã tắt 2 skill với bạn/)).toBeTruthy();
    expect(calls.find((c) => c.command === "remove_skills")?.args?.names).toEqual(["db-migration"]);
    expect(within(await rowOf("incident-triage")).getByText("Tôi đã tắt")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("hive.skills.off") ?? "{}")).toEqual({
      "project:/w/payment-api": ["db-migration", "incident-triage"],
    });
  });

  it("cài vào tài khoản: không gửi thư mục, đường dẫn ~/.claude/skills", async () => {
    const calls = fakeTauri([]);
    const user = userEvent.setup();
    renderSkills();
    await screen.findByRole("button", { name: "Đồng bộ 3 bản mới" });
    await user.selectOptions(screen.getByRole("combobox", { name: /Cài vào/ }), "user");
    expect(await screen.findByText("~/.claude/skills/ · 0 skill")).toBeTruthy();
    expect(calls.filter((c) => c.command === "installed_skills").at(-1)?.args).toEqual({
      target: "user",
      folder: null,
    });
    expect(localStorage.getItem("hive.skills.target")).toBe("user");
  });

  it("người viết tài liệu chỉ xem: không có nút cài, không có ô chọn", async () => {
    fakeTauri();
    renderSkills({ ...ACCOUNT, teams: [{ id: "t1", name: "Thanh toán", role: "viewer" }] });
    await screen.findAllByRole("button", { name: /^db-migration/ });
    expect(screen.queryByRole("button", { name: /Đồng bộ/ })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Cập nhật lên v5" })).toBeNull();
  });

  it("chưa chọn thư mục: vẫn hiện skill của tổ chức, mời chọn thư mục, không đọc thư mục", async () => {
    saveFolder("");
    const calls = fakeTauri();
    renderSkills();
    await screen.findByRole("button", { name: "Đồng bộ 1 bản mới" }, SLOW);
    const review = await rowOf("code-review");
    expect(within(review).getByText("Tổ chức")).toBeTruthy();
    expect(within(review).getByText("Chưa cài")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^db-migration/ })).toBeNull();
    expect(screen.getByText(/Chọn thư mục làm việc ở góc trên bên trái, hoặc cài vào tài khoản/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Chọn thư mục" })).toBeTruthy();
    // Khung xem trước của dòng đang chọn tải nội dung qua skill_get; chờ nó xong rồi mới khẳng định không còn "Đang đọc…".
    await screen.findByText("Đọc diff.", undefined, SLOW);
    expect(screen.queryByText("Đang đọc…")).toBeNull();
    expect(calls.some((c) => c.command === "workspace_meta" || c.command === "installed_skills")).toBe(false);
    expect(calls.find((c) => c.args?.name === "skill_list")?.args).toEqual({
      name: "skill_list",
      args: { limit: 50, offset: 0 },
    });
  });

  it("chưa liên kết và không đọc được skill trên máy: báo lỗi, bảng không kẹt Đang đọc", async () => {
    fakeTauri();
    const invoke = window.__TAURI__?.core.invoke;
    window.__TAURI__ = {
      core: {
        invoke: async <T,>(command: string, args?: Record<string, unknown>) =>
          command === "installed_skills"
            ? Promise.reject("Không đọc được .claude/skills.")
            : (invoke as NonNullable<typeof invoke>)<T>(command, args),
      },
    };
    renderSkills(null);
    expect(await screen.findByText("Không đọc được .claude/skills.")).toBeTruthy();
    expect(await screen.findByText("Không có skill nào khớp.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Đang đọc…")).toBeNull());
  });

  it("chưa liên kết: chỉ hiện skill trên máy, nhắc liên kết, chữ tiếng Anh", async () => {
    setLang("en");
    const calls = fakeTauri();
    renderSkills(null);
    expect(
      await screen.findByText(
        "Connect to Hive to get skills from the hub. Skills installed on this machine still work.",
      ),
    ).toBeTruthy();
    expect(within(await rowOf("my-own")).getByText("Added by me")).toBeTruthy();
    expect(within(await rowOf("code-review")).getByText("This machine")).toBeTruthy();
    expect(calls.some((c) => c.command === "hub_tool")).toBe(false);
  });
});
