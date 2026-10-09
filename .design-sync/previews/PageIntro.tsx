import { PageIntro } from "@xdev-hive/ui";

export function Basic() {
  return (
    <div className="p-4">
      <PageIntro>Bộ nhớ chung của mọi agent: quyết định, quy ước và lưu ý ghi lại trong lúc làm task.</PageIntro>
    </div>
  );
}

// A custom header that is not PageHeader: title, then the intro (max-w-3xl caps the line length).
export function UnderCustomTitle() {
  return (
    <div className="flex flex-col gap-2 p-4">
      <h1 className="type-display-md text-fg-strong">Lượt chạy</h1>
      <PageIntro>Mọi lượt chạy của agent trên các máy trong 30 ngày. Lượt chạy cũ hơn được lưu trữ, không bị xoá: mở Kho lưu trữ để xem log và kết quả của chúng.</PageIntro>
    </div>
  );
}
