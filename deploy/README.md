# Развёртывание на сервере

Готовые заготовки для Ubuntu: служба systemd, конфиг nginx и скрипт обновления.
Ничего из этого не обязательно: проект работает и просто запущенным процессом.

1. Установите Node.js 24, pnpm и PostgreSQL 16.
2. Создайте базу и пользователя, скопируйте `.env.example` в `.env` и заполните.
3. Примените схему: `pnpm --filter @workspace/db run push`.
4. Соберите: `pnpm install && pnpm run build`.
5. Скопируйте `florasklad-api.service` в `/etc/systemd/system/`, замените `sklad` на
   своего пользователя и путь — на свой каталог, затем `systemctl enable --now florasklad-api`.
6. Конфиг nginx: замените `example.com` на свой домен и пропишите TLS (certbot).

Обновление: `bash deploy/update.sh` — делает резервную копию базы, забирает изменения,
пересобирает, применяет схему и перезапускает службу.
