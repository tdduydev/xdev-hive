import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mentions, normalizeGitHub, normalizeGitLab, rawEventName } from "./events.ts";

type Json = Record<string, any>;
const fixture = (path: string): Json =>
  JSON.parse(readFileSync(new URL(`./fixtures/${path}.json`, import.meta.url), "utf8"));
const opts = { mention: "hive" };

describe("GitHub", () => {
  it("pull_request.opened", () => {
    expect(normalizeGitHub("pull_request", fixture("github/pull_request.opened"), opts)).toEqual([
      {
        provider: "github",
        kind: "pull_request.opened",
        repo: "Codertocat/Hello-World",
        actor: "Codertocat",
        pullRequest: {
          number: 2,
          title: "Update the README with new information.",
          url: "https://github.com/Codertocat/Hello-World/pull/2",
          head: "changes",
          base: "master",
          headSha: "ec26c3e57ca3a959ca5aad62de7213c562f8c821",
        },
      },
    ]);
  });

  it("pull_request.closed chưa merge thành closed", () => {
    const [e] = normalizeGitHub("pull_request", fixture("github/pull_request.closed"), opts);
    expect(e).toMatchObject({
      kind: "pull_request.closed",
      pullRequest: { number: 2, head: "changes", base: "master" },
    });
  });

  it("pull_request.closed đã merge thành merged", () => {
    const p = fixture("github/pull_request.closed");
    p.pull_request.merged = true;
    p.pull_request.merged_at = "2019-05-15T15:21:00Z";
    expect(normalizeGitHub("pull_request", p, opts).map((e) => e.kind)).toEqual(["pull_request.merged"]);
  });

  it("action khác của PR (synchronize, labeled) bị bỏ", () => {
    const p = fixture("github/pull_request.opened");
    p.action = "synchronize";
    expect(normalizeGitHub("pull_request", p, opts)).toEqual([]);
  });

  it("push lên nhánh", () => {
    expect(normalizeGitHub("push", fixture("github/push"), opts)).toEqual([
      {
        provider: "github",
        kind: "push",
        repo: "Codertocat/Hello-World",
        actor: "Codertocat",
        branch: "master",
        sha: "6113728f27ae82c7b1a177c8d03f9e96e0adf246",
      },
    ]);
  });

  it("xoá tag thì bỏ", () => {
    expect(normalizeGitHub("push", fixture("github/push.tag-deleted"), opts)).toEqual([]);
  });

  it("issue.opened", () => {
    expect(normalizeGitHub("issues", fixture("github/issues.opened"), opts)).toEqual([
      {
        provider: "github",
        kind: "issue.opened",
        repo: "Codertocat/Hello-World",
        actor: "Codertocat",
        issue: {
          number: 1,
          title: "Spelling error in the README file",
          body: "It looks like you accidently spelled 'commit' with two 't's.",
          labels: ["bug"],
          author: "Codertocat",
          url: "https://github.com/Codertocat/Hello-World/issues/1",
        },
      },
    ]);
  });

  it("issue.labeled mang nhãn vừa gắn", () => {
    const [e] = normalizeGitHub("issues", fixture("github/issues.labeled"), opts);
    expect(e).toMatchObject({ kind: "issue.labeled", label: "bug", issue: { number: 1, labels: ["bug"] } });
  });

  it("bình luận trên issue thành issue.commented, không nhắc bot thì không có comment.mentioned", () => {
    const events = normalizeGitHub("issue_comment", fixture("github/issue_comment.created"), opts);
    expect(events).toEqual([
      expect.objectContaining({
        kind: "issue.commented",
        issue: expect.objectContaining({ number: 1, title: "Spelling error in the README file" }),
        comment: {
          id: "492700400",
          body: "You are totally right! I'll get this fixed right away.",
          author: "Codertocat",
          url: "https://github.com/Codertocat/Hello-World/issues/1#issuecomment-492700400",
        },
      }),
    ]);
  });

  it("bình luận nhắc @hive thêm comment.mentioned", () => {
    const p = fixture("github/issue_comment.created");
    p.comment.body = "@hive sửa giúp lỗi chính tả này";
    expect(normalizeGitHub("issue_comment", p, opts)).toEqual([
      expect.objectContaining({ kind: "issue.commented" }),
      expect.objectContaining({
        kind: "comment.mentioned",
        target: {
          type: "issue",
          number: 1,
          title: "Spelling error in the README file",
          url: "https://github.com/Codertocat/Hello-World/issues/1",
        },
      }),
    ]);
  });

  it("bình luận trên PR chỉ có comment.mentioned; bot nhắc bot thì bỏ", () => {
    const p = fixture("github/issue_comment.created");
    p.issue.pull_request = { url: "https://api.github.com/repos/Codertocat/Hello-World/pulls/1" };
    p.comment.body = "@Hive review lại";
    expect(normalizeGitHub("issue_comment", p, opts)).toEqual([
      expect.objectContaining({ kind: "comment.mentioned", target: expect.objectContaining({ type: "pull_request" }) }),
    ]);
    p.comment.user.type = "Bot";
    expect(normalizeGitHub("issue_comment", p, opts)).toEqual([]);
  });

  it("ping và sự kiện lạ bị bỏ; payload thiếu trường cũng bị bỏ, không ném lỗi", () => {
    expect(normalizeGitHub("ping", fixture("github/ping"), opts)).toEqual([]);
    expect(normalizeGitHub("pull_request", { action: "opened" }, opts)).toEqual([]);
    expect(normalizeGitHub("issues", null, opts)).toEqual([]);
  });
});

