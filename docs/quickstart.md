# Установка и запуск

Нужны **Node.js 24**, **pnpm** и **PostgreSQL 16**. Docker не требуется.

## 1. Зависимости и база

```bash
git clone <адрес репозитория> florasclad
cd florasclad
pnpm install
```

Создайте базу и пользователя:

```bash
sudo -u postgres psql <<'SQL'
CREATE USER flower_stock WITH PASSWORD 'flower_stock';
CREATE DATABASE flower_stock OWNER flower_stock;
SQL
```

## 2. Окружение

```bash
cp .env.example .env
```

Обязательны только `DATABASE_URL`, `PORT` и `APP_ORIGIN` плюс первый администратор
(`AUTH_ROOT_*`). **Провайдер AI не обязателен**: без него работают склад, букеты, операции
и аналитика, а ассистент и распознавание накладных отвечают, что провайдер не настроен.

## 3. Схема базы

```bash
set -a && source .env && set +a
pnpm --filter @workspace/db run push
```

## 4. Запуск

Два процесса: API и интерфейс. В двух терминалах:

```bash
pnpm --filter @workspace/api-server run dev
```

```bash
PORT=5173 pnpm --filter @workspace/flower-stock run dev
```

Интерфейс: <http://127.0.0.1:5173>, вход — логин и пароль из `AUTH_ROOT_*`.

## Демонстрационные данные

Чтобы посмотреть систему с товарами и операциями:

```bash
pnpm run seed
```

**Внимание:** сид **очищает базу** и заливает демонстрационный каталог. Запускайте его
только на пустой базе.

## Проверки

```bash
node scripts/src/status.mjs          # ревизия, что в проекте, какие проверки есть
node scripts/src/status.mjs --checks # прогнать серверные проверки подряд
```

Подробнее — [checks.md](checks.md).
