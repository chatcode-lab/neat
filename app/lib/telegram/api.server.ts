import { env } from "cloudflare:workers";

/** A button under a bot message. */
export type InlineButton =
  | { text: string; url: string }
  | { text: string; callback_data: string }
  | { text: string; web_app: { url: string } };

export interface SendOptions {
  buttons?: InlineButton[][];
  /** Telegram's HTML subset; text is escaped by the caller. */
  html?: boolean;
  preview?: boolean;
}

/**
 * Calls the Bot API. Failures are logged, never thrown: a message that
 * cannot be sent must not fail the webhook, or Telegram would send the
 * update again and again.
 */
export async function botApi(method: string, payload: Record<string, unknown>): Promise<unknown> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    const answer = (await response.json()) as { ok: boolean; result?: unknown; description?: string };
    if (!answer.ok) console.error("telegram", method, answer.description);
    return answer.result ?? null;
  } catch (error) {
    console.error("telegram", method, String(error));
    return null;
  }
}

export function sendMessage(chatId: number, text: string, options: SendOptions = {}): Promise<unknown> {
  return botApi("sendMessage", {
    chat_id: chatId,
    text,
    ...(options.html ? { parse_mode: "HTML" } : {}),
    link_preview_options: { is_disabled: options.preview !== true },
    ...(options.buttons ? { reply_markup: { inline_keyboard: options.buttons } } : {}),
  });
}

export function answerCallback(id: string, text?: string, alert = false): Promise<unknown> {
  return botApi("answerCallbackQuery", { callback_query_id: id, ...(text ? { text, show_alert: alert } : {}) });
}

export function editMessage(chatId: number, messageId: number, text: string, options: SendOptions = {}): Promise<unknown> {
  return botApi("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    ...(options.html ? { parse_mode: "HTML" } : {}),
    link_preview_options: { is_disabled: options.preview !== true },
    reply_markup: { inline_keyboard: options.buttons ?? [] },
  });
}

/** Escapes text for Telegram's HTML parse mode. */
export const html = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
