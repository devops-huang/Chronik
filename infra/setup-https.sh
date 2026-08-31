#!/usr/bin/env bash
# 辰箓 (Chronik) · 生产环境 HTTPS 一键部署脚本
# 作用：在服务器上安装 Nginx + certbot，配置反代，申请 Let's Encrypt 免费证书并自动续期。
#
# ⚠️ 前置条件（本脚本不负责，需先完成）：
#   1. chronik.cn 的 DNS A 记录已指向本机公网 IP（在域名注册商控制台操作）
#   2. 云安全组已放行 TCP 80 与 443
#   3. 本机 8787 端口的 bazi-system 服务已在运行
#   4. 以 root 执行，且系统为 OpenCloudOS / CentOS / Rocky（dnf 可用）
#
# 用法：  bash infra/setup-https.sh

set -euo pipefail

DOMAIN="chronik.cn"
WWW="www.chronik.cn"
EMAIL="tonyandrewhn@outlook.com"   # 证书到期提醒邮箱（请改为你自己的）
WEBROOT="/var/www/letsencrypt"
APP_PORT="8787"

echo "▶ [1/6] 安装 Nginx + certbot ..."
dnf install -y nginx certbot 2>/dev/null || yum install -y nginx certbot

echo "▶ [2/6] 放置 Nginx 配置 ..."
mkdir -p /etc/nginx/conf.d "$WEBROOT"
# 若从仓库内执行，使用仓库内配置；否则用内联兜底
if [ -f infra/nginx/chronik.conf ]; then
  cp infra/nginx/chronik.conf /etc/nginx/conf.d/chronik.conf
else
  cat > /etc/nginx/conf.d/chronik.conf <<EOF
server {
    listen 80;
    server_name ${DOMAIN} ${WWW};
    location /.well-known/acme-challenge/ { root ${WEBROOT}; }
    location / { return 301 https://\$host\$request_uri; }
}
server {
    listen 443 ssl;
    server_name ${DOMAIN} ${WWW};
    ssl_certificate     /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 20m;
    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_read_timeout 120s;
    }
}
EOF
fi

echo "▶ [3/6] 校验配置并启动 Nginx ..."
nginx -t
systemctl enable --now nginx

echo "▶ [4/6] 申请 Let's Encrypt 证书（webroot 模式，不改已写好的 conf）..."
certbot certonly --webroot -w "$WEBROOT" \
  -d "$DOMAIN" -d "$WWW" \
  --non-interactive --agree-tos -m "$EMAIL"

echo "▶ [5/6] 重载 Nginx 启用 HTTPS ..."
systemctl reload nginx

echo "▶ [6/6] 验证 ..."
sleep 2
curl -sS -o /dev/null -w "HTTP(80→443 重定向): %{http_code}\n" "http://${DOMAIN}/login.html"
curl -sS --max-time 15 -o /dev/null -w "HTTPS: %{http_code}\n" "https://${DOMAIN}/login.html"

echo ""
echo "✅ 完成。证书位于 /etc/letsencrypt/live/${DOMAIN}/"
echo "   自动续期由 certbot 的 systemd timer 负责（certbot renew），无需手动干预。"
echo "   如需开启 HSTS，取消 chronik.conf 中 add_header Strict-Transport-Security 的注释后 reload。"
