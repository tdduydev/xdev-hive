/**
 * Cổng cố định: Playwright khởi động web server (Vite) trước global setup, nên Vite phải biết trước cổng của hub để
 * proxy /rpc và /api tới. Chọn cổng khác hub dev (3000) và Vite dev (5173) để chạy song song được.
 */
export const HUB_PORT = 4311;
export const WEB_PORT = 4175;
export const WEB_URL = `http://localhost:${WEB_PORT}`;

/** Biến môi trường global setup đặt cho test: URL superuser của database, để seed thứ chưa có API (lời mời). */
export const DATABASE_URL_ENV = "HIVE_E2E_DATABASE_URL";

/** Người đầu tiên của hub; cũng nằm trong HIVE_ORG_CREATORS để tạo được tổ chức thứ hai và thử đổi tổ chức. */
export const OWNER = { name: "Trần Đức Duy", email: "duy@e2e.test", password: "mat-khau-e2e-0123" };
export const MEMBER = { name: "Lê Hà", email: "ha.le@e2e.test", password: "mat-khau-e2e-4567" };
