import { Button } from "@xdev-hive/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@xdev-hive/ui/dialog";
import { Pill } from "@xdev-hive/ui/pill";
import { useEffect, useRef, useState } from "react";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { type ApprovalRequest, formatWhen, secretApprovals, secretApprove } from "@/lib/secrets.ts";
import { errorText } from "@/lib/tauri.ts";

/** Chu kỳ hỏi worker có yêu cầu duyệt nào đang chờ (contracts/tauri-commands.md). */
export const APPROVAL_POLL_MS = 2000;

const text: Dict<{
  title: string;
  lead: (project: string) => string;
  names: string;
  run: (id: string) => string;
  expires: (when: string) => string;
  more: (n: number) => string;
  deny: string;
  allow: string;
  answering: string;
}> = {
  vi: {
    title: "Run xin dùng bí mật",
    lead: (project) =>
      `Run của dự án ${project} cần các bí mật dưới đây. Chỉ cho phép khi bạn nhận ra yêu cầu này; không trả lời thì yêu cầu hết hạn và bị từ chối.`,
    names: "Bí mật được xin",
    run: (id) => `Run ${id}`,
    expires: (when) => `Hết hạn lúc ${when}`,
    more: (n) => `Còn ${n} yêu cầu khác đang chờ.`,
    deny: "Từ chối",
    allow: "Cho phép",
    answering: "Đang gửi…",
  },
  en: {
    title: "A run asks for secrets",
    lead: (project) =>
      `A run of project ${project} needs the secrets below. Allow only if you recognise this request; if you do not answer it expires and is declined.`,
    names: "Secrets requested",
    run: (id) => `Run ${id}`,
    expires: (when) => `Expires at ${when}`,
    more: (n) => `${n} more ${n === 1 ? "request is" : "requests are"} waiting.`,
    deny: "Decline",
    allow: "Allow",
    answering: "Sending…",
  },
};

/**
 * Hộp thoại duyệt bí mật cho run của dự án có chính sách "Hỏi trước" (FR-031). Gắn một lần ở vỏ app: hỏi worker mỗi
 * 2 giây, hiện yêu cầu cũ nhất. Chỉ có tên và dự án, không giá trị. Nút mặc định, Esc và đóng hộp đều là Từ chối.
 */
export function SecretApprovalDialog() {
  const [pending, setPending] = useState<ApprovalRequest[]>([]);
  // Yêu cầu vừa trả lời có thể còn nằm trong lượt hỏi đang bay; không cho nó hiện lại.
  const answered = useRef(new Set<string>());

  useEffect(() => {
    // Ngoài app Tauri (vd. trình duyệt khi dev) không có worker để hỏi.
    if (!window.__TAURI__) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const { pending: got } = await secretApprovals();
        if (!stopped) {
          const now = Date.now();
          setPending(got.filter((r) => !answered.current.has(r.id) && !(Date.parse(r.expiresAt) <= now)));
        }
      } catch {
        // Worker cũ chưa có lệnh hay đang khởi động: lượt sau hỏi lại, không báo lỗi cho người dùng.
      }
      if (!stopped) timer = setTimeout(() => void poll(), APPROVAL_POLL_MS);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  const current = pending[0];
  if (!current) return null;
  return (
    <Request
      key={current.id}
      request={current}
      more={pending.length - 1}
      onAnswered={(id) => {
        answered.current.add(id);
        setPending((cur) => cur.filter((r) => r.id !== id));
      }}
    />
  );
}

function Request({
  request,
  more,
  onAnswered,
}: {
  request: ApprovalRequest;
  more: number;
  onAnswered: (id: string) => void;
}) {
  const t = useT(text);
  const lang = useLang();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function answer(allow: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await secretApprove(request.id, allow);
      onAnswered(request.id);
    } catch (e) {
      // Hết hạn hay đã có câu trả lời thì lượt hỏi sau sẽ bỏ yêu cầu này; lỗi khác để người dùng thử lại.
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && void answer(false)}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t.title}</DialogTitle>
          <DialogDescription>{t.lead(request.projectName || request.project)}</DialogDescription>
        </DialogHeader>
        <section aria-label={t.names}>
          <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
            {request.names.map((n) => (
              <li key={n}>
                <Pill className="font-mono">{n}</Pill>
              </li>
            ))}
          </ul>
        </section>
        <p className="text-xs break-all text-muted-foreground">
          {t.run(request.runId)} · {t.expires(formatWhen(request.expiresAt, lang))}
        </p>
        {more > 0 && <p className="text-xs text-muted-foreground">{t.more(more)}</p>}
        {error && (
          <p role="alert" className="rounded-lg bg-destructive-soft px-3 py-2 text-sm break-words text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => void answer(true)}>
            {t.allow}
          </Button>
          {/* Từ chối là nút được focus đầu và là nút nổi: Enter nhầm không cấp bí mật. */}
          <Button autoFocus disabled={busy} onClick={() => void answer(false)}>
            {busy ? t.answering : t.deny}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
