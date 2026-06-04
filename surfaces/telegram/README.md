# @tenet/surface-telegram

Telegram Surface adapter for TENET. No grammY hard dep — inject any client implementing `TelegramClient`.

Wraps:
- inbound normalization (update → `NormalizedEvent`)
- outbound formatting (HTML, with citations rendered as `<a href>` tags)
- optional rate-limit scheduling via `@tenet/rate-limit`'s `TELEGRAM_POLICY`
