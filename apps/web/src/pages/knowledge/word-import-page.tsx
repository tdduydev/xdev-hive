import { PageBody, PageHeader } from "@/shell/page-header.tsx";

/** Khung cho trang lượt nhập Word (T011 điền bảng file, xem trước và nút tạo tài liệu). */
export function WordImportPage() {
  return (
    <>
      <PageHeader title="Lượt nhập Word" description="Xem lại các file đã tải lên trước khi tạo tài liệu." />
      <PageBody>
        <p className="text-sm text-muted-foreground">Trang này đang được hoàn thiện.</p>
      </PageBody>
    </>
  );
}
