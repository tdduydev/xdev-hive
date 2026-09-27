import { useState } from "react";
import { HiveLogo } from "./components/ui.tsx";

export function Login({ onSubmit, error }: { onSubmit: (token: string) => void; error?: string | null }) {
  const [token, setToken] = useState("");
  return (
    <div className="center-screen">
      <form
        className="card login"
        onSubmit={(e) => {
          e.preventDefault();
          if (token.trim()) onSubmit(token.trim());
        }}
      >
        <div className="brand brand-large">
          <HiveLogo size={28} />
          <span>xDev Hive</span>
        </div>
        <p className="muted">Quản trị tài liệu, memory và task dùng chung cho các coding agent.</p>
        <label className="label" htmlFor="token">
          Token truy cập
        </label>
        <input
          id="token"
          className="input mono"
          type="password"
          autoComplete="off"
          placeholder="hive_…"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoFocus
        />
        {error ? <div className="note note-error">{error}</div> : null}
        <button className="btn btn-primary" type="submit" disabled={!token.trim()}>
          Vào
        </button>
        <p className="muted small">Lần chạy đầu, hub in token admin ra console. Admin tạo thêm token ở trang Token.</p>
      </form>
    </div>
  );
}
