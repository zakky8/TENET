# @tenet/surface-slack

Slack Surface adapter. No @slack/bolt hard dep — inject any client implementing `SlackClient`. Renders citations as Block Kit `section` blocks. Operational mode flag (`marketplace` vs `internal`) signals whether the app is subject to the post-2025-05-29 `conversations.history` cap (15 msgs/req / 1 req/min).
