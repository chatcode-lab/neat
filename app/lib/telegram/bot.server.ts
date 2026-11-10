import { env } from "cloudflare:workers";

import { type Account, accountRecord, linkTelegram, rememberTelegramUser, userForTelegram } from "../db/accounts.server";
import { sitesOf } from "../db/sites.server";
import { claimTelegramToken, issueTelegramToken, peekTelegramToken } from "../db/telegram-tokens.server";
import { answerCallback, editMessage, html, type InlineButton, sendMessage } from "./api.server";
import type { TelegramUser } from "./verify";

/** The parts of a Telegram update the bot reads. */
interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type: string };
  text?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id: string; from: TgUser; message?: TgMessage; data?: string };
}

function userOf(from: TgUser): TelegramUser {
  return {
    id: from.id,
    firstName: from.first_name,
    lastName: from.last_name ?? null,
    username: from.username ?? null,
    photoUrl: null,
  };
}

const editorButton = (origin: string): InlineButton => ({ text: "✏️ Open the editor", web_app: { url: `${origin}/tg` } });

/** The linked account of whoever wrote, keeping their Telegram name current. */
async function linkedAccount(from: TgUser, now: number): Promise<Account | null> {
  const userId = await userForTelegram(env.DB, from.id);
  if (!userId) return null;
  await rememberTelegramUser(env.DB, userOf(from), now);
  return accountRecord(env.DB, userId);
}

async function greet(chatId: number, account: Account | null, origin: string): Promise<void> {
  const host = new URL(origin).host;
  if (!account) {
    await sendMessage(
      chatId,
      [
        "<b>neat.link</b>: one neat page for all your links.",
        "",
        `New pages are made at ${html(host)}. Sign up with Google there, then link Telegram in Settings to manage your pages from here.`,
        "",
        "Already had a page made with this bot? It is linked to your Telegram: open the editor below.",
      ].join("\n"),
      { html: true, buttons: [[{ text: `Open ${host}`, url: `${origin}/signin` }], [editorButton(origin)]] },
    );
    return;
  }
  const sites = await sitesOf(env.DB, account.id);
  const lines = [`Hi <b>${html(account.telegram?.name ?? account.name)}</b>!`, ""];
  if (sites.length === 0) {
    lines.push("You have no page yet. Make one in the editor.");
  } else {
    lines.push(sites.length === 1 ? "Your page:" : "Your pages:");
    for (const site of sites) {
      lines.push(`• ${html(`${host}/${site.handle}`)}${site.published ? "" : " (draft)"}`);
    }
  }
  const buttons: InlineButton[][] = sites
    .filter((site) => site.published)
    .map((site) => [{ text: `${host}/${site.handle}`, url: `${origin}/${site.handle}` }]);
  buttons.push([editorButton(origin)], [{ text: "🌐 Sign in on the web", callback_data: "login" }]);
  await sendMessage(chatId, lines.join("\n"), { html: true, buttons });
}

async function sendLoginLink(chatId: number, account: Account | null, origin: string, now: number): Promise<void> {
  if (!account) {
    await greet(chatId, null, origin);
    return;
  }
  const token = await issueTelegramToken(env.DB, { userId: account.id, purpose: "login", now });
  await sendMessage(chatId, "Here is your sign-in link. It works once, within 10 minutes. Do not share it.", {
    buttons: [[{ text: "🌐 Sign in on the web", url: `${origin}/auth/telegram/link?${new URLSearchParams({ t: token })}` }]],
  });
}

/** Asks to confirm linking this Telegram account to the account that made the token in Settings. */
async function offerLink(chatId: number, from: TgUser, token: string, origin: string, now: number): Promise<void> {
  const userId = await peekTelegramToken(env.DB, token, "link", now);
  const account = userId ? await accountRecord(env.DB, userId) : null;
  if (!account) {
    await sendMessage(chatId, "That link has expired. Open Settings on neat.link and try again.");
    return;
  }
  const already = await userForTelegram(env.DB, from.id);
  if (already === account.id) {
    await sendMessage(chatId, "This Telegram account is already linked to your neat.link account.", { buttons: [[editorButton(origin)]] });
    return;
  }
  await sendMessage(
    chatId,
    `Link this Telegram account to the neat.link account <b>${html(account.email ?? account.name)}</b>? You can then sign in with Telegram and edit your pages here. Only confirm if you started this yourself.`,
    { html: true, buttons: [[{ text: "Link", callback_data: `link:${token}` }, { text: "Cancel", callback_data: "cancel" }]] },
  );
}

const LINK_RESULTS = {
  linked: "Linked! You can now sign in with Telegram and open the editor here.",
  already_linked: "This Telegram account is already linked to that neat.link account.",
  taken: "This Telegram account is already linked to another neat.link account.",
  has_other: "That neat.link account already has another Telegram account linked.",
} as const;

async function onMessage(message: TgMessage, origin: string, now: number): Promise<void> {
  if (message.chat.type !== "private" || !message.from || message.from.is_bot) return;
  const chatId = message.chat.id;
  const text = (message.text ?? "").trim();
  const [command = "", payload = ""] = text.split(/\s+/, 2);
  const name = command.toLowerCase().replace(/@.*$/, "");

  if (name === "/start" && payload.startsWith("link_")) {
    await offerLink(chatId, message.from, payload.slice("link_".length), origin, now);
    return;
  }
  const account = await linkedAccount(message.from, now);
  if (name === "/login" || (name === "/start" && payload === "login")) {
    await sendLoginLink(chatId, account, origin, now);
    return;
  }
  if (name === "/start" || name === "/mysites" || name === "/edit") {
    await greet(chatId, account, origin);
    return;
  }
  if (name === "/help") {
    await sendMessage(
      chatId,
      [
        "/mysites – your pages and the editor",
        "/login – a link to sign in on the web",
        "",
        `Pages are edited in the editor (the button below the chat), at ${new URL(origin).host}/app, or by an AI agent: ${origin}/agents`,
      ].join("\n"),
    );
    return;
  }
  await greet(chatId, account, origin);
}

async function onCallback(query: NonNullable<TgUpdate["callback_query"]>, origin: string, now: number): Promise<void> {
  const data = query.data ?? "";
  const chatId = query.message?.chat.id;
  if (data === "login" && chatId) {
    await answerCallback(query.id);
    await sendLoginLink(chatId, await linkedAccount(query.from, now), origin, now);
    return;
  }
  if (data.startsWith("link:") && chatId && query.message) {
    const userId = await claimTelegramToken(env.DB, data.slice("link:".length), "link", now);
    const result = userId ? await linkTelegram(env.DB, userId, userOf(query.from), now) : null;
    await answerCallback(query.id);
    await editMessage(chatId, query.message.message_id, result ? LINK_RESULTS[result] : "That link has expired. Open Settings on neat.link and try again.", {
      buttons: result === "linked" ? [[editorButton(origin)]] : [],
    });
    return;
  }
  if (data === "cancel" && chatId && query.message) {
    await answerCallback(query.id);
    await editMessage(chatId, query.message.message_id, "Cancelled.");
    return;
  }
  // Buttons under the old bot's messages.
  await answerCallback(query.id, "This menu is from the old version of the bot. Send /start for the new one.", true);
}

/** Handles one update from Telegram's webhook. Errors are logged, never thrown back to Telegram. */
export async function handleUpdate(update: TgUpdate, origin: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  try {
    if (update.message) await onMessage(update.message, origin, now);
    else if (update.callback_query) await onCallback(update.callback_query, origin, now);
  } catch (error) {
    console.error("telegram update", update.update_id, error);
  }
}
