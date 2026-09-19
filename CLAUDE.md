# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A SillyTavern third-party extension: **Breeze TTS, Director & Player**. One
`index.js` (~2900 lines, no build step, no dependencies beyond SillyTavern's own
`tts` extension) doing four things:

- **Provider** — registers `Breeze` in the TTS provider dropdown, wraps its raw
  24 kHz PCM in a WAV header, caches clips in IndexedDB keyed by content, and
  publishes `globalThis.breezeTts`.
- **Director** — one LLM call per message writes a delivery instruction for
  every paragraph, stored in the chat file.
- **Identification and casting** — a second call works out who speaks each
  quoted span; a third, per new speaker, gives them a base voice and a profile.
  Non-quote text reads in a configurable narrator voice.
- **Player** — an inline panel per message with paragraph-level seek,
  per-message resume, per-segment voice overrides, and take history.

There is no build or lint tooling beyond `tools/check.js`. The file is a plain
ES module loaded directly by the browser.

## One extension, two halves

The provider and the director speak only through two globals —
`globalThis.breezeTts` and `globalThis.breezeDirector` — even though they now
live in the same file. Keep that boundary:

- the provider must work with no director present, falling back to each voice's
  own static instruction whenever `breezeDirector` returns `null` or throws;
- the director must tolerate a provider that is absent or older, which is what
  `PROVIDER_FEATURES` and `basePreset()` guard.

**They used to be two extensions and drifted apart once too often.** The
provider lived outside version control and was copied into SillyTavern by hand,
so a freshly deployed director could be talking to a months-old provider. That
fails *silently*: an exception inside `castVoice()` lands in its `catch` and is
indistinguishable from the model declining, so casting quietly does nothing.
Shipping them together removes the failure mode; the globals keep the seam
legible.

`registerTtsProvider` throws if the name is already taken, which is exactly what
happens when the old standalone `breeze-tts` extension is still installed.
Unguarded, that aborts the whole file and the extension vanishes from the UI, so
the call is wrapped and the toast says what to disable.

The only path this file depends on is the import `../../tts/index.js`, which
resolves the same from any third-party folder, since they are all served from
`/scripts/extensions/third-party/<folder>/`. `loading_order` must stay above
SillyTavern's own `tts` extension.

## Install / iterate

Before deploying, check the file:

```
gjs tools/check.js index.js
```

It strips the `import` line (a `new Function()` body cannot hold one, so the
imported names are stubbed as globals), loads `index.js` under stubs for the
browser and SillyTavern globals, checks the provider registered, runs the
jQuery ready handler, asserts the pure logic against the file as loaded,
then drives `generate()` end to end against a stubbed model and provider. Those
last scenarios exist because the cast sheet can sit empty while attribution
works perfectly — a failure no unit test sees. They share global stubs, so they
run strictly in sequence. **Run it after every edit.** Anything that throws at module eval or
inside `bind()` aborts the rest of the file, so the extension disappears from
the UI entirely — no panel, no buttons, no listeners — with the only clue in the
browser console. A syntax check alone will not catch it: a missing top-level
`const` parses fine and throws at eval.

No build. Deploy by putting the folder where SillyTavern serves per-user
extensions, then hard-reload the browser:

```
SillyTavern/data/<handle>/extensions/<folder>/     # e.g. data/narpas/extensions/breeze-director/
```

Served to the page as `/scripts/extensions/third-party/<folder>/index.js`.

**Disable the old standalone `breeze-tts` extension** if it is still installed.
Both register the name `Breeze`; the one that loses says so in a toast.

Console checks while iterating:

```js
SillyTavern.getContext().extensionSettings.breeze_director   // settings actually persisted
SillyTavern.getContext().chat.at(-1).extra.breeze_direction  // the stored take + history
globalThis.breezeTts.available                               // provider bound?
globalThis.breezeTts.voiceForCharacter('Name')
await globalThis.breezeTts.cacheStats()
```

## Architecture

### Paragraphs direct; segments only pick a voice

Two levels of splitting, and the distinction is load-bearing:

