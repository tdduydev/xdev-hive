import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createAppRouter } from "./router.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Thiếu #root trong index.html");

const queryClient = new QueryClient();
const router = createAppRouter(queryClient);

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
