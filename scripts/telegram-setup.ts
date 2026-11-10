/**
 * Points the bot at the deployed Worker and sets what Telegram shows for it:
 * the webhook with its secret, the command menu, and the menu button that
 * opens the editor as a Mini App.
 *
 *   TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… npm run telegram:setup -- https://neat.link
 *
 * Run it only once the legacy bot has stopped polling: a webhook and polling
 * cannot both receive updates. BotFather settings it cannot change are
 * printed at the end.
 */
const origin = (process.argv[2] ?? "https://neat.link").replace(/\/$/, "");
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
if (!token || !secret) {
  console.error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET (the same as the Worker's secrets).");
  process.exit(1);
}

async function call(method: string, payload: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const answer = (await response.json()) as { ok: boolean; result?: unknown; description?: string };
  if (!answer.ok) throw new Error(`${method}: ${answer.description}`);
  console.log(`✓ ${method}`);
  return answer.result;
}

await call("setWebhook", {
  url: `${origin}/telegram/webhook`,
  secret_token: secret,
  allowed_updates: ["message", "callback_query"],
  drop_pending_updates: false,
});
await call("setMyCommands", {
  commands: [
    { command: "mysites", description: "Your pages and the editor" },
    { command: "login", description: "A link to sign in on the web" },
    { command: "help", description: "How it works" },
  ],
});
await call("setChatMenuButton", { menu_button: { type: "web_app", text: "Edit", web_app: { url: `${origin}/tg` } } });
await call("setMyDescription", {
  description: "One neat page for all your links: a picture, your name, a few lines and a button for every place people can find you.",
});
const info = (await call("getWebhookInfo", {})) as { url: string; pending_update_count: number; last_error_message?: string };
console.log(info);

const host = new URL(origin).host;
console.log(`
Still to do in @BotFather (once):
  /setdomain       → ${host}            (Telegram sign-in on ${host}/signin)
  /mybots → Bot Settings → Configure Mini App → ${origin}/tg
                     (legacy t.me/<bot>?startapp=<handle> links then open that page)`);
