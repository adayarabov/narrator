# narrator

A Claude Code mod that lets Claude talk to you while it works, as on a call.

- **Narration.** Claude gets a `say` tool and rules for when to use it: the plan, a changed hypothesis, a finding, a real fork in the road, the outcome. Routine reads and commands stay silent. `/voice off|quiet|normal|chatty` sets how talkative it is.
- **Listening page.** At session start the mod shows a link; open it in a browser and press *Enable sound*. Lines are spoken sentence by sentence, with in-browser Piper voices or server-side Silero voices.
- **Side chat.** Type or talk on the page (call mode: pick up once, then just speak). A fork of the session answers without touching the main thread; instructions are handed to Claude before its next step, and a stop asks you to confirm before it interrupts the task.

## Install

```
/plugin marketplace add adayarabov/marketplace
/plugin install narrator@adayarabov
```

Or from this repository alone:

```
/plugin marketplace add adayarabov/narrator
/plugin install narrator@narrator
```

Then start a session, open the link from the toast (or run `/voice-link`), and press *Enable sound*.

## Commands

| Command | |
|---|---|
| `/narrator [on\|off\|status]` | Turn narrator on or off as a whole (speech, side chat, page channel), or show its state |
| `/voice-link` | The page link for this session |
| `/voice [off\|quiet\|normal\|chatty]` | How much Claude speaks |
| `/voice-usage` | Tokens and cost the side chat forks have spent in this session |

## Privacy

- Lines and side-chat messages are encrypted in the mod with a per-session key that lives only in the page link, after `#`, which browsers never send to a server. The relay stores and forwards ciphertext.
- With Piper voices and in-browser speech recognition, text and audio never leave your machine. With Silero voices, the decrypted text of each line goes to the relay's speech server to be voiced.
- Anyone with the page link can read the session's narration and send instructions to Claude through the side chat. Treat the link like a password.

## Relay

By default the mod uses `https://narrator.trq.one`. To use your own relay, set the `serviceUrl` option (`/plugin configure narrator@adayarabov`).

## Cost

Each side-chat message is one fork of the session: one request over the session's context, read from the prompt cache. With a large context that is about $0.10 per message on Claude Opus; `/voice-usage` shows the real numbers.
