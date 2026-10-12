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

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: shouldRetry } } });
const router = createAppRouter(queryClient);

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
