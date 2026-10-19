import { PageBody, PageHeader } from "@/shell/page-header.tsx";

/** Khung cho danh sách các lượt nhập Word (T021 điền bảng lượt, lọc theo trạng thái). */
export function WordImportsPage() {
  return (
    <>
      <PageHeader title="Các lượt nhập Word" description="Lịch sử nhập file Word vào tài liệu của tổ chức." />
      <PageBody>
        <p className="text-sm text-muted-foreground">Trang này đang được hoàn thiện.</p>
      </PageBody>
    </>
  );
}
