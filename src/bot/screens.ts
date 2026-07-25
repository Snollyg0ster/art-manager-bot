import { InlineKeyboard, type Api } from 'grammy';
import { config } from '../config.js';
import { buildReport, handleOf, renderReport } from '../services/report.js';
import { mutualSubs, mutualSubsCount, nextUnlabeled } from '../services/pairs.js';
import {
  ensureJoinedItem, newSubscribers, type NewSubscriber,
} from '../services/subscribers.js';
import {
  channelLabel, openTriageItems, renderTriageCard, triageKeyboard,
} from '../services/triage.js';

/**
 * Один экран = текст плюс кнопки. Команды и кнопки ведут сюда же, чтобы
 * /report и «Отчёт» никогда не расходились в поведении.
 */
export type Screen = {
  text: string;
  keyboard: InlineKeyboard;
};

/** Главное меню. Первым идёт то, с чего начинают, последним — необратимое. */
export function mainMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text('📥 Загрузить подписки', 'm:import').row()
    .text('🏷 Разметить', 'm:label').row()
    .text('📊 Отчёт', 'm:report').text('👋 Разобрать уходы', 'm:triage').row()
    .text('➕ Новые подписчики', 'm:new').row()
    .text('🚪 Я отписался', 'm:mutuals').row()
    .text('❓ Как это работает', 'm:help').row()
    .text('🗑 Удалить мои данные', 'm:wipe');
}

function withBack(kb: InlineKeyboard): InlineKeyboard {
  return kb.row().text('‹ Меню', 'm:menu');
}

export function startScreen(): Screen {
  return {
    text: [
      'Я показываю, кто отписался от твоего канала, и помогаю решить,',
      'от кого пора отписаться в ответ.',
      '',
      'Как начать — три шага:',
      '',
      '1. Добавь меня админом в свой канал. Права выдавать не нужно',
      '   никакие: я читаю только события подписок.',
      '2. Пришли список каналов, на которые подписан сам.',
      '3. Отметь кнопками, где у тебя взаимная подписка.',
      '',
      'Дальше я работаю сам: как только кто-то уйдёт, пришлю карточку.',
      '',
      'Важно знать сразу: подписываться и отписываться за тебя я не могу,',
      'в Telegram нет такой возможности для ботов. Я показываю, что делать,',
      'кнопку нажимаешь ты.',
    ].join('\n'),
    keyboard: mainMenu(),
  };
}

export function helpScreen(): Screen {
  return {
    text: [
      '❓ Как это работает',
      '',
      'Уходы я вижу событиями от Telegram — в тот же момент, но только',
      'в каналах, где я админ, и только с минуты, когда меня добавили.',
      'Кто отписался раньше — узнать нельзя, такого метода нет.',
      '',
      `После ухода я жду ${Math.round(config.graceMs / 60000)} минут: люди`,
      'нередко отписываются случайно и возвращаются. Если не вернулся —',
      'пришлю карточку с кнопками.',
      '',
      'Журнал мью — это твой список: кого ты считаешь взаимным.',
      'Он нужен, чтобы отличить «ушёл человек из мью» от «ушёл случайный',
      'подписчик». Загрузить его — «Загрузить подписки», разметить — «Разметить».',
    ].join('\n'),
    keyboard: withBack(new InlineKeyboard().text('📥 Загрузить подписки', 'm:import')),
  };
}

export function importScreen(): Screen {
  return {
    text: [
      '📥 Загрузить подписки — два пути.',
      '',
      'Быстрый: пришли каналы текстом, по одному в строке.',
      'Подойдут и @handle, и ссылки t.me.',
      '',
      'Полный: Telegram Desktop → Настройки → Продвинутые →',
      'Экспорт данных из Telegram. Отметь только Public channels',
      'и Private channels, формат JSON, размер медиа — минимум.',
      `Пришли мне result.json файлом, до ${Math.round(config.maxExportBytes / 1024 / 1024)} МБ.`,
      '',
      'Приватные каналы по @handle не добавляются — только экспортом.',
    ].join('\n'),
    keyboard: withBack(new InlineKeyboard()),
  };
}

/** Сколько кнопок «Отписался» вешаем на отчёт, чтобы он не стал стеной кнопок. */
const BROKEN_BUTTONS = 5;

export async function reportScreen(api: Api, ownerUserId: number): Promise<Screen> {
  const report = await buildReport(api, ownerUserId);
  const kb = new InlineKeyboard();

  // §9: список на отписку требует действия — кнопка закрытия рядом с ним.
  for (const c of report.broken.slice(0, BROKEN_BUTTONS)) {
    kb.text(`✅ Отписался от ${handleOf(c)}`, `d:${c.pairId}`).row();
  }

  if (report.triage.length > 0) kb.text('👋 Разобрать уходы', 'm:triage').row();
  if (report.joined.items.length > 0) kb.text('➕ Новые подписчики', 'm:new').row();
  if (report.unlabeled > 0) kb.text('🏷 Разметить', 'm:label').row();

  return { text: renderReport(report), keyboard: withBack(kb.text('🔄 Обновить', 'm:report')) };
}

