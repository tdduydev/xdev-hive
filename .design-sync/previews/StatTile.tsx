import { StatTile } from "@xdev-hive/ui";

// A grid of 2–4 key numbers at the top of a dashboard.
export function Dashboard() {
  return (
    <div className="grid grid-cols-3 gap-4 p-4">
      <StatTile label="Run đang chạy" value="3" detail="trên 2 máy" />
      <StatTile label="Lượt chạy hôm nay" value="148" detail="96% thành công" />
      <StatTile label="Chi phí tuần" value="$42,80" detail="còn $57,20 trong ngân sách" />
    </div>
  );
}

export function Single() {
  return (
    <div className="max-w-xs p-4">
      <StatTile label="Task chờ review" value="7" detail="lâu nhất 2 giờ · R-73a" />
    </div>
  );
}

// detail is optional; value is a node, so a unit or a ratio fits.
export function WithoutDetail() {
  return (
    <div className="grid grid-cols-2 gap-4 p-4">
      <StatTile label="Máy trực tuyến" value="2 / 3" />
      <StatTile label="Thời gian trung bình" value="18 phút" />
    </div>
  );
}
