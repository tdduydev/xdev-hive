import { describe, expect, it } from "vitest";
import { exec } from "@/lib/exec.ts";

const node = process.execPath;

describe("exec", () => {
  it("không qua shell: ký tự đặc biệt trong argv là chữ thường", async () => {
    const payload = "$(echo pwned); `id` | cat && x";
    const r = await exec(node, ["-e", "process.stdout.write(process.argv[1])", payload]);
    expect(r).toMatchObject({ code: 0, stdout: payload });
  });

  it("trả mã thoát khác 0 thay vì ném lỗi", async () => {
    const r = await exec(node, ["-e", "process.exit(3)"]);
    expect(r.code).toBe(3);
  });

  it("đưa input qua stdin", async () => {
    const r = await exec(node, ["-e", "process.stdin.pipe(process.stdout)"], { input: "secret" });
    expect(r.stdout).toBe("secret");
  });

  it("ném lỗi khi không tìm thấy binary và che token trong thông báo", async () => {
    await expect(exec("/không/có/hive_pat_abcdefghijklmnop", [])).rejects.toThrow(/\*\*\*/);
  });
});
