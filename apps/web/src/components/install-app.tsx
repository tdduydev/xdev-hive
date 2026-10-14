import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { DownloadIcon } from "lucide-react";
import { useState } from "react";
import { type Dict, useT } from "@/lib/i18n.ts";
import { promptInstall, useInstallKind } from "@/lib/pwa.ts";

const text: Dict<{ install: string; iosTitle: string; iosSteps: string[]; close: string }> = {
  vi: {
    install: "Cài lên màn hình chính",
    iosTitle: "Cài xDev Hive trên iPhone, iPad",
    iosSteps: [
      "Mở trang này bằng Safari.",
      "Bấm nút Chia sẻ (hình vuông có mũi tên lên) ở thanh dưới.",
      "Chọn “Thêm vào MH chính”, rồi bấm Thêm.",
    ],
    close: "Đã hiểu",
  },
  en: {
    install: "Install to home screen",
    iosTitle: "Install xDev Hive on iPhone or iPad",
    iosSteps: [
      "Open this page in Safari.",
      "Tap the Share button (square with an up arrow) in the bottom bar.",
      "Choose “Add to Home Screen”, then tap Add.",
    ],
    close: "Got it",
  },
};

/** Nút cài PWA: hộp cài của trình duyệt (Chrome, Edge, Android) hoặc hướng dẫn tay trên iOS. Không hiện khi đã cài. */
export function InstallApp() {
  const t = useT(text);
  const kind = useInstallKind();
  const [guide, setGuide] = useState(false);
  if (kind === "none") return null;
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="w-full group-data-[collapsible=icon]:hidden"
        onClick={() => (kind === "prompt" ? void promptInstall() : setGuide(true))}
      >
        <DownloadIcon aria-hidden="true" />
        {t.install}
      </Button>
      <Dialog open={guide} onOpenChange={setGuide}>
        <DialogContent>
          <DialogTitle>{t.iosTitle}</DialogTitle>
          <DialogDescription render={<div />}>
            <ol className="grid list-decimal gap-1.5 pl-5">
              {t.iosSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </DialogDescription>
          <DialogActions>
            <Button onClick={() => setGuide(false)}>{t.close}</Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </>
  );
}
