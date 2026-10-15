//! Chấm màu trên biểu tượng khay theo trạng thái worker (AppTray.dc.html): xám khi tắt, vàng khi đang chuyển trạng
//! thái, xanh khi nhận việc, đỏ khi mất kết nối hoặc lỗi. Vẽ thẳng lên ảnh RGBA, không cần thêm file ảnh cho mỗi màu.

/// Màu theo token chung (docs/design-system/tokens.json, bản sáng): muted-foreground, warning, success, destructive.
pub fn dot_color(kind: &str) -> [u8; 4] {
    match kind {
        "online" => [0x15, 0x80, 0x3d, 0xff],
        "starting" | "connecting" | "stopping" => [0xb4, 0x53, 0x09, 0xff],
        "disconnected" | "failed" => [0xc8, 0x1e, 0x1e, 0xff],
        _ => [0x47, 0x55, 0x69, 0xff],
    }
}

/// Chấm báo có người đang điều khiển từ xa: xanh dương, khác bốn màu trạng thái worker để không lẫn.
pub const REMOTE_DOT: [u8; 4] = [0x1d, 0x4e, 0xd8, 0xff];

/// Vẽ chấm tròn ở góc dưới phải, có viền trong suốt để chấm tách khỏi biểu tượng. `rgba` dài `width * height * 4`.
pub fn with_dot(rgba: &[u8], width: u32, height: u32, color: [u8; 4]) -> Vec<u8> {
    draw_dot(rgba, width, height, color, false)
}

/// Như `with_dot`, và khi `remote` thì thêm chấm báo điều khiển từ xa ở góc trên phải. Hai góc khác nhau để chấm trạng
/// thái worker vẫn đọc được lúc đang có người điều khiển.
pub fn with_dots(rgba: &[u8], width: u32, height: u32, color: [u8; 4], remote: bool) -> Vec<u8> {
    let base = draw_dot(rgba, width, height, color, false);
    if remote {
        draw_dot(&base, width, height, REMOTE_DOT, true)
    } else {
        base
    }
}

fn draw_dot(rgba: &[u8], width: u32, height: u32, color: [u8; 4], top: bool) -> Vec<u8> {
    let mut out = rgba.to_vec();
    let size = width.min(height) as f32;
    let r = size * 0.22;
    let ring = size * 0.06;
    let cx = width as f32 - r - ring;
    let cy = if top {
        r + ring
    } else {
        height as f32 - r - ring
    };
    for y in 0..height {
        for x in 0..width {
            let d = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
            let i = ((y * width + x) * 4) as usize;
            if d <= r {
                out[i..i + 4].copy_from_slice(&color);
            } else if d <= r + ring {
                out[i + 3] = 0;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draws_the_dot_in_the_corner_and_keeps_the_rest() {
        let (w, h) = (32, 32);
        let base = vec![10u8; (w * h * 4) as usize];
        let out = with_dot(&base, w, h, dot_color("online"));
        let px = |x: u32, y: u32| &out[((y * w + x) * 4) as usize..((y * w + x) * 4 + 4) as usize];
        assert_eq!(px(w - 9, h - 9), &[0x15, 0x80, 0x3d, 0xff]);
        assert_eq!(px(2, 2), &[10, 10, 10, 10]);
        assert_eq!(out.len(), base.len());
    }

    #[test]
    fn remote_dot_sits_top_right_and_leaves_the_worker_dot() {
        let (w, h) = (32, 32);
        let base = vec![10u8; (w * h * 4) as usize];
        let out = with_dots(&base, w, h, dot_color("online"), true);
        let px = |x: u32, y: u32| &out[((y * w + x) * 4) as usize..((y * w + x) * 4 + 4) as usize];
        assert_eq!(px(w - 9, 8), &REMOTE_DOT);
        assert_eq!(px(w - 9, h - 9), &[0x15, 0x80, 0x3d, 0xff]);
        assert_eq!(
            with_dots(&base, w, h, dot_color("online"), false),
            with_dot(&base, w, h, dot_color("online"))
        );
    }

    #[test]
    fn colours_follow_states() {
        assert_eq!(dot_color("online"), [0x15, 0x80, 0x3d, 0xff]);
        assert_eq!(dot_color("connecting"), dot_color("stopping"));
        assert_eq!(dot_color("failed"), dot_color("disconnected"));
        assert_eq!(dot_color("stopped"), [0x47, 0x55, 0x69, 0xff]);
    }
}
