/**
 * RFC §5.2 — блокирующая проверка перед разработкой подсказок канала.
 *
 * Вопрос: резолвится ли getChat(user_id) для пользователя, который
 * засветился только в chat_member и НЕ нажимал /start?
 * Ответ определяет, есть ли в §8.3 автоподстановка канала.
 *
 * Как проверять:
 *  1. Добавь бота админом в тестовый канал.
 *  2. Со второго аккаунта (с привязанным личным каналом в профиле,
 *     и НЕ запуская бота) подпишись на канал.
 *  3. Возьми его user_id из лога chat_member.
 *  4. npm run probe -- <user_id>
 */
import { Bot } from 'grammy';
import { config } from '../src/config.js';

const userId = Number(process.argv[2]);
if (!userId) {
  console.error('usage: npm run probe -- <user_id>');
  process.exit(1);
}

const bot = new Bot(config.botToken);

try {
  const chat = await bot.api.getChat(userId);
  console.log('getChat OK');
  console.log('personal_chat:', 'personal_chat' in chat ? chat.personal_chat : '(нет поля)');
  console.log('\nВывод: §8.3 п.1 реализуем.');
} catch (e) {
  console.error('getChat FAILED:', e instanceof Error ? e.message : e);
  console.error('\nВывод: §8.3 п.1 выпиливаем, остаются п.2 (матч по username) и п.3 (ручной ввод).');
}
