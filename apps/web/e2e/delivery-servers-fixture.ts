// Fixture tự chứa vì fake-hub nạp các fixture này; import ngược sẽ tạo vòng phụ thuộc.
export type DeliveryServersHandler = (input: unknown) => { status: number; json: unknown };

/** Thủ tục RPC giả của phần "servers" (specs/020). Task web của phần này thêm thủ tục vào đây; T011 chỉ giữ chỗ. */
export function deliveryServersDefaults(): Record<string, DeliveryServersHandler> {
  return {};
}
