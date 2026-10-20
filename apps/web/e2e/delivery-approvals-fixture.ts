// Fixture tự chứa vì fake-hub nạp các fixture này; import ngược sẽ tạo vòng phụ thuộc.
export type DeliveryApprovalsHandler = (input: unknown) => { status: number; json: unknown };

/** Thủ tục RPC giả của phần "approvals" (specs/020). Task web của phần này thêm thủ tục vào đây; T011 chỉ giữ chỗ. */
export function deliveryApprovalsDefaults(): Record<string, DeliveryApprovalsHandler> {
  return {};
}
