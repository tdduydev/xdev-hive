import { Button } from "@xdev-hive/ui";
import { Loader2, Play, Plus, RotateCcw, Settings, Trash2, X } from "lucide-react";

// Cosmic variants (solid, glass, blue, ghost) are the 2026-10 design; outline and ghost are what most screens use.
export function Variants() {
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="solid">Giao task</Button>
        <Button variant="glass">Mở chat leader</Button>
        <Button variant="blue">Chạy lại</Button>
        <Button variant="ghost">Để sau</Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button>Lưu thay đổi</Button>
        <Button variant="outline">Huỷ</Button>
        <Button variant="secondary">Xem lịch sử</Button>
        <Button variant="brand">Tạo dự án</Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="destructive">Xoá task</Button>
        <Button variant="danger-outline">Huỷ yêu cầu</Button>
        <Button variant="link">Đọc hướng dẫn</Button>
      </div>
    </div>
  );
}

export function Sizes() {
  return (
    <div className="flex flex-wrap items-center gap-3 p-4">
      <Button variant="outline" size="xs">Sửa</Button>
      <Button variant="outline" size="sm">Lọc theo máy</Button>
      <Button variant="outline">Mặc định</Button>
      <Button variant="solid" size="md">Giao task</Button>
      <Button variant="solid" size="lg">Bắt đầu</Button>
    </div>
  );
}

export function WithIcons() {
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm"><Plus />Tạo task</Button>
        <Button variant="outline" size="sm"><Play />Giao cho máy</Button>
        <Button variant="ghost" size="sm"><RotateCcw />Làm mới</Button>
        <Button variant="danger-outline" size="sm"><Trash2 />Gỡ máy</Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon-xs" aria-label="Đóng"><X /></Button>
        <Button variant="outline" size="icon-sm" aria-label="Cài đặt"><Settings /></Button>
        <Button variant="outline" size="icon" aria-label="Thêm"><Plus /></Button>
        <Button size="icon-lg" aria-label="Chạy"><Play /></Button>
      </div>
    </div>
  );
}

export function States() {
  return (
    <div className="flex flex-wrap items-center gap-3 p-4">
      <Button variant="solid" disabled>Giao task</Button>
      <Button variant="outline" size="sm" disabled>Huỷ</Button>
      <Button size="sm" disabled><Loader2 className="animate-spin" />Đang lưu…</Button>
      <Button variant="outline" size="sm" asChild>
        <a href="#/docs">Mở tài liệu</a>
      </Button>
    </div>
  );
}
