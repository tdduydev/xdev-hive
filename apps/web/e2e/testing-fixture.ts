// Fixture tự chứa vì fake-hub nạp các fixture này; import ngược sẽ tạo vòng phụ thuộc.
export type TestingHandler = (input: unknown) => { status: number; json: unknown };

/**
 * Thủ tục RPC giả của `testing` (specs/036). Mặc định rỗng: fake-hub nạp hàm này vào mọi spec, nên trang không liên quan
 * không bị ảnh hưởng. Task web của từng story thêm kịch bản ở file này.
 */
export function testingDefaults(): Record<string, TestingHandler> {
  return {};
}

export const TESTING_PROJECT_ID = "3c3c3c3c-0000-4000-8000-000000000036";
export const TESTING_PROJECT_KEY = "billing";
export const TESTING_TEAM_ID = "3c3c3c3c-0000-4000-8000-0000000000a1";
