# Văn bản Markdown, sơ đồ Mermaid và Terminal

Bổ sung cho `DocEditor` (soạn, xem), `Docs`/`DocReview` (web) và `AppDocs` (app desktop). Các artboard `.dc.html` giữ
bố cục màn; phần dưới là kiểu chữ, màu và hành vi dùng chung cho mọi chỗ hiện Markdown và terminal. Canvas chưa vẽ
lại các khối này: khi vẽ, theo đúng bảng dưới.

## Một nguồn style

| Thành phần | Nơi sống | Dùng ở |
|---|---|---|
| `.hive-prose` (typography), `.hive-code`, `.hive-mermaid` | `packages/ui/src/prose.css`, nạp qua `styles.css` của web và desktop | chế độ Xem và Soạn, knowledge docs, reviews, khung file của AppDocs, chat "Tài liệu từ code" |
| `Markdown` | `packages/ui/src/markdown.tsx` | mọi chỗ render Markdown ngoài editor |
| `CodeBlock` (tô màu, tên ngôn ngữ, nút chép, số dòng) | `packages/ui/src/code-block.tsx` | `Markdown` và khối code của Tiptap |
| `MermaidDiagram`, `renderMermaid` | `packages/ui/src/mermaid-diagram.tsx`, `mermaid-render.ts` | `Markdown` và khối Mermaid của Tiptap |
| Bảng màu terminal | `packages/ui/src/terminal-theme.ts` | terminal nhúng của app, Terminal Leader trên web |

Không chép style sang chỗ khác. Màu đi theo token (`tokens.json`), đổi sáng/tối bằng class `.dark` ở `<html>`.

## Typography

- Cỡ gốc 14px, dòng cao 1.7. Tiêu đề đậm 600, thang 24/20/17/15px (h1–h4), cách phần trên 1.6em; chỉ h2 có đường kẻ.
- Link dùng `--primary`, gạch chân khi hover. Trích dẫn có vạch trái `--primary` và nền primary 6%.
- Bảng: viền `--border`, tiêu đề nền `--muted`, hàng chẵn nền zebra; bảng rộng cuộn ngang trong khung.
- Checklist: ô tick `accent-color: --primary`; mục đã tick mờ đi và gạch ngang. Mục "dự kiến, chưa có code" (`.hive-planned`) tô `--warning`.
- Inline code: nền `--muted`, viền `--border`, font mono 0.88em, tắt ligature.

## Khối code

- Tô cú pháp bằng highlight.js (qua lowlight) với bộ ngôn ngữ giới hạn (bash, TS/JS, Go, Rust, Python, SQL, JSON, YAML, Markdown, diff, HTML/XML, CSS…). Nạp lười: chỉ tải khi trang có khối code. Fence không rõ ngôn ngữ thì hiện chữ thường, không đoán.
- Thanh trên của khối: tên ngôn ngữ (trái); công tắc số dòng và nút **Chép** (phải). Dòng dài cuộn ngang, không xuống dòng.
- Màu cú pháp là biến `--syn-*` (comment, keyword, string, number, title, type, attr, meta, addition, deletion) khai báo cho `:root` và `.dark`. Mỗi màu đạt tương phản WCAG AA 4.5:1 với nền khối (`--muted` ở sáng, `--background` ở tối); `prose.test.ts` kiểm.
- Font mono `JetBrains Mono Variable`, 13px, tắt ligature để `!=`, `=>` hiện đúng ký tự.

## Mermaid

- Theme `base` của Mermaid, đổ từ token: nền node `--accent`, viền và mũi tên `--primary`/`--muted-foreground`, chữ `--foreground`, font `--font-sans`. Nền SVG trong suốt; nền do khung quyết định. Đổi sáng/tối thì vẽ lại.
- Khung có viền `--border`, thanh trên có nhãn "Sơ đồ" và các nút: thu nhỏ, phóng to (hiện %, 50–400%), vừa khung, xem toàn màn hình (hộp thoại), **Tải SVG**, xem mã nguồn.
- Lỗi cú pháp: thông báo tiếng Việt gọn ("Sơ đồ có lỗi cú pháp ở dòng N"), ba dòng đầu của lỗi Mermaid, kèm mã nguồn bên dưới. Không để khung báo lỗi của Mermaid chen vào trang.
- Mermaid nặng nên chỉ tải khi trang có sơ đồ (`import("mermaid")`).

## Terminal

- 16 màu ANSI cho nền `--card`: bảng sáng và tối ở `terminal-theme.ts`. Mỗi màu đạt AA 4.5:1 với nền (riêng `black` ở tối và `white` ở sáng chỉ cần 3:1 vì là màu nền/chữ mặc định của CLI). Chế độ sáng đặt màu "bright" đậm hơn màu thường. xterm còn có `minimumContrastRatio` 4.5 cho màu 256/truecolor do CLI tự chọn.
- Con trỏ dạng vạch, màu `--primary`; vùng chọn xanh nhạt (sáng) hoặc xanh đậm (tối), mất tiêu điểm thì xám.
- Font mono 13px, thanh trên có ô chọn cỡ chữ (11–18px, nhớ trong `localStorage`). Tắt ligature vì xterm vẽ từng ô.
- Link `http(s)` trong output bấm được (addon web-links); bề rộng ô theo Unicode 11 cho emoji và chữ Việt.
- Tiến trình trong PTY chạy với `TERM=xterm-256color`, `COLORTERM=truecolor`, `FORCE_COLOR=1`, `CLICOLOR=1`, `CLICOLOR_FORCE=1` và `LS_COLORS` mặc định (chỉ dùng 16 màu ANSI nên theme quyết định màu thật). Không đặt `NO_COLOR`.
