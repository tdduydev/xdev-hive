import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { shouldRetry } from "@/lib/api-errors.ts";
import { watchSystemTheme } from "@/lib/theme.ts";
import { createAppRouter } from "@/router.tsx";
import "@/styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Thiếu #root trong index.html");

watchSystemTheme();

/*
 * Dữ liệu vừa tải trong 10 giây thì chuyển trang qua lại không tải lại: trang chủ và bảng việc dùng chung tasks.list,
 * runs.latest (cả nghìn dòng), trước đây mỗi lần chuyển trang đều gọi lại. Trang vẫn tự làm mới theo refetchInterval
 * riêng, và thao tác sửa vẫn làm mới dữ liệu liên quan (invalidateQueries) ngay.
 */
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: shouldRetry, staleTime: 10_000 } } });
const router = createAppRouter(queryClient);

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
