/**
 * Каналы доставки (ТЗ 3.8, 5). Провайдер включается переменными окружения в .env.
 * Пока провайдер не настроен, сообщения проходят «имитацию» (статус simulated): вся цепочка работает,
 * но наружу ничего не уходит. Отключить имитацию: NOTIFY_DRY_RUN=0.
 *
 * push     — уведомление в кабинете (веб) и push в мобильное приложение (Expo Push → FCM / APNs, см. expo.ts).
 * telegram — TELEGRAM_BOT_TOKEN (Bot API); получатель привязывает бота по ссылке из профиля.
 * whatsapp — WHATSAPP_TOKEN, WHATSAPP_PHONE_ID (WhatsApp Cloud API). Вне 24-часового окна диалога
 *            Meta требует заранее одобренные шаблоны — их регистрирует заказчик в Meta Business.
 * sms      — SMS_GATEWAY_URL (+ SMS_GATEWAY_TOKEN): POST JSON { phone, text } — адаптер к шлюзу,
 *            выбранному заказчиком (ТЗ 5: провайдер утверждается на этапе проектирования).
 * email    — EMAIL_API_URL, EMAIL_API_KEY, EMAIL_FROM: POST JSON { from, to, subject, text }.
 */
export const CHANNELS = ['push', 'telegram', 'whatsapp', 'sms', 'email'] as const;
export type Channel = (typeof CHANNELS)[number];

export interface Address {
  userId?: string | null;
  phone?: string | null;
  email?: string | null;
  telegramChatId?: string | null;
}

export interface SendResult {
  ok: boolean;
  simulated?: boolean;
  error?: string;
}

const env = (k: string) => process.env[k]?.trim() || '';
const dryRun = () => env('NOTIFY_DRY_RUN') !== '0';

/** Есть ли у получателя адрес для канала. */
export function hasAddress(ch: Channel, a: Address) {
  switch (ch) {
    case 'push':
      return !!a.userId;
    case 'telegram':
      return !!a.telegramChatId;
    case 'whatsapp':
    case 'sms':
      return !!a.phone;
    case 'email':
      return !!a.email;
  }
}

export function isConfigured(ch: Channel) {
  switch (ch) {
    case 'push':
      return true;
    case 'telegram':
      return !!env('TELEGRAM_BOT_TOKEN');
    case 'whatsapp':
      return !!env('WHATSAPP_TOKEN') && !!env('WHATSAPP_PHONE_ID');
    case 'sms':
      return !!env('SMS_GATEWAY_URL');
    case 'email':
      return !!env('EMAIL_API_URL') && !!env('EMAIL_API_KEY') && !!env('EMAIL_FROM');
  }
}

/** Канал можно использовать: настроен или включена имитация. */
export const isAvailable = (ch: Channel) => isConfigured(ch) || dryRun();

export function channelStatus() {
  return CHANNELS.map((c) => ({ channel: c, configured: isConfigured(c), simulated: !isConfigured(c) && dryRun() }));
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<SendResult> {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (r.ok) return { ok: true };
    return { ok: false, error: `HTTP ${r.status}: ${(await r.text()).slice(0, 300)}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Отправка во внешний канал. push сохраняется в БД сервисом (уведомление в кабинете). */
export async function send(ch: Channel, a: Address, title: string, body: string): Promise<SendResult> {
  if (ch === 'push') return { ok: true };
  if (!isConfigured(ch)) return dryRun() ? { ok: true, simulated: true } : { ok: false, error: 'Провайдер не настроен' };
  const text = title ? `${title}\n${body}` : body;
  switch (ch) {
    case 'telegram':
      return post(`https://api.telegram.org/bot${env('TELEGRAM_BOT_TOKEN')}/sendMessage`, { chat_id: a.telegramChatId, text });
    case 'whatsapp':
      return post(
        `https://graph.facebook.com/v20.0/${env('WHATSAPP_PHONE_ID')}/messages`,
        { messaging_product: 'whatsapp', to: a.phone, type: 'text', text: { body: text } },
        { Authorization: `Bearer ${env('WHATSAPP_TOKEN')}` },
      );
    case 'sms':
      return post(env('SMS_GATEWAY_URL'), { phone: a.phone, text }, env('SMS_GATEWAY_TOKEN') ? { Authorization: `Bearer ${env('SMS_GATEWAY_TOKEN')}` } : {});
    case 'email':
      return post(env('EMAIL_API_URL'), { from: env('EMAIL_FROM'), to: a.email, subject: title, text: body }, { Authorization: `Bearer ${env('EMAIL_API_KEY')}` });
  }
}
