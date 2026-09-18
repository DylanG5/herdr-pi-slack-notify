# Pi Slack Notify

An outbound-only [Herdr](https://herdr.dev) plugin that sends a Slack notification when a completed Pi agent remains unseen for a configurable delay.

The plugin does not read from Slack, accept Slack input, expose remote control, or require a custom Slack app. It calls a Slack Workflow Builder webhook with one plain-text `text` field.

## How it works

1. Herdr's Pi integration reports Pi's lifecycle and session identity.
2. When Pi finishes in a pane you are not viewing, Herdr marks the agent `done` and emits `pane.agent_status_changed`.
3. The plugin waits for `HERDR_SLACK_DELAY_SECONDS`—five minutes by default.
4. It checks that the pane is still unseen and that the same Pi session and completion are still current.
5. It sends a Slack notification. Visiting the pane, starting more work, changing sessions, or closing the pane suppresses the pending notification.

In `final` mode, the plugin reads the latest assistant text from the Pi session file. Thinking and tool output are excluded. Markdown is flattened to readable plain text, common token formats are redacted, Slack mention tokens are made inert, and the result is truncated to a safe message length. If the session cannot be read, the plugin sends a metadata-only ready message instead.

Example:

```text
Terminal: Payments · Tests
Session: Investigate failing build

Completed and unseen for 5 minutes.

Agent response:
The implementation is complete and all tests pass.
```

## Requirements

- Herdr 0.7.0 or newer
- Pi
- Node.js 22 or newer
- macOS
- Permission to create a Slack Workflow Builder workflow with a webhook trigger

## Install

Install the plugin from GitHub:

```sh
herdr plugin install DylanG5/herdr-pi-slack-notify
```

Install Herdr's managed Pi integration if it is not already installed:

```sh
herdr integration install pi
```

The Pi integration installs and manages the Pi-side lifecycle bridge. No separate Pi skill is required.

## Create the Slack workflow

The Slack workflow—not `HERDR_SLACK_CHANNEL`—controls where notifications are delivered.

1. In Slack, open **Automations** or **Workflow Builder**.
2. Create a workflow with **From a webhook** as its starting event.
3. Add one trigger variable named exactly `text` with type **Text**.
4. Add a **Send a message to a channel** step.
5. Select the channel that should receive notifications.
6. Insert the webhook trigger's `text` variable as the entire message body.
7. Publish the workflow.
8. Copy its **Web request URL**. It normally starts with:

   ```text
   https://hooks.slack.com/triggers/
   ```

The URL is a bearer secret: anyone who has it can trigger the workflow. Never commit it, paste it into an issue, or share it in chat.

## Configure the webhook and channel

Ask Herdr for the plugin's private configuration directory:

```sh
config_dir="$(herdr plugin config-dir dylan.pi-slack-notify)"
```

Create `$config_dir/.env` with the following content:

```dotenv
SLACK_WEBHOOK_URL=https://hooks.slack.com/triggers/REPLACE_WITH_YOUR_URL
HERDR_SLACK_CHANNEL=#agent-notifications
HERDR_SLACK_DELAY_SECONDS=300
HERDR_SLACK_BODY_MODE=final
HERDR_SLACK_MAX_FINAL_CHARS=2600
HERDR_SLACK_REDACT_SECRETS=1
HERDR_SLACK_ENABLED=1
```

Then restrict access to the file:

```sh
chmod 600 "$config_dir/.env"
```

Configuration options:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SLACK_WEBHOOK_URL` | none | Secret Slack Workflow Builder web request URL. |
| `HERDR_SLACK_CHANNEL` | `#agent-notifications` | Display label used in test notifications. It does **not** choose the destination. |
| `HERDR_SLACK_DELAY_SECONDS` | `300` | How long the completed pane must remain unseen before notification. |
| `HERDR_SLACK_BODY_MODE` | `final` | `final` includes the latest assistant text; `ready` sends metadata only. |
| `HERDR_SLACK_MAX_FINAL_CHARS` | `2600` | Maximum final-response characters, clamped to 500–2800. |
| `HERDR_SLACK_REDACT_SECRETS` | `1` | Redact common Slack, GitHub, and API token formats. |
| `HERDR_SLACK_ENABLED` | `1` | Set to `0`, `false`, or `off` to suppress notifications. |
| `PI_SESSION_ROOT` | `~/.pi/agent/sessions` | Optional override for a nonstandard Pi session directory. |

### Change the destination channel later

1. Edit the workflow in Slack Workflow Builder.
2. Change the channel in its **Send a message to a channel** step.
3. Republish the workflow if Slack requests it.
4. Update `HERDR_SLACK_CHANNEL` in `.env` to match the new channel label.

Changing only `HERDR_SLACK_CHANNEL` does not reroute messages; it is informational. The workflow owns the actual destination.

### Rotate the webhook

1. Create or regenerate the Slack workflow's webhook URL.
2. Replace `SLACK_WEBHOOK_URL` in `$config_dir/.env`.
3. Run the configuration check and test described below.
4. Revoke the old webhook URL in Slack.

## Verify the setup

Check configuration without printing the secret URL:

```sh
herdr plugin action invoke check --plugin dylan.pi-slack-notify
herdr plugin log list --plugin dylan.pi-slack-notify --limit 5
```

Send a real test notification:

```sh
herdr plugin action invoke test --plugin dylan.pi-slack-notify
herdr plugin log list --plugin dylan.pi-slack-notify --limit 5
```

The test action invokes the configured Slack workflow immediately.

## Local development

Clone and link the working directory:

```sh
git clone https://github.com/DylanG5/herdr-pi-slack-notify.git
cd herdr-pi-slack-notify
herdr plugin link --enabled "$PWD"
```

Run the tests:

```sh
node --test test/*.test.mjs
```

For a short end-to-end test, temporarily set:

```dotenv
HERDR_SLACK_DELAY_SECONDS=10
```

Restore the normal delay afterward. Inspect event and action failures with:

```sh
herdr plugin log list --plugin dylan.pi-slack-notify --limit 20
```

## Security and privacy

- Plugin code runs with your user permissions; review it before installation.
- The webhook URL is stored under Herdr's per-plugin config directory, outside the plugin source.
- Session reads are restricted to `~/.pi/agent/sessions` by default.
- Only assistant text is included; thinking and tool output are excluded.
- Secret redaction is best-effort. Use `HERDR_SLACK_BODY_MODE=ready` if session content should never be sent to Slack.
- Slack mention and broadcast tokens from agent output are neutralized.

## License

MIT
