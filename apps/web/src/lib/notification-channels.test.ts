import { describe, expect, it } from "vitest";
import { parseChannelForm } from "./notification-channels.ts";

const id = "00000000-0000-4000-8000-000000000001";
function base() {
  const form = new FormData();
  form.set("name", " Nhóm vận hành ");
  form.append("events", "merge.failed");
  form.set("enabled", "on");
  return form;
}

describe("notification channel form", () => {
  it("preserves saved secrets when editing metadata", () => {
    const form = base();
    form.set("botToken", "must not be sent");
    const result = parseChannelForm(form, "telegram", id);
    expect(result.success).toBe(true);
    if (result.success)
      expect(result.data).toEqual({ id, name: "Nhóm vận hành", events: ["merge.failed"], enabled: true });
  });
  it("validates Telegram credentials and event selection", () => {
    const form = base();
    form.set("botToken", "123456:abcdefghijklmnopqrstuvwxyz");
    form.set("chatId", "-12345");
    expect(parseChannelForm(form, "telegram").success).toBe(true);
    form.delete("events");
    expect(parseChannelForm(form, "telegram").success).toBe(false);
    form.append("events", "merge.failed");
    form.set("botToken", "invalid");
    expect(parseChannelForm(form, "telegram").success).toBe(false);
  });
  it("parses SMTP recipients and port, omits optional credentials", () => {
    const form = base();
    form.set("host", "smtp.example.com");
    form.set("port", "587");
    form.set("tls", "starttls");
    form.set("from", " hive@example.com ");
    form.set("to", "first@example.com, second@example.com; third@example.com\nlast@example.com");
    form.delete("enabled");
    const result = parseChannelForm(form, "email");
    expect(result.success).toBe(true);
    if (result.success)
      expect(result.data).toMatchObject({
        enabled: false,
        config: {
          kind: "email",
          host: "smtp.example.com",
          port: 587,
          tls: "starttls",
          from: "hive@example.com",
          to: ["first@example.com", "second@example.com", "third@example.com", "last@example.com"],
        },
      });
    if (result.success) expect(result.data.config).not.toHaveProperty("password");
    form.set("port", "70000");
    expect(parseChannelForm(form, "email").success).toBe(false);
  });
  it("requires full credentials when replacing a Telegram connection", () => {
    const form = base();
    form.set("replaceConfig", "on");
    expect(parseChannelForm(form, "telegram", id).success).toBe(false);
    form.set("botToken", "123456:abcdefghijklmnopqrstuvwxyz");
    form.set("chatId", "@operations");
    const result = parseChannelForm(form, "telegram", id);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toMatchObject({ id, config: { kind: "telegram", chatId: "@operations" } });
  });
});