- `buildUnits()` splits a message by `\n`, dropping empty lines — **exactly**
  what SillyTavern's TTS extension does when it builds narration jobs. This is
  the unit of *direction*, of panel rows, and of resume positions.
- `splitSegments()` splits one paragraph into quoted and unquoted spans, so each
  can take its own voice. It follows ST's `parseMessageSegments`
  (`tts/index.js:537`) — delimiters stripped, pieces trimmed, empties dropped —
  with one deliberate difference below.

An earlier design used segments for *direction* too, and was reverted because
one-sentence fragments made for poor stage directions — that history is in
`.bak`. Segments are back for voices only; every segment in a paragraph
inherits that paragraph's single instruction, so the arc survives.

### This chat is plaintext

`SEGMENT_PATTERN` is ST's regex **minus its `\*action\*` alternative**, because
messages here carry no asterisk markup. Only quoted speech changes speaker;
everything else is narration. Leaving that alternative in would let a stray pair
— `2 * 3 * 4`, a footnote marker — be read as markup and silently stripped out
of what gets spoken.

`normalize()` follows the same rule: it strips quote marks, straight and curly,
so a segment still matches the paragraph it came from, but leaves `*` and `_`
alone as content. Don't reintroduce markup stripping without a reason to.

### How a segment finds its instruction

Every segment of a paragraph is generated with that paragraph's single
instruction, so tone context is intact no matter how many voices a paragraph
uses. There are two ways it gets there:

- **With a hint** — the player knows exactly which message and paragraph it is
  playing, so `clipsFor()` attaches `{ messageId, paragraph }` to every clip and
  it rides through `getClip` → `_plan` → `breezeDirector`. Exact, and the only
  path the player uses.
- **Without one** — SillyTavern's own narration calls the provider with nothing
  but text, so `locate()` and `pickLine()` have to find the paragraph by
  matching. That is dependable for a whole paragraph, which is all ST ever
  sends.

Never rely on matching for a fragment. `locate()` scans the chat newest-first
for any message containing the text, and `pickLine()` falls back to the longest
paragraph containing it — a short quote like `"Yes."` can match the wrong
paragraph, or the wrong message. If a new caller generates sub-paragraph audio,
it must pass a hint.

**Caveat on the first rule.** ST only splits by line when
`extension_settings.tts.narrate_by_paragraphs` is on (`tts/index.js:274`). With
it off, ST enqueues the whole message as one job, `pickLine()` matches
paragraph 1, and the entire message is read with paragraph 1's instruction. The
settings panel warns when it is off. The player here does its own splitting and
is unaffected.

### Data model

`message.extra.breeze_direction`, saved into the chat file by `saveChat()`:

```js
{
  swipe_id, ts,
  lines: [{ text, instruction, segments? }],   // segments only when the paragraph needs them
  history: [{ ts, lines }],                    // capped at HISTORY_LIMIT = 5
}
```

`segments` is `[{ text, kind, speaker?, voice? }]` and is **omitted entirely**
when a paragraph is one plain narration span — the common case — so records stay
small and directions written before casting still load.

`voice` is pinned only for a *foreign* speaker. The character's own dialogue and
unattributed spans store no voice and resolve live through `voiceForSegment()`,
so editing the narrator setting or the TTS voice map keeps working on messages
already in the chat. A voice picked by hand in the panel pins the same field.

`getDirection()` returns `null` when `swipe_id` no longer matches, so swiping
silently invalidates a take rather than misapplying it. Text goes in the chat
(small, worth exporting); audio never does — the provider caches clips in
IndexedDB.

Player resume positions live in `extensionSettings.breeze_player.resume`, keyed
`"<chatId>:<messageId>"`, pruned past 200 entries. Resume stays
paragraph-granular even though playback is now segment-granular.

The speaker→voice cast lives in `breeze_director.cast` as
`{ [chatId]: { [speaker]: voice } }`, pruned past `CAST_CHAT_LIMIT` chats. It is
nested rather than flat-keyed because speaker names can contain a colon. A
speaker keeps one voice for a whole chat on purpose — re-picking per message
would make the same stranger sound like a different person every paragraph.

### Two settings keys, for history

