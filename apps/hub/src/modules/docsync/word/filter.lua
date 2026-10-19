-- Bộ lọc pandoc cho nhập Word của hub (spec 019). Từ FR-014 đây là bản chuẩn: tools/srs2md chép lại file này và ghi
-- FILTER_VERSION đã chép. Đổi quy tắc thì tăng FILTER_VERSION và duyệt lại fixtures/*.md vàng.
-- Chép từ tools/srs2md/srs.lua của gitlab.example.com/acme-ai/docs, commit 440f2f5b50287009788f4cf944840c023bff41e7
-- (sha256 của file 6eb181fb5147afa66cf3f5e312228c861feeba481db98570d09c4a72af907881).
local FILTER_VERSION = "1.0.0"

-- Lọc pandoc cho SRS Word: đưa bảng về pipe table vì editor của hub chỉ sửa được bảng dạng này (bảng HTML bị giữ
-- nguyên dạng chữ), và bỏ phần chỉ có nghĩa trong Word.

local BR = pandoc.RawInline("html", "<br>")

-- Mã cảnh báo cố định (plan.md mục 3 bước 4); hub đọc từ log.json dạng "<mã>:<số lần>", giao diện dịch sang tiếng Việt.
local WARNING_CODES = {
  "nested_table",
  "equation",
  "footnote",
  "emf_image",
  "tracked_changes",
  "comments",
  "no_h1",
  "textbox",
}
local counts = {}

local function note(code, n)
  counts[code] = (counts[code] or 0) + (n or 1)
end

local function count(text, pattern)
  local n = 0
  for _ in text:gmatch(pattern) do
    n = n + 1
  end
  return n
end

-- --track-changes=accept và bình luận không để lại dấu trong AST, hộp chữ thành đoạn thường; chỉ file gốc còn thấy.
-- --sandbox không chặn IO của bộ lọc, nên đọc lại được file đầu vào.
local function scan_input()
  local path = PANDOC_STATE.input_files[1]
  if not path or path == "-" then
    return
  end
  local ok, archive = pcall(function()
    local file = assert(io.open(path, "rb"))
    local data = file:read("a")
    file:close()
    return pandoc.zip.Archive(data)
  end)
  if not ok then
    return
  end
  local entries = {}
  for _, entry in ipairs(archive.entries) do
    entries[entry.path] = entry
  end
  local function read(name)
    return entries[name] and entries[name]:contents() or ""
  end
  if entries["word/document.xml"] then
    -- Hộp chữ có bản VML dự phòng trong mc:Fallback; bỏ để không đếm hai lần.
    local body = read("word/document.xml"):gsub("<mc:Fallback>.-</mc:Fallback>", "")
    note("tracked_changes", count(body, "<w:ins[%s/>]") + count(body, "<w:del[%s/>]")
      + count(body, "<w:moveFrom[%s/>]") + count(body, "<w:moveTo[%s/>]"))
    note("comments", count(read("word/comments.xml"), "<w:comment[%s>]"))
    note("textbox", count(body, "<w:txbxContent[%s>]"))
  elseif entries["content.xml"] then
    local body = read("content.xml")
    note("tracked_changes", count(body, "<text:changed%-region[%s>]"))
    note("comments", count(body, "<office:annotation[%s>]"))
    note("textbox", count(body, "<draw:text%-box[%s/>]"))
    -- Bộ đọc odt của pandoc bỏ hẳn bảng lồng (mất chữ), nên chỉ đếm được ở file gốc.
    local depth = 0
    for close in body:gmatch("<(/?)table:table[%s>]") do
      if close == "/" then
        depth = depth - 1
      else
        if depth > 0 then
          note("nested_table")
        end
        depth = depth + 1
      end
    end
  end
end

local function is_blank_inlines(inlines)
  for _, el in ipairs(inlines) do
    if el.t == "Str" then
      if not el.text:gsub("\194\160", ""):match("^%s*$") then
        return false
      end
    elseif el.t ~= "Space" and el.t ~= "SoftBreak" and el.t ~= "LineBreak" then
      return false
    end
  end
  return true
end

local function is_blank_block(block)
  return (block.t == "Para" or block.t == "Plain") and is_blank_inlines(block.content)
end

local function is_blank_item(blocks)
  for _, block in ipairs(blocks) do
    if not is_blank_block(block) then
      return false
    end
  end
  return true
end

local function with_br(inlines)
  return inlines:walk({
    LineBreak = function()
      return BR
    end,
  })
end

local function table_rows(tbl)
  local rows = {}
  for _, r in ipairs(tbl.head.rows) do
    table.insert(rows, r)
  end
  for _, body in ipairs(tbl.bodies) do
    for _, r in ipairs(body.head) do
      table.insert(rows, r)
    end
    for _, r in ipairs(body.body) do
      table.insert(rows, r)
    end
  end
  for _, r in ipairs(tbl.foot.rows) do
    table.insert(rows, r)
  end
  return rows
end

local cell_inlines

-- Pipe table không lồng được: bảng con thành chữ, mỗi hàng một dòng trong ô, các ô cách nhau bằng " | ".
local function nested_inlines(tbl)
  note("nested_table")
  local out = pandoc.Inlines({})
  for i, row in ipairs(table_rows(tbl)) do
    if i > 1 then
      out:insert(BR)
    end
    for j, cell in ipairs(row.cells) do
      if j > 1 then
        out:extend({ pandoc.Space(), pandoc.Str("|"), pandoc.Space() })
      end
      out:extend(cell_inlines(cell.contents))
    end
  end
  return out
end

cell_inlines = function(blocks)
  local out = pandoc.Inlines({})
  local function add(inlines)
    if #out > 0 then
      out:insert(BR)
    end
    out:extend(inlines)
  end
  for _, block in ipairs(blocks) do
    if is_blank_block(block) then
      -- Đoạn rỗng trong ô sẽ thành <br><br> thừa.
    elseif block.t == "Para" or block.t == "Plain" then
      add(block.content)
    elseif block.t == "BulletList" or block.t == "OrderedList" then
      for j, item in ipairs(block.content) do
        -- Mục đánh số rỗng vẫn giữ vì số là nội dung (cột STT); mục chấm rỗng thì bỏ.
        if block.t == "OrderedList" or not is_blank_item(item) then
          -- Word đánh số liền qua các ô (cột STT); pandoc giữ số đó ở start của từng danh sách.
          local n = (block.start or 1) + j - 1
          local label = pandoc.Inlines({ pandoc.Str(block.t == "BulletList" and "•" or (tostring(n) .. ".")) })
          local text = cell_inlines(item)
          if #text > 0 then
            label:insert(pandoc.Space())
            label:extend(text)
          end
          add(label)
        end
      end
    elseif block.t == "Table" then
      add(nested_inlines(block))
    else
      add(pandoc.utils.blocks_to_inlines({ block }))
    end
  end
  return with_br(out)
end

-- pending[col] = số hàng ô gộp dọc phía trên còn che cột đó; ô bị che thành ô trống để bảng vẫn đủ cột.
local function flatten(rows, ncols, pending)
  for _, row in ipairs(rows) do
    local cells, col, k = {}, 1, 1
    while col <= ncols do
      if (pending[col] or 0) > 0 then
        pending[col] = pending[col] - 1
        table.insert(cells, pandoc.Cell({}))
        col = col + 1
      elseif k <= #row.cells then
        local cell = row.cells[k]
        k = k + 1
        local rs, cs = cell.row_span or 1, cell.col_span or 1
        cell.contents = { pandoc.Plain(cell_inlines(cell.contents)) }
        cell.row_span, cell.col_span = 1, 1
        table.insert(cells, cell)
        for extra = 0, cs - 1 do
          if extra > 0 then
            table.insert(cells, pandoc.Cell({}))
          end
          if rs > 1 then
            pending[col + extra] = rs - 1
          end
        end
        col = col + cs
      else
        table.insert(cells, pandoc.Cell({}))
        col = col + 1
      end
    end
    row.cells = cells
  end
  return rows
end

function Table(tbl)
  local ncols = #tbl.colspecs
  local rows = table_rows(tbl)
  if #rows == 0 then
    return {}
  end
  flatten(rows, ncols, {})
  -- Pipe table cần đúng một hàng tiêu đề; bảng Word thường lấy hàng đầu làm tiêu đề.
  tbl.head = pandoc.TableHead({ table.remove(rows, 1) })
  tbl.bodies = { pandoc.TableBody(rows) }
  tbl.foot = pandoc.TableFoot()
  for i, spec in ipairs(tbl.colspecs) do
    tbl.colspecs[i] = { spec[1], nil }
  end
  local caption = pandoc.utils.blocks_to_inlines(tbl.caption.long)
  tbl.caption = pandoc.Caption()
  if #caption > 0 then
    return { pandoc.Para(caption), tbl }
  end
  return tbl
end

local function keep_front(meta)
  local value = meta["keep-front"]
  return value == true or (value ~= nil and pandoc.utils.stringify(value) == "true")
end

-- Trang bìa, bảng ghi nhận thay đổi, trang ký và mục lục nằm trước tiêu đề cấp 1 đầu tiên ("I. TỔNG QUAN"); mã và phiên
-- bản đã có trong front matter, lịch sử thay đổi từ đây do Git giữ. Không có tiêu đề cấp 1 thì giữ nguyên để không mất chữ.
-- Người nhập chọn giữ phần này (Q5) thì hub chạy pandoc với --metadata keep-front=true.
function Pandoc(doc)
  scan_input()
  for i, block in ipairs(doc.blocks) do
    if block.t == "Header" and block.level == 1 then
      if not keep_front(doc.meta) then
        local rest = pandoc.Blocks({})
        for j = i, #doc.blocks do
          rest:insert(doc.blocks[j])
        end
        doc.blocks = rest
      end
      return doc
    end
  end
  note("no_h1")
  return doc
end

-- gfm không có gạch chân và hình có chú thích, pandoc sẽ in thẻ <u>, <figure>.
function Underline(u)
  return u.content
end

function Figure(fig)
  local out = pandoc.Blocks(fig.content)
  local caption = pandoc.utils.blocks_to_inlines(fig.caption.long)
  if #caption > 0 then
    out:insert(pandoc.Para({ pandoc.Emph(caption) }))
  end
  return out
end

-- Kích thước ảnh làm gfm in thẻ <img>; bỏ để giữ cú pháp ![]() mà hub hiểu.
-- EMF/WMF trình duyệt không hiện được; hub giữ làm đính kèm và báo (Q10).
function Image(img)
  img.attributes = {}
  img.classes = {}
  img.identifier = ""
  if img.src:lower():match("%.[ew]mf$") then
    note("emf_image")
  end
  return img
end

-- Bookmark của Word (_Toc, _Ref…) thành <span id> và link nội bộ không còn đích sau khi chuyển.
-- Tô nền (highlight) cũng thành Span lớp "mark"; màu chữ và nền pandoc đã bỏ khi đọc.
function Span(span)
  return span.content
end

function Link(link)
  if link.target:sub(1, 1) == "#" then
    return link.content
  end
end

-- Giữ công thức và chú thích cuối trang như pandoc in ra, chỉ báo để người nhập xem lại.
function Math()
  note("equation")
end

function Note()
  note("footnote")
end

-- Mục lục Word là bản chép kèm số trang, không còn đúng sau khi chuyển. Link của mục lục trỏ tới bookmark _Toc, nhưng
-- pandoc đổi bookmark nằm trong tiêu đề thành id của tiêu đề, nên nhận cả đoạn chỉ gồm link nội bộ.
local function is_toc(block)
  local toc, other, internal = false, false, 0
  block.content:walk({
    Link = function(l)
      if l.target:match("^#_Toc") then
        toc = true
      elseif l.target:sub(1, 1) == "#" then
        internal = internal + 1
      else
        other = true
      end
    end,
  })
  if toc and not other then
    return true
  end
  if other or internal == 0 then
    return false
  end
  for _, el in ipairs(block.content) do
    if el.t ~= "Link" and el.t ~= "Space" and el.t ~= "SoftBreak" and el.t ~= "LineBreak" then
      return false
    end
  end
  return true
end

function Para(p)
  if is_toc(p) then
    return {}
  end
end

Plain = Para

-- Đoạn rỗng và mục danh sách rỗng: gfm in "6. " trống làm codec của editor ném lỗi (research mục 3).
local function drop_blank(block)
  if is_blank_inlines(block.content) then
    return {}
  end
end

local function drop_blank_items(list)
  local items = {}
  for _, item in ipairs(list.content) do
    if not is_blank_item(item) then
      table.insert(items, item)
    end
  end
  if #items == 0 then
    return {}
  end
  list.content = items
  return list
end

local function warn(doc)
  for _, code in ipairs(WARNING_CODES) do
    if (counts[code] or 0) > 0 then
      pandoc.log.warn(code .. ":" .. counts[code])
    end
  end
  return doc
end

-- Bỏ mục lục trước khi gỡ link nội bộ, vì mục lục được nhận ra nhờ link. Dàn bảng trước khi bỏ mục rỗng, để số của
-- cột STT không mất.
return {
  { Pandoc = Pandoc },
  { Span = Span, Underline = Underline, Image = Image, Math = Math, Note = Note },
  { Para = Para, Plain = Plain },
  { Link = Link, Table = Table, Figure = Figure },
  { Para = drop_blank, Plain = drop_blank, BulletList = drop_blank_items, OrderedList = drop_blank_items },
  { Pandoc = warn },
}
