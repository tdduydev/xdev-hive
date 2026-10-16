#!/bin/zsh
# In quota của mọi tài khoản Claude và Antigravity: tên|phiên%|reset phiên|tuần%|reset tuần
# AGENT_ALL_ACCOUNTS="claude-4 claude-5" chọn tài khoản; không đặt thì lấy mọi thư mục claude-N trong ~/.xdev-hive/accounts.
source ${0:A:h}/env.sh
cd "$FLEET_DIR"
accounts=(${=AGENT_ALL_ACCOUNTS:-$(ls -1 $HOME/.xdev-hive/accounts 2>/dev/null | grep -E '^claude-[0-9]+$')})
for a in $accounts; do (
  CLAUDE_CONFIG_DIR=$HOME/.xdev-hive/accounts/$a claude -p /usage --output-format json --setting-sources user --strict-mcp-config --mcp-config '{"mcpServers":{}}' < /dev/null 2>/dev/null | python3 -c "
import json,sys,re
try: t=json.load(sys.stdin).get('result') or ''
except Exception: t=''
def g(k):
  m=re.search(k+r': (\d+)% used(?: · resets (.*))?',t)
  return (m.group(1), (m.group(2) or '-').strip()) if m else ('?','-')
s=g('Current session'); w=g(r'Current week \(all models\)')
print('$a|%s|%s|%s|%s'%(s[0],s[1],w[0],w[1]))"
) & done; wait
agy -p /usage --output-format json < /dev/null 2>/dev/null | python3 -c "
import json,sys
r=json.load(sys.stdin).get('response','')
for l in r.splitlines():
  p=l.split('\t')
  if len(p)>=4 and p[0].startswith('Claude'): print('agy-claude|'+p[1]+'|'+p[2]+' còn|'+p[3])
" 2>/dev/null
