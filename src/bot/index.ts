import { Bot, GrammyError, HttpError } from 'grammy';
import { config } from '../config.js';
import { registerCallbacks } from './handlers/callbacks.js';
import { registerChatMember } from './handlers/chat-member.js';
import { registerCommands } from './handlers/commands.js';

export const bot = new Bot(config.botToken);

// Порядок важен: в registerCommands последним висит catch-all на message:text.
registerChatMember(bot);
registerCallbacks(bot);
registerCommands(bot);

bot.catch((err) => {
  const e = err.error;
  if (e instanceof GrammyError) console.error('telegram error', e.description);
  else if (e instanceof HttpError) console.error('network error', e);
  else console.error('unhandled error', e);
});
