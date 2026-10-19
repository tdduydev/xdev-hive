-- Bộ lọc thử: báo cờ keep-front qua pandoc.log.warn, cách filter.lua của hub báo cảnh báo.
function Pandoc(doc)
  pandoc.log.warn("keep-front=" .. tostring(doc.meta["keep-front"]))
  return doc
end
