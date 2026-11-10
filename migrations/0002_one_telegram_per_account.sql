-- An account holds at most one Telegram identity. linkTelegram checks it in
-- the same statement that links; this makes it hold for any writer.
CREATE UNIQUE INDEX "account_one_telegram" ON "account" ("userId") WHERE "providerId" = 'telegram';
