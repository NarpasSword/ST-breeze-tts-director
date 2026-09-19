# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A SillyTavern third-party extension: **Breeze Director & Player**. One `index.js`
(~1000 lines, no build step, no dependencies) that does two things sharing one
text-splitting rule:

- **Director** — one LLM call per chat message writes a delivery instruction for
  every paragraph, stored in the chat file. The TTS provider picks those up while
  narrating.
- **Player** — an inline panel per message with paragraph-level seek, per-message
  resume, and take history.

There is no build, lint, or test tooling. The file is plain ES module JS loaded
directly by the browser.

## Hard dependency: the Breeze TTS provider

This extension does nothing on its own. It requires a **separate** extension,
`breeze-tts`, which registers the `Breeze` TTS provider and publishes
`globalThis.breezeTts`. That provider lives outside this repo (see
`../breeze-tts/` in the working tree, and the parent `CLAUDE.md` for its notes).

The coupling is entirely through two globals, never imports:

- This extension **reads** `globalThis.breezeTts` — `available`, `listVoices`,
  `hasVoice`, `addVoice`, `assignVoice`, `voiceForCharacter`, `prefetch`,
  `getClip`, `cacheStats`, `clearCache`.
- This extension **publishes** `globalThis.breezeDirector(text, voiceId, preset)`.
  The provider calls it for every narration line and falls back to the voice's
  static instruction whenever it returns `null` or throws.

Consequence: `manifest.json` `loading_order` must stay **above** the provider's
(11 → this is 12). Every call into `breezeTts` must tolerate it being absent.

## Install / iterate

No build. Deploy by putting the folder where SillyTavern serves per-user
extensions, then hard-reload the browser:

```
SillyTavern/data/<handle>/extensions/<folder>/     # e.g. data/narpas/extensions/breeze-director/
```

Served to the page as `/scripts/extensions/third-party/<folder>/index.js`. The
folder name is free (nothing imports this by path), unlike `breeze-tts`, which
imports `../../tts/index.js` and therefore must sit beside SillyTavern's own
`tts` extension.

Note the repo is `ST-breeze-tts-director` while the deployed folder and the
parent notes call it `breeze-director`; keep that in mind when following paths
in comments.

Console checks while iterating:

```js
SillyTavern.getContext().extensionSettings.breeze_director   // settings actually persisted
SillyTavern.getContext().chat.at(-1).extra.breeze_direction  // the stored take + history
globalThis.breezeTts.available                               // provider bound?
globalThis.breezeTts.voiceForCharacter('Name')
await globalThis.breezeTts.cacheStats()
```

## Architecture

### Narration units must mirror SillyTavern's splitting

`buildUnits()` splits a message by `\n`, dropping empty lines — **exactly** what
SillyTavern's TTS extension does when it builds narration jobs. One unit here is
one generated clip there. If that rule drifts, `pickLine()` can no longer match
the text the provider hands back and every instruction falls through to
paragraph 1.

The `.bak` file preserves an earlier design that further split each line into
dialogue / action / narration segments, mirroring ST's optional
`multi_voice_enabled`. That was **deliberately reverted** — it produced
sentence-sized fragments. Don't reintroduce it without also handling
`multi_voice_enabled` invalidation of stored directions.

### Data model

`message.extra.breeze_direction`, saved into the chat file by `saveChat()`:

```js
{ swipe_id, ts, lines: [{ text, instruction }], history: [{ ts, lines }] }  // history capped at HISTORY_LIMIT = 5
```

`getDirection()` returns `null` when `swipe_id` no longer matches, so swiping
silently invalidates a take rather than misapplying it. Text goes in the chat
(small, worth exporting); audio never does — the provider caches clips in
IndexedDB.

Player resume positions live in `extensionSettings.breeze_player.resume`, keyed
`"<chatId>:<messageId>"`, pruned past 200 entries.

### Two settings keys, for history

Settings are split across `breeze_director` and `breeze_player` because these
were once separate extensions. Keep both keys — renaming drops users' configs.

### Flow

1. `CHARACTER_MESSAGE_RENDERED` → `prepare(index)`: generate direction, design a
   voice if the character has none, then prefetch every clip. Doing this before
   narration means **no LLM call happens during playback**.
2. The provider calls `globalThis.breezeDirector(text, …)` per line. It locates
   the message by fuzzy-matching normalized text (`locate`, `pickLine`), awaits
   any in-flight precompute for that message rather than racing it, and returns
   `{ instruction, cfg_scale }`.
3. `on_missing` decides the no-direction case: `static` (provider's own preset,
   no LLM call) or `generate` (blocks playback).

`run()` and `ensureVoice()` are single-flight via `inFlight` / `voiceJobs` maps,
so the auto-run and the narration hook never issue duplicate calls.

### Failure policy

Soft everywhere. A director failure returns `null` and narration falls back to
the static preset; only user-initiated actions (`quiet: false`, the regenerate
button) surface a toast. Preserve that — a hard throw here breaks TTS entirely.

### Prompt rules

`parseInstructions()` strips `<think>` blocks and code fences, extracts the
first `[...]`, pads short arrays with the last usable line, and falls back to
using the model's first line for every paragraph. Keep it forgiving.

Instructions must describe **delivery only** — never age, gender, accent, or
timbre, which would fight the reference audio in the provider's voice-clone
mode. The voice-design prompt is the one place that *does* describe the voice.

## Known issues / gotchas

- **Prompts persist in settings, so editing the default in this file changes
  nothing for an existing install.** After any change to `DEFAULT_PROMPT` or
  `DEFAULT_VOICE_PROMPT`, click "Reset prompt" in the panel.
- **Reasoning models can still starve.** `generate()` floors the request at
  `max(setting, 600 + 80 × paragraphs)` and reports an empty completion
  separately from an unparseable one, both with the raw result logged. If empty
  completions persist, the answer is a non-reasoning connection profile — the
  task is a handful of one-line stage directions and thinking tokens buy little
  at roughly 4× the cost per call.
- **Erasing a message's audio needs provider v2.** `eraseClips()` calls
  `breezeTts.dropClips(texts, voice)`, which resolves clips through the
  IndexedDB `voiceText` index added in the provider's DB version 2. Clips cached
  before that upgrade carry no `voice`/`text` fields, stay out of the index, and
  can only be reclaimed by LRU eviction or a full clear. Against an older
  provider the button falls back to a confirmed full clear.
- Provider settings persist by assignment (`extension_settings.tts[name] =
  ttsProvider.settings`). Never write there from this extension; go through
  `breezeTts.addVoice` / `assignVoice`, which call `saveTtsProviderSettings()`
  and `await initVoiceMap()` in the right order.
- **`settings()` must keep filling in place.** It returns the *same* object every
  call precisely because `bind()` closes over it; rebuilding it with
  `Object.assign({}, DEFAULTS, ...)` orphans that closure and silently drops
  every panel edit, the connection profile included. This was the original bug
  behind "settings not persisting" — don't reintroduce it.
