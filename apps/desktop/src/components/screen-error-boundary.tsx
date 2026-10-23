import { Alert, AlertDescription, AlertTitle } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { RefreshCwIcon } from "lucide-react";
import { Component, type ErrorInfo, Fragment, type ReactNode } from "react";
import { type Dict, useT } from "@/lib/i18n.ts";

const text: Dict<{ title: string; lead: string; retry: string }> = {
  vi: {
    title: "Màn này gặp lỗi khi hiển thị",
    lead: "Dữ liệu của máy có thể khác với điều app chờ đợi. Thử lại; nếu vẫn lỗi, gửi dòng bên dưới cho người hỗ trợ.",
    retry: "Thử lại",
  },
  en: {
    title: "This screen failed to render",
    lead: "This machine's data may differ from what the app expects. Try again; if it keeps failing, send the line below to support.",
    retry: "Try again",
  },
};

function Fallback({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const t = useT(text);
  const detail = error instanceof Error ? error.message : String(error);
  return (
    <Alert variant="destructive">
      <AlertTitle>{t.title}</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-2">
        <p>{t.lead}</p>
        {detail && <p className="font-mono text-xs break-all">{detail}</p>}
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCwIcon aria-hidden="true" />
          {t.retry}
        </Button>
      </AlertDescription>
    </Alert>
  );
}

interface State {
  error: unknown;
  /** Tăng mỗi lần thử lại để dựng lại màn từ đầu, kể cả state đã hỏng bên trong. */
  attempt: number;
}

/**
 * Lỗi khi vẽ một màn (dữ liệu máy lạ: thiếu ~/.ssh/config trên Linux…) mà không ai bắt thì React gỡ cả cây và cửa sổ
 * app trắng, người dùng không còn menu để đi màn khác. Bắt ở đây để chỉ màn đó hỏng, kèm nút thử lại.
 */
export class ScreenErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error || new Error("unknown") };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("[screen]", error, info.componentStack);
  }

  retry = () => this.setState((s) => ({ error: null, attempt: s.attempt + 1 }));

  override render() {
    if (this.state.error) return <Fallback error={this.state.error} onRetry={this.retry} />;
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
  }
}
