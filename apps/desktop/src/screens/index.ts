import type { ComponentType } from "react";
import type { ScreenId } from "../lib/nav.ts";

/**
 * Màn đã làm của cửa sổ app, theo mục AppNav. Mục chưa có ở đây hiện trang "Sắp có". Mỗi task trong
 * specs/008-desktop-v2/tasks.md thêm đúng một dòng cho màn của nó để các task chạy song song ít đụng nhau.
 */
export const SCREENS: Partial<Record<ScreenId, ComponentType>> = {};