/** Сколько мью показываем на экране «я отписался». */
const MUTUALS_PAGE = 8;

/**
 * Отписку владельца бот увидеть не может — в Bot API нет метода про подписки
 * пользователя (§12). Единственный путь — сказать ему кнопкой.
 */
export async function mutualsScreen(ownerUserId: number, offset = 0): Promise<Screen> {
  const [subs, total] = await Promise.all([
    mutualSubs(ownerUserId, MUTUALS_PAGE, offset),
    mutualSubsCount(ownerUserId),
  ]);

  if (subs.length === 0) {
    return {
      text: offset > 0
        ? 'Дальше ничего нет.'
        : 'Взаимных подписок в журнале нет — отмечать нечего.',
      keyboard: mainMenu(),
    };
  }

  // Ряд разделяем только между кнопками: withBack добавит свой, а пустой ряд
  // Telegram присылать не за что.
  const kb = new InlineKeyboard();
  subs.forEach((s, i) => {
    kb.text(`🚪 Отписался от ${channelLabel(s)}`, `u:${s.id}`);
    if (i < subs.length - 1) kb.row();
  });

  const shown = offset + subs.length;
  if (shown < total) kb.row().text(`Ещё ${total - shown} →`, `mu:${shown}`);

  return {
    text: [
      `🚪 Я отписался — ${offset + 1}–${shown} из ${total}`,
      '',
      'Отметь, от кого ты больше не подписан. Сам я этого не вижу:',
      'Telegram не даёт боту список твоих подписок.',
      '',
      'Из журнала мью запись уйдёт, счётчик «взаимно» её больше не посчитает,',
      'и следить за этой парой я перестану.',
      '',
      'Если список длинный — быстрее командой: /unsub @handle.',
    ].join('\n'),
    keyboard: withBack(kb),
  };
}

export async function labelScreen(ownerUserId: number): Promise<Screen> {
  const next = await nextUnlabeled(ownerUserId);
  if (!next) {
    return {
      text: 'Всё размечено. Дальше я сам — пришлю карточку, когда кто-то уйдёт.',
      keyboard: mainMenu(),
    };
  }

  return {
    text: `${channelLabel(next)}\nЭто взаимная подписка?`,
    keyboard: withBack(new InlineKeyboard()
      .text('Мью', `l:${next.id}:m`)
      .text('Не мью', `l:${next.id}:n`)
      .text('Пропустить', `l:${next.id}:s`)),
  };
}

export async function triageScreen(ownerUserId: number): Promise<Screen> {
  const items = await openTriageItems(ownerUserId);
  const item = items.find((i) => !i.payload.awaitingChannel);
  if (!item) {
    return { text: 'Разбирать нечего — уходов не было.', keyboard: mainMenu() };
  }

  return {
    text: renderTriageCard(item.payload),
    keyboard: withBack(triageKeyboard(item)),
  };
}

/** Карточка нового подписчика: §8.3 п.1 подставляет канал, решает владелец. */
export async function newSubsScreen(api: Api, ownerUserId: number): Promise<Screen> {
  const { items, more } = await newSubscribers(api, ownerUserId);
  const next = items[0];
  if (!next) {
    return {
      text: 'Новых подписчиков нет — из тех, на кого ты ещё не подписан в ответ.',
      keyboard: mainMenu(),
    };
  }

  const itemId = await ensureJoinedItem(ownerUserId, next);
  const left = items.length - 1 + more;

  return {
    text: renderNewSubscriber(next, left),
    keyboard: withBack(newSubKeyboard(itemId, next)),
  };
}

function renderNewSubscriber(s: NewSubscriber, left: number): string {
  const lines = [`➕ Подписался ${s.who}`];

  if (s.channel) {
    lines.push(
      `   Канал в его профиле: ${channelLabel(s.channel)} (предположение)`,
      '',
      'Подпишешься в ответ — жми «Подписался, это мью», и я начну следить',
      'за этой парой. Отписаться от тебя незаметно уже не получится.',
    );
  } else {
    lines.push(
      '   Канала в профиле нет, так что связать его с каналом я не могу.',
      '',
      'Если знаешь его канал — пришли «/add @handle», и я запишу мью.',
    );
  }

  if (left > 0) lines.push('', `Осталось разобрать: ${left}.`);

  return lines.join('\n');
}

function newSubKeyboard(itemId: number, s: NewSubscriber): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (s.channel) kb.text('✅ Подписался, это мью', `j:${itemId}:y`).row();
  return kb.text('Скрыть', `j:${itemId}:n`).text('Позже', `j:${itemId}:s`);
}
