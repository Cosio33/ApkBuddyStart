#!/usr/bin/env bash
# Envía docs/promo/wechat-article.md al borrador de la cuenta oficial de WeChat con un solo comando
# Uso:
#   1) configura las variables de entorno WECHAT_APP_ID / WECHAT_APP_SECRET, o
#   2) escríbelas en $HOME/.baoyu-skills/.env (o en el archivo indicado por WECHAT_ENV_FILE)
# Requisito previo: la «Configuración básica → Lista blanca de IP» del panel de la cuenta oficial debe incluir la IP pública de esta máquina
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

ENV_FILE="${WECHAT_ENV_FILE:-$HOME/.baoyu-skills/.env}"
EXTRA=()
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  EXTRA+=(--env-file "$ENV_FILE")
fi

if [ -z "$WECHAT_APP_ID" ] || [ -z "$WECHAT_APP_SECRET" ]; then
  echo "Faltan credenciales: configura WECHAT_APP_ID / WECHAT_APP_SECRET, o escríbelas en $ENV_FILE" >&2
  exit 1
fi

wenyan publish \
  "${EXTRA[@]}" \
  -f docs/promo/wechat-article.md \
  -t lapis -h solarized-light --no-footnote

echo "Enviado al borrador: inicia sesión en https://mp.weixin.qq.com → Gestión de contenido → Borradores, revisa y envía a todos"
