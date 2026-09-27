import { useState } from "react";
import { ROLES, type Role } from "@xdev-hive/core";
import { Badge, Empty, ErrorNote, PageHeader, STATUS_TONE } from "../components/ui.tsx";
import { formatTime, useAction, useHive, useQuery } from "../hooks.ts";

const ROLE_HINT: Record<Role, string> = {
  viewer: "Chỉ xem",
  agent: "Agent: đọc, đề xuất, ghi memory, nhận task",
  admin: "Admin: sửa và duyệt tài liệu, quản lý token",
};

export function TokensPage() {
  const { client } = useHive();
  const tokens = client.tokens!;
  const list = useQuery(() => tokens.list(), [tokens]);
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("agent");
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const action = useAction();

  return (
    <div className="page">
      <PageHeader
        title="Token truy cập"
        subtitle="Mỗi người hoặc mỗi máy một token. Agent dùng token vai trò agent. Token chỉ hiện một lần lúc tạo."
      />
      <form
        className="card card-compact row gap-s wrap"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            const res = await tokens.create(name.trim(), role);
            setCreated({ name: res.info.name, token: res.token });
            setName("");
            list.reload();
          });
        }}
      >
        <input
          className="input grow"
          placeholder="Tên, ví dụ duy-macbook hoặc ci-gitlab"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Tên token"
        />
        <select className="input" value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Vai trò">
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_HINT[r]}
            </option>
          ))}
        </select>
        <button className="btn btn-primary" type="submit" disabled={!name.trim() || action.busy}>
          Tạo token
        </button>
      </form>
      <ErrorNote error={action.error} />
      {created ? (
        <div className="note note-ok token-reveal">
          <div>
            Token <b>{created.name}</b>. Sao chép ngay, sẽ không hiện lại:
          </div>
          <div className="row gap-s">
            <code className="mono grow token-value">{created.token}</code>
            <button className="btn btn-small" onClick={() => void navigator.clipboard?.writeText(created.token)}>
              Sao chép
            </button>
            <button className="btn btn-small btn-ghost" onClick={() => setCreated(null)}>
              Đóng
            </button>
          </div>
          <div className="muted small">
            Dán vào app desktop (Dự án &amp; cài đặt → Hub) hoặc dùng trực tiếp cho MCP qua HTTP: <code>POST /mcp</code>, header{" "}
            <code>Authorization: Bearer …</code>
          </div>
        </div>
      ) : null}
      <ErrorNote error={list.error} />
      {list.data?.length === 0 ? <Empty>Chưa có token.</Empty> : null}
      {list.data?.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Tên</th>
                <th>Vai trò</th>
                <th>Tạo lúc</th>
                <th>Dùng gần nhất</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>
                    <Badge tone={STATUS_TONE[t.role]}>{t.role}</Badge>
                  </td>
                  <td className="small muted">{formatTime(t.createdAt)}</td>
                  <td className="small muted">{formatTime(t.lastUsedAt)}</td>
                  <td className="right">
                    <button
                      className="btn btn-small btn-danger"
                      onClick={() => {
                        if (window.confirm(`Thu hồi token "${t.name}"? Máy/agent đang dùng sẽ mất quyền truy cập ngay.`)) {
                          void action.run(async () => {
                            await tokens.revoke(t.id);
                            list.reload();
                          });
                        }
                      }}
                    >
                      Thu hồi
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
