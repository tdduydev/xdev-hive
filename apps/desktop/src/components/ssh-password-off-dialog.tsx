import { Alert, AlertDescription, AlertTitle } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@xdev-hive/ui/dialog";
import { CopyIcon } from "lucide-react";
import { useState } from "react";
import { type Dict, useT } from "@/lib/i18n.ts";
import type { SshHost } from "@/lib/ssh.ts";

/*
 * Chỉ hướng dẫn, app không chạy lệnh nào trên máy chủ (spec US5). File đặt tên 00- vì sshd lấy giá trị đầu tiên gặp,
 * và Ubuntu có thể có 50-cloud-init.conf bật mật khẩu.
 */
const commands: Dict<string> = {
  vi: `# Trên máy chủ. Giữ phiên này mở tới khi thử đăng nhập bằng khoá ở cửa sổ khác xong.
printf 'PasswordAuthentication no\\nKbdInteractiveAuthentication no\\n' | sudo tee /etc/ssh/sshd_config.d/00-xdev-hive-no-password.conf
sudo sshd -t && sudo systemctl reload ssh    # RHEL, Rocky: sshd
sudo sshd -T | grep -Ei 'passwordauthentication|kbdinteractiveauthentication'`,
  en: `# On the server. Keep this session open until key sign-in works from another window.
printf 'PasswordAuthentication no\\nKbdInteractiveAuthentication no\\n' | sudo tee /etc/ssh/sshd_config.d/00-xdev-hive-no-password.conf
sudo sshd -t && sudo systemctl reload ssh    # RHEL, Rocky: sshd
sudo sshd -T | grep -Ei 'passwordauthentication|kbdinteractiveauthentication'`,
};

const text: Dict<{
  title: string;
  lead: string;
  warnTitle: string;
  warnings: (h: SshHost) => string[];
  understood: string;
  show: string;
  copy: string;
  copied: string;
  verify: string;
  close: string;
}> = {
  vi: {
    title: "Tắt đăng nhập bằng mật khẩu",
    lead: "Khi mọi người đã dùng khoá, tắt mật khẩu để không ai đoán mật khẩu được nữa.",
    warnTitle: "Đọc kỹ trước khi làm",
    warnings: (h) => [
      `Mọi người đang vào ${h.user}@${h.hostName} bằng mật khẩu sẽ bị chặn. Họ phải chuyển sang khoá trước.`,
      `Giữ phiên đang mở trên máy chủ. Mở cửa sổ khác, thử ssh ${h.alias} bằng khoá, được rồi mới đóng phiên cũ.`,
      "Cần một đường vào dự phòng (console của máy ảo, KVM) phòng khi cấu hình sai.",
      "App không chạy lệnh nào trên máy chủ. Bạn tự chạy các lệnh trong hướng dẫn.",
    ],
    understood: "Tôi hiểu",
    show: "Xem hướng dẫn",
    copy: "Chép lệnh",
    copied: "Đã chép",
    verify:
      "Lệnh viết cho Ubuntu và Debian. Dòng cuối phải in passwordauthentication no và kbdinteractiveauthentication no.",
    close: "Đóng",
  },
  en: {
    title: "Turn off password sign-in",
    lead: "Once everyone uses keys, turn passwords off so nobody can guess one any more.",
    warnTitle: "Read this first",
    warnings: (h) => [
      `Everyone who signs in to ${h.user}@${h.hostName} with a password will be blocked. They must move to keys first.`,
      `Keep your current session open. In another window, try ssh ${h.alias} with the key, and only then close the old session.`,
      "Have a fallback way in (VM console, KVM) in case the configuration is wrong.",
      "The app runs nothing on the server. You run the commands in the guide yourself.",
    ],
    understood: "I understand",
    show: "Show guide",
    copy: "Copy commands",
    copied: "Copied",
    verify:
      "Written for Ubuntu and Debian. The last line must print passwordauthentication no and kbdinteractiveauthentication no.",
    close: "Close",
  },
};

export function SshPasswordOffDialog({ host, onClose }: { host: SshHost | null; onClose: () => void }) {
  const t = useT(text);
  const guide = useT(commands);
  const [understood, setUnderstood] = useState(false);
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);

  // Mỗi lần mở lại phải đánh dấu "Tôi hiểu" lại: hộp thoại chỉ mở được từ trạng thái đóng.
  function close() {
    setUnderstood(false);
    setShown(false);
    setCopied(false);
    onClose();
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(guide);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Dialog open={host !== null} onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.title}</DialogTitle>
          <DialogDescription>{t.lead}</DialogDescription>
        </DialogHeader>
        {host && (
          <Alert variant="destructive">
            <AlertTitle>{t.warnTitle}</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {t.warnings(host).map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
          {t.understood}
        </label>
        {shown && (
          <div className="flex flex-col gap-1.5">
            <pre className="m-0 rounded-lg bg-brand-navy px-3 py-2.5 font-mono text-xs whitespace-pre-wrap text-slate-200">
              {guide}
            </pre>
            <span className="text-xs text-muted-foreground">{t.verify}</span>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close}>
            {t.close}
          </Button>
          {shown ? (
            <Button type="button" onClick={() => void copy()}>
              <CopyIcon aria-hidden="true" />
              {copied ? t.copied : t.copy}
            </Button>
          ) : (
            <Button type="button" disabled={!understood} onClick={() => setShown(true)}>
              {t.show}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