describe("GitLab", () => {
  it("merge request open thành pull_request.opened", () => {
    expect(normalizeGitLab("Merge Request Hook", fixture("gitlab/merge_request.open"), opts)).toEqual([
      {
        provider: "gitlab",
        kind: "pull_request.opened",
        repo: "flightjs/flight-management",
        actor: "agarcia",
        pullRequest: {
          number: 16,
          title: "Add input validation to booking form",
          url: "http://gitlab.example.com/flightjs/flight-management/-/merge_requests/16",
          head: "feature/booking-validation",
          base: "main",
          headSha: "e59094b8de0f2f91abbe4760a52d9137260252d8",
        },
      },
    ]);
  });

  it.each([
    ["close", "pull_request.closed"],
    ["merge", "pull_request.merged"],
  ])("merge request %s thành %s", (action, kind) => {
    const p = fixture("gitlab/merge_request.open");
    p.object_attributes.action = action;
    expect(normalizeGitLab("Merge Request Hook", p, opts).map((e) => e.kind)).toEqual([kind]);
  });

  it("merge request update, approved bị bỏ", () => {
    const p = fixture("gitlab/merge_request.open");
    p.object_attributes.action = "update";
    expect(normalizeGitLab("Merge Request Hook", p, opts)).toEqual([]);
  });

  it("push", () => {
    expect(normalizeGitLab("Push Hook", fixture("gitlab/push"), opts)).toEqual([
      {
        provider: "gitlab",
        kind: "push",
        repo: "mike/diaspora",
        actor: "jsmith",
        branch: "master",
        sha: "da1560886d4f094c3e6c9ef40349f7d38b5d27d7",
      },
    ]);
  });

  it("xoá nhánh (after toàn số 0) thì bỏ", () => {
    const p = fixture("gitlab/push");
    p.after = "0000000000000000000000000000000000000000";
    expect(normalizeGitLab("Push Hook", p, opts)).toEqual([]);
  });

  it("issue open", () => {
    expect(normalizeGitLab("Issue Hook", fixture("gitlab/issue.open"), opts)).toEqual([
      {
        provider: "gitlab",
        kind: "issue.opened",
        repo: "gitlabhq/gitlab-test",
        actor: "root",
        issue: {
          number: 23,
          title: "New API: create/update/delete file",
          body: "Create new API for manipulations with repository",
          labels: ["API"],
          author: "root",
          url: "http://example.com/diaspora/issues/23",
        },
      },
    ]);
  });

  it("issue update có nhãn mới thành issue.labeled cho từng nhãn mới", () => {
    const p = fixture("gitlab/issue.open");
    p.object_attributes.action = "update";
    const platform = p.changes.labels.current[0];
    p.changes.labels.current.push({ ...platform, id: 999, title: "hive" });
    const events = normalizeGitLab("Issue Hook", p, opts);
    expect(events.map((e) => [e.kind, "label" in e ? e.label : null])).toEqual([
      ["issue.labeled", "Platform"],
      ["issue.labeled", "hive"],
    ]);
    // Người sửa issue chưa chắc là người tạo; GitLab chỉ gửi id người tạo.
    expect(events[0]).toMatchObject({ actor: "root", issue: { author: null } });
  });

  it("issue update không đổi nhãn thì bỏ", () => {
    const p = fixture("gitlab/issue.open");
    p.object_attributes.action = "update";
    delete p.changes.labels;
    expect(normalizeGitLab("Issue Hook", p, opts)).toEqual([]);
  });

  it("bình luận trên issue", () => {
    expect(normalizeGitLab("Note Hook", fixture("gitlab/note.issue"), opts)).toEqual([
      {
        provider: "gitlab",
        kind: "issue.commented",
        repo: "gitlab-org/gitlab-test",
        actor: "root",
        issue: {
          number: 17,
          title: "test",
          body: "test",
          labels: ["Afterpod", "Element"],
          author: null,
          url: "http://example.com/gitlab-org/gitlab-test/issues/17",
        },
        comment: {
          id: "1241",
          body: "Hello world",
          author: "root",
          url: "http://example.com/gitlab-org/gitlab-test/issues/17#note_1241",
        },
      },
    ]);
  });

  it("bình luận nhắc @hive trên merge request thành comment.mentioned", () => {
    const p = fixture("gitlab/note.merge_request");
    expect(normalizeGitLab("Note Hook", p, opts)).toEqual([]);
    p.object_attributes.note = "Nhờ @hive sửa theo góp ý.";
    expect(normalizeGitLab("Note Hook", p, opts)).toEqual([
      expect.objectContaining({
        kind: "comment.mentioned",
        target: {
          type: "pull_request",
          number: 1,
          title: p.merge_request.title,
          url: "http://example.com/gitlab-org/gitlab-test/merge_requests/1",
        },
        comment: expect.objectContaining({ id: "1244", author: "root" }),
      }),
    ]);
  });

  it("tag push, pipeline và loại khác bị bỏ", () => {
    expect(
      normalizeGitLab("Pipeline Hook", { object_kind: "pipeline", project: { path_with_namespace: "a/b" } }, opts),
    ).toEqual([]);
    expect(normalizeGitLab("Push Hook", {}, opts)).toEqual([]);
  });
});

describe("mentions", () => {
  it.each([
    ["@hive làm giúp", true],
    ["nhờ @HIVE.", true],
    ["(@hive)", true],
    ["@hive-ops xem", false],
    ["@hivex", false],
    ["mail admin@hive", false],
    ["hive", false],
  ])("%s → %s", (body, expected) => {
    expect(mentions(body, "hive")).toBe(expected);
  });
});

describe("rawEventName", () => {
  it("ghép loại và action", () => {
    expect(rawEventName("github", "pull_request", { action: "closed" })).toBe("pull_request.closed");
    expect(rawEventName("github", "ping", {})).toBe("ping");
    expect(rawEventName("gitlab", "Merge Request Hook", fixture("gitlab/merge_request.open"))).toBe(
      "merge_request.open",
    );
    expect(rawEventName("gitlab", "Push Hook", fixture("gitlab/push"))).toBe("push");
  });
});
