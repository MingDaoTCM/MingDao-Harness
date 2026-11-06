#!/bin/bash
# MDH 异地备份（香港源站 → 深圳节点），每天 03:30。
#
# 用 tar over ssh 而不是 rsync：**香港生产机没有装 rsync**（实测 `which rsync` → 无），
# 为了备份去给生产机装包不值得；tar 流式传输同样一次握手、同样的压缩。
#
# 备什么（按"丢了最麻烦"排序）：
#   1. nginx 站点配置（conf.d）——含手工改动（404 修复、论坛反代），丢了站点直接不可用；
#   2. 站点静态内容（html/updates/stats，排除 downloads 大文件）；
#   3. 下载清单（sha256 + 体积）——安装包可重下，但"哪一版有哪些包"必须留证。
# 不备大文件安装包（633MB/版，可从 GitHub 重下）；BACKUP_FULL=1 时才拉（首次接线用）。
set -uo pipefail
DEST=/var/backups/mdh
H="root@8.210.103.117"
SSH="ssh -i /root/.ssh/id_ed25519_hk -o StrictHostKeyChecking=no -o ConnectTimeout=15"
STAMP=$(date +%Y%m%d-%H%M)
mkdir -p "$DEST/site-$STAMP" "$DEST/conf-$STAMP"
fail=0

# 1) nginx 配置（tar over ssh）
if $SSH "$H" 'tar czf - -C /opt/1panel/www/conf.d .' 2>/dev/null | tar xzf - -C "$DEST/conf-$STAMP" 2>/dev/null; then
  echo "  配置: $(find "$DEST/conf-$STAMP" -type f | wc -l) 个文件"
else
  echo "  WARN 配置备份失败"; fail=1
fi

# 2) 站点静态（排除 downloads 与 *.bak-*）
if $SSH "$H" "tar czf - --exclude='downloads' --exclude='*.bak-*' -C /opt/1panel/www/sites/mingdao-site ." 2>/dev/null | tar xzf - -C "$DEST/site-$STAMP" 2>/dev/null; then
  echo "  站点: $(find "$DEST/site-$STAMP" -type f | wc -l) 个文件"
else
  echo "  WARN 站点备份失败"; fail=1
fi

# 3) 下载清单（源站算，避免把 633MB 拉回来）
$SSH "$H" 'cd /opt/1panel/www/sites/mingdao-site/downloads && sha256sum * 2>/dev/null' > "$DEST/site-$STAMP/downloads.sha256" || true
$SSH "$H" 'ls -l /opt/1panel/www/sites/mingdao-site/downloads 2>/dev/null | awk "{print \$5, \$9}"' > "$DEST/site-$STAMP/downloads.size" || true
echo "  清单: $(wc -l < "$DEST/site-$STAMP/downloads.sha256" | tr -d ' ') 个安装包已登记 sha256"

# 4) 可选全量安装包
if [ "${BACKUP_FULL:-0}" = "1" ]; then
  mkdir -p "$DEST/downloads"
  if $SSH "$H" 'tar czf - -C /opt/1panel/www/sites/mingdao-site/downloads .' 2>/dev/null | tar xzf - -C "$DEST/downloads" 2>/dev/null; then
    echo "  安装包: 全量已备份（$(du -sh "$DEST/downloads" | cut -f1)）"
  else echo "  WARN 安装包备份失败"; fail=1; fi
fi

# 5) 保留最近 14 份
ls -1dt "$DEST"/site-* "$DEST"/conf-* 2>/dev/null | tail -n +15 | xargs -r rm -rf
echo "$(date '+%F %T') 备份完成（失败标记=$fail）：$(du -sh "$DEST/site-$STAMP" | cut -f1) 站点 / $(du -sh "$DEST/conf-$STAMP" | cut -f1) 配置"
exit $fail
