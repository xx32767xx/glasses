#!/usr/bin/env bash
# diagnose-terms.sh —— 一条命令回答"热词为什么没生效"
# 用法：bash scripts/diagnose-terms.sh
set -u
SECRETS=$(ls -d /var/lib/leion/*/ 2>/dev/null)
echo "═══ ① 正在跑的服务用的是哪个数据目录 ═══"
for port in 8788 8789; do
  sec_file=$(ls /var/lib/leion/*/relay-secret.txt 2>/dev/null | head -1)
  for f in /var/lib/leion/*/relay-secret.txt; do
    [ -f "$f" ] || continue
    s=$(cat "$f")
    out=$(curl -s -m 2 "http://127.0.0.1:$port/hello?secret=$s" 2>/dev/null)
    [ -n "$out" ] || continue
    status=$(curl -s -m 2 "http://127.0.0.1:$port/status?secret=$s" 2>/dev/null)
    inbox=$(echo "$status" | python3 -c "import json,sys;print(json.load(sys.stdin).get('inbox',''))" 2>/dev/null)
    if [ -n "$inbox" ]; then
      echo "  端口 $port 活着 → 收件箱 $inbox"
      echo "                 → 数据目录 $(dirname "$inbox")"
    else
      echo "  端口 $port 活着（但 /status 没给 inbox）"
    fi
    break
  done
done

echo ""
echo "═══ ② 每个数据目录里的会议术语快照 ═══"
for d in /var/lib/leion/*/; do
  [ -d "$d" ] || continue
  echo "  [$d]"
  if [ -f "${d}meeting-terms/terms.json" ]; then
    python3 - "${d}meeting-terms/terms.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
tables=d.get('tables') or {}
print('    terms.json 存在；表：', {k:len(v.get('entries',[])) for k,v in tables.items()})
PY
  else
    echo "    ✗ 没有 meeting-terms/terms.json（这一套从没发布过）"
  fi
  [ -f "${d}meeting-terms/meta.json" ] && echo "    meta: $(cat "${d}meeting-terms/meta.json")"
done

echo ""
echo "═══ ③ 大脑实际用的词表条数（判据） ═══"
grep 热词表 ~/glasses/var/logs/brain.log 2>/dev/null | tail -3 || echo "  没有 brain.log"

echo ""
echo "═══ ④ 库里的条目数（读 leion.db） ═══"
for d in /var/lib/leion/*/; do
  [ -f "${d}leion.db" ] || continue
  echo "  [$d]"
  python3 - "$d" <<'PY'
import sys, sqlite3
db = sqlite3.connect(sys.argv[1] + 'leion.db')
for row in db.execute('SELECT l.id, l.name, COUNT(e.id) FROM libraries l LEFT JOIN library_entries e ON e.library_id=l.id GROUP BY l.id'):
    print('    ', row[0], row[1], '条目', row[2])
PY
done