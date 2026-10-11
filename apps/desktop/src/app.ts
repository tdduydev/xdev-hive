export {};

declare global {
  interface Window {
    __TAURI__: { core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> } };
  }
}
const invoke = window.__TAURI__.core.invoke;
const form = document.querySelector<HTMLFormElement>("#registration");
const hub = document.querySelector<HTMLInputElement>("#hub");
const token = document.querySelector<HTMLInputElement>("#token");
const command = document.querySelector<HTMLTextAreaElement>("#command");
const submit = document.querySelector<HTMLButtonElement>("#submit");
const message = document.querySelector<HTMLParagraphElement>("#message");
if (!form || !hub || !token || !command || !submit || !message) throw new Error("Thiếu thành phần đăng ký");

void invoke<boolean>("plugin:notification|is_permission_granted")
  .then(async (granted) => {
    if (!granted) await invoke("plugin:notification|request_permission");
  })
  .catch(() => {});

document.querySelector("#parse")?.addEventListener("click", async () => {
  try {
    const parsed = await invoke<{ hub: string; token: string }>("parse_registration", { input: command.value });
    hub.value = parsed.hub;
    token.value = parsed.token;
    command.value = "";
    message.textContent = "Đã điền địa chỉ hub và token.";
  } catch (error) {
    message.textContent = String(error);
  }
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  submit.disabled = true;
  message.textContent = "Đang đăng ký máy…";
  try {
    await invoke("register_worker", { hub: hub.value, token: token.value });
    token.value = "";
    command.value = "";
    message.textContent = "Đã đăng ký. Worker đang kết nối với hub.";
  } catch (error) {
    message.textContent = String(error);
  } finally {
    submit.disabled = false;
  }
});
