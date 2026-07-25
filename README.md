# mutual-bot

MVP по RFC «Бот учёта взаимных подписок для каналов художников», ревизия 2.

Односторонний сервис: обслуживает одного владельца канала, от контрагента
не требует ничего. Ловит уходы подписчиков, сопоставляет их с журналом мью
и показывает, от каких каналов пора отписаться.

## Статус

Собран: зависимости поставлены, `npm run typecheck` проходит, миграция
сгенерирована (`drizzle/0000_*.sql`). Проверены вживую только чистые функции —
`parseExport`, `parseHandleList`, `normalizeChannelId`, рендер карточки и отчёта.

**Не проверялось ни разу:** всё, что ходит в Postgres, Redis и Telegram API.
Запросы написаны, но ни один не выполнялся. Первый запуск — по инструкции ниже.

## Структура

```
src/index.ts              точка входа бота, long polling
src/config.ts             env + ALLOWED_UPDATES (§5.3)
src/queue.ts              BullMQ: очереди, расписание сверки
src/db/{index,schema}.ts  подключение и схема (§7)
src/bot/index.ts          сборка бота, порядок хэндлеров
src/bot/handlers/         commands, callbacks, chat-member
src/services/             events, pairs, triage, import, report
src/workers/index.ts      triage + reconcile, отдельным процессом
scripts/probe-get-chat.ts блокирующая проверка §5.2
```

## Запуск

```bash
cp .env.example .env       # вписать BOT_TOKEN
docker compose up -d
npm install
npm run db:generate && npm run db:migrate
npm run dev                # бот
npm run worker             # воркеры, отдельным процессом
```

## Порядок работ

1. **`npm run probe -- <user_id>`** — блокирующая проверка RFC §5.2.
   Инструкция в шапке `scripts/probe-get-chat.ts`. Делать до всего остального:
   результат определяет, будет ли автоподстановка канала в карточке триажа.
2. Добавить бота админом в тестовый канал, подписаться-отписаться вторым
   аккаунтом, убедиться что `chat_member` приходит.
3. Прогнать реальный экспорт Telegram Desktop через `parseExport` — сверить
   схему `result.json` и формат ID (см. предупреждение в `src/services/import.ts`).

## Что реализовано

| RFC | Где |
|---|---|
| §5.3 `allowed_updates` | `src/config.ts`, `src/index.ts` |
| §7 схема | `src/db/schema.ts` |
| §7.2 append-only лог, дедуп по `update_id` | `src/services/events.ts` |
| §7.2 проекция полным реплеем | `projectMembership` |
| §7.2 `at_precision` для reconcile | `src/workers/index.ts` |
| §8.1 импорт экспорта и списка | `src/services/import.ts` |
| §8.2 ловля `chat_member`, постановка в grace | `src/bot/handlers/chat-member.ts` |
| §8.2 триаж уходов, grace через лог | `src/workers/index.ts` |
| §8.3 п.3 ручной ввод `@handle` | `src/bot/handlers/callbacks.ts` + `commands.ts` |
| §9 отчёт, 4 раздела | `src/services/report.ts` |
| §10 ежесуточная сверка | `reconcileWorker` |
| §13 `/delete_me` стирает лог | `src/bot/handlers/callbacks.ts` |
| §14 онбординг через `getChatAdministrators` | `src/bot/handlers/chat-member.ts` |

§8.3 п.1 (`personal_chat`) и п.2 (матч по префиксу username) не реализованы:
первый ждёт результата `npm run probe`, второй отнесён в v1.1 по §14.

## Осознанные отступления от RFC

- **Long polling вместо вебхука.** `allowed_updates` работает и там, публичный
  URL для MVP не нужен. Переезд на вебхук — один вызов `setWebhook` с тем же
  списком из `ALLOWED_UPDATES`.
- **Парсинг экспорта через `JSON.parse` с лимитом размера.** Стримовый парсер
  (`stream-json`) нужен, когда появятся реальные файлы на сотни мегабайт.
  Пока — лимит и текстовый список как запасной путь.
- **Состояние «жду @handle» лежит в `triage_items.payload`**, а не в отдельной
  FSM. На одну ветку диалога плагин conversations избыточен.

## Чего бот не делает и делать не будет

Не подписывается и не отписывается за пользователя — в Bot API этого нет.
Отчёт даёт ссылку, отписывается владелец руками.
