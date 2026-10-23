// Hub trong mạng nội bộ có SOC: mở cổng tới máy khác (kể cả chỉ để thử) bị coi là quét SSH, như lần đo T006 ngày
// 2026-10-19 (specs/020-cicd-console/research.md). Khi tắt, mọi client của delivery dừng trước khi mở socket, dù người
// dùng đã khai máy chủ hay kết nối, để không ai vô tình gây lại sự cố đó.

export const OUTBOUND_DISABLED =
  "Hub đang tắt kết nối tới máy khác (HIVE_DELIVERY_OUTBOUND). Nhờ quản trị hub bật lại khi SOC đã đồng ý.";

// Mặc định bật để test và lệnh khác của hub không phải biết công tắc này; main.ts đặt theo cấu hình (mặc định tắt).
let enabled = true;

export function setDeliveryOutbound(on: boolean): void {
  enabled = on;
}

export function deliveryOutbound(): boolean {
  return enabled;
}
