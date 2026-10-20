// Fixture tự chứa vì fake-hub nạp các fixture này; import ngược sẽ tạo vòng phụ thuộc.
export type DeliveryDeploysHandler = (input: unknown) => { status: number; json: unknown };

/** Một khung SSE: `event`, `id` tuỳ chọn và `data` được tuần tự hoá thành JSON, như luồng log của lượt chạy. */
export interface DeployStreamFrame {
  event: string;
  id?: string;
  data: unknown;
}

/**
 * Luồng SSE giả của `/api/v1/deploys/:id/stream`, theo id lần triển khai. fake-hub trả đúng các khung này rồi đóng luồng;
 * id chưa khai báo nhận luồng rỗng. Task web của phần triển khai thêm khung vào đây.
 */
export const deliveryDeployStreams: Record<string, DeployStreamFrame[]> = {};

/** Thủ tục RPC giả của phần "deploys" (specs/020). Task web của phần này thêm thủ tục vào đây; T011 chỉ giữ chỗ. */
export function deliveryDeploysDefaults(): Record<string, DeliveryDeploysHandler> {
  return {};
}