Settings are split across `breeze_director` and `breeze_player` because these
were once separate extensions. Keep both keys — renaming drops users' configs.

### Flow

1. `CHARACTER_MESSAGE_RENDERED` → `prepare(index)`: generate direction, design a
   voice if the character has none, then prefetch every clip. Doing this before
   narration means **no LLM call happens during playback**.
2. The provider calls `globalThis.breezeDirector(text, …)` per line. It locates
   the message from the hint, or by matching text when there is none, awaits
   any in-flight precompute for that message rather than racing it, and returns
   `{ instruction, cfg_scale }`.
3. `on_missing` decides the no-direction case: `static` (provider's own preset,
   no LLM call) or `generate` (blocks playback).

`run()`, `ensureVoice()` and `castVoice()` are single-flight via `inFlight` /
`voiceJobs` / `castJobs`, so the auto-run and the narration hook never issue
duplicate calls, and two paragraphs naming the same stranger cannot race into
two different voices.

### Casting a quoted speaker

`castVoice()` is only ever called for a speaker `isForeignSpeaker()` accepts.
Resolution order, each step falling through on failure:

0. `rememberSpeaker()` — **before anything else**, the speaker is written onto
   the cast sheet with whatever profile identification gave. Everything below
   can fail; the entry stays, unvoiced, for the user to fill in. Skipping this
   is what once made the sheet look empty while attribution worked fine.
1. `entry.pinned` — set by any edit in the cast sheet, and it outranks even the
   voice map, because the edit was an explicit choice.
2. `breezeTts.voiceForCharacter(speaker)` — a hand-assigned voice-map entry
   otherwise beats the director. The entry records it with
   `source: 'voicemap'`, so the sheet still lists the speaker.
3. The chat's cast cache.
4. `askCasting()` answers with both a **base voice** and a **profile**, shown the
   speaker's card text, their own lines, the available voices and the running
   cast. This is the only call that describes a voice, and it runs once per
   speaker.
5. `applyCast()` writes a provider voice named after the speaker, via
   `castPreset()`: the base's `cfg_scale`, its `ref_audio_url`/`ref_text` when it
   has **both**, and `voiceInstruction()` as the instruction — falling back to
   the base's own instruction when the profile is empty, so a speaker with a
   base always sounds like something. Several characters may share a base — the
   profile is what tells them apart.
6. No base and nothing said about them → the entry stays on the sheet with no
   voice, and playback falls back to `voiceForSegment()`'s live resolution.

Non-quote text uses `defaultVoice()`: the configured `narrator_voice` if it
still exists in the provider's JSON, else the character's own voice. Leaving the
setting empty reproduces pre-casting behavior exactly.

`askCasting()` shows the model the chat's running cast through `{{cast}}` and
asks it to reuse a base when the speaker is someone already cast under another
name. That is what keeps a long scene consistent, so a saved casting prompt
without `{{cast}}` is a real regression — `bind()` warns until it is reset.

A cast entry is `{ voice, base }` plus the profile fields in `PROFILE_FIELDS`
(`gender`, `age`, `tone`, `accent`), each present only when filled.
`castEntry()` normalises the bare voice-name strings written before profiles
existed, so old chats keep working.

### Who speaks: its own call

`identifySpeakers()` attributes the quotes, in chunks of `identify_chunk`
paragraphs — `-1`, `0` or anything larger than the message means one call for
the whole thing, which gives the most context. Each chunk is told the message
character's card text, everyone named so far (earlier chunks plus the chat's
cast), and where in the message it sits.

It returns `{ speakers, profiles }`: `Q1 → name` for every quote, and for each
new speaker a `{ gender, age, tone, accent }` sketch, `cleanProfile()`-filtered
so blanks and `"unknown"` never reach the cast. Look profiles up with
`profileFor()`, never by direct index — the model files them under whatever
casing it likes, and a missed lookup silently loses the whole description.

This used to ride along on the director prompt. It was two jobs in one call with
too little context for either; the director prompt now only directs, and its
`{{quotes}}` placeholder is gone.

### Composing a voice instruction

`voiceInstruction(entry, cloned)` builds what Breeze is actually told. When the
base is a **clone** — `ref_audio_url` and `ref_text` both present — it emits the
tone alone. Identity words (gender, age, accent) would describe a voice the
reference audio has already fixed, and fight it. In design mode, with no
reference to contradict, the whole profile composes. The cast sheet prints the
result under each speaker, so an edit's effect is visible before you hear it.

### Prompts upgrade themselves now

`syncPrompts()` stamps each stored prompt with a hash of the default it came
from. On load, a stored prompt still matching its stamp was never edited and is
replaced with the current default; one that differs was customised and is left
alone. This is the fix for the old trap where changing a default here did
nothing for an existing install. A prompt stored *before* stamping exists has no
stamp, so it is left alone and warned about — reset it once and it starts
tracking.

### Seeing the cast

Three views, because a wrong voice is otherwise invisible until you hear it:

- The settings drawer lists the chat's cast, one row per speaker, with a voice
  dropdown and a forget button. It repaints live via `onCastChanged`, which
  `castVoice()` fires, and on `CHAT_CHANGED`. A voice since deleted from the
  provider's JSON still shows, marked `(missing)`.
- A paragraph using more than one voice shows chips naming them, collapsed or
  not, with the one currently on air bolded.
- The panel status line names the speaker and voice of the clip playing.

`castVoice()` toasts what it cast, matching `designVoice()`'s existing toast.

The sheet itself is `openCastSheet()`, opened from the wand menu's **Voice
cast** entry or the settings button. One row per speaker: base voice, gender,
age, accent, tone, the composed instruction, preview, re-base, forget. Its
toolbar has two chat-level actions:

- **Add speaker** pre-stages someone who has not spoken yet. A hand-added entry
  is `pinned`, so when the director eventually names them it reuses the entry
  as-is — no model call, no overwriting the tone you wrote. That is the whole
  point of pre-staging, and there is a scenario in `tools/check.js` for it.
- **Scan chat** runs `castMessage()` over the recent messages that contain
  quotes, newest first, bounded by `CAST_SCAN_LIMIT`. It confirms the cost
  first, because each message is at least one model call plus one per new voice.

`castMessage()` is the casting half of `generate()` on its own: identify, then
cast every foreign speaker. It deliberately never writes
`extra.breeze_direction` — scanning for speakers must not silently re-direct
messages you have already tuned. Edits apply immediately and re-derive the
speaker's provider voice **under its existing name**, so segments already stored
in the chat keep pointing at it. The settings panel only reports the count and
opens the sheet — one editor, not two.

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
  `DEFAULT_VOICE_PROMPT`, click "Reset prompt" in the panel. This now fails
  loudly rather than silently: a saved prompt without `{{quotes}}` can never
  return speaker attribution, so `bind()` shows a warning under the prompt box
  until it is reset, and `generate()` logs when attribution was expected but
  came back empty.
- **Every model call goes through `askModel()`.** Do not call
  `ConnectionManagerRequestService.sendRequest` directly. A reasoning model
  spends its budget thinking before it writes anything, so a request sized for
  the answer comes back empty — and empty is silent. `askModel()` floors every
  budget at the user's own `max_tokens`, never the caller's estimate of answer
  length, and warns distinctly when a completion is empty.

  This bug has now happened twice. It was fixed for the director call, then
  reintroduced the moment identification, base-picking and voice design were
  added with budgets of 400, 80 and 200 tokens. The base pick at 80 could never
  have answered. A scenario in `tools/check.js` records the budget of every call
  `generate()` makes and fails if any is below `max_tokens`.

  If empty completions persist even so, the answer is a non-reasoning connection
  profile: the work is short structured replies, and thinking tokens buy little
  at roughly 4× the cost per call.

- **Parse model JSON with `extractJson()`**, never by slicing first `{` to last
  `}`. Reasoning models muse in prose containing braces before emitting their
  JSON, which defeats the naive slice. `extractJson()` scans for the first
  balanced, string-aware, actually-parsing object. Quote ids likewise come back
  as `Q1`, `q1` or bare `1`; `normalizeQuoteId()` settles them.
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
