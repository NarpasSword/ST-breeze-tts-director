// SillyTavern/data/narpas/extensions/breeze-director/index.js
//
// Breeze Director & Player. Two halves of one extension:
//   Director - LLM-written per-paragraph delivery instructions, voice design
//              from character cards, and audio pre-generation.
//   Player   - paragraph-by-paragraph playback with seek and resume.
// Both share the narration-unit splitting below, which mirrors the TTS
// extension's own, so one unit here is exactly one generated clip.
//
// Settings live under two keys, breeze_director and breeze_player, so configs
// saved when these were separate extensions carry over unchanged.
//
// Requires: ../breeze-tts/index.js  (the provider, registers globalThis.breezeTts)

const MODULE = 'breeze_director';
const PLAYER_MODULE = 'breeze_player';

const DEFAULT_PROMPT = `You are directing a voice actor about to read the following message aloud.
It has been split into {{count}} numbered paragraphs, performed in order as one continuous reading.

For each paragraph, write ONE short sentence describing how to deliver it: tone, emotion, pace, energy.
Describe delivery only — never the speaker's age, gender, accent, or timbre.
Let the direction develop across the paragraphs so the reading has an arc.
Do not summarise or quote the text.

Reply with ONLY a JSON array of exactly {{count}} strings, no commentary, no code fences.

Character: {{char}}

Paragraphs:
{{parts}}`;

const DEFAULT_IDENTIFY_PROMPT = `Work out who speaks each line of quoted speech in this passage.
{{context}}
Passage:
{{parts}}

Quoted lines to attribute:
{{quotes}}

Name the speaker of each quote, exactly as the passage gives it. Use "{{char}}" when
{{char}} is speaking and "{{user}}" for {{user}}. Use "unknown" only when the passage
genuinely does not say.

Reply with ONLY a JSON object mapping each label to a name, no commentary, no code fences:
{"Q1": "name", "Q2": "name"}`;

const DEFAULT_VOICE_CAST_PROMPT = `Describe a character's voice, and choose an existing voice to build it on.

Character: {{speaker}}
{{context}}
Lines they speak:
{{lines}}

Available base voices:
{{voices}}
{{cast}}
Pick the closest base from the list. Several characters may share one, since your
description is what tells them apart. If this character is someone already cast under
a different name, reuse their base.

Then describe their voice: apparent gender, approximate age, the tone and manner of
their speech, and an accent only if there is a basis for one. Leave a field as ""
when there is no basis — do not invent.

Reply with ONLY a JSON object, no commentary, no code fences:
{"base": "<a voice name from the list>", "gender": "", "age": "", "tone": "", "accent": ""}`;

/** Spliced into the casting prompt at {{cast}} once anyone has been cast. */
const CAST_BLOCK = `
Already cast in this scene:
{{list}}
`;

const DEFAULT_VOICE_PROMPT = `Design a speaking voice for the character below.

Write ONE sentence describing the voice itself: apparent age, texture, pitch, accent if the
description implies one, and their default manner of speaking.
Describe the voice only — no plot, no backstory, no character name.
Output the sentence and nothing else.

Name: {{char}}

Description:
{{description}}`;

const DEFAULTS = {
    enabled: true,
    auto: true,
    auto_user: false,
    profile: '',
    max_tokens: 2000,
    cfg_scale: 4,
    mode: 'replace',      // replace | append
    on_missing: 'static', // static | generate
    prompt: DEFAULT_PROMPT,
    auto_voice: true,
    voice_prompt: DEFAULT_VOICE_PROMPT,
    prefetch: true,
    cast_enabled: true,
    narrator_voice: '',   // '' = the character's own voice
    voice_cast_prompt: DEFAULT_VOICE_CAST_PROMPT,
    identify_prompt: DEFAULT_IDENTIFY_PROMPT,
    identify_chunk: -1,   // paragraphs per identification call; -1 = whole message
    cast: {},             // chatId -> { speaker: { voice, base, tone } }
    prompt_stamps: {},    // key -> hash of the default it was written from
};

const CAST_CHAT_LIMIT = 50;

// How far back a cast scan will look. Each message with quotes in it costs at
// least one model call, so this is a spend ceiling as much as a search depth.
const CAST_SCAN_LIMIT = 20;

// Prompts live in settings, so shipping a new default used to change nothing for
// an existing install. Each stored prompt is stamped with a hash of the default
// it came from: if it still matches, nobody edited it and it upgrades silently.
// If it does not, the user customised it and it is left alone.
const SHIPPED_PROMPTS = {
    prompt: () => DEFAULT_PROMPT,
    voice_prompt: () => DEFAULT_VOICE_PROMPT,
    voice_cast_prompt: () => DEFAULT_VOICE_CAST_PROMPT,
    identify_prompt: () => DEFAULT_IDENTIFY_PROMPT,
};

function hash(text) {
    let h = 5381;
    for (let i = 0; i < String(text).length; i++) {
        h = ((h << 5) + h + String(text).charCodeAt(i)) | 0;
    }
    return String(h);
}

function syncPrompts(config) {
    config.prompt_stamps = config.prompt_stamps ?? {};
    for (const [key, shipped] of Object.entries(SHIPPED_PROMPTS)) {
        const current = shipped();
        const stored = config[key];
        if (stored === current) {
            config.prompt_stamps[key] = hash(current);
            continue;
        }
        // No stamp means it predates this mechanism: assume it may be custom.
        if (config.prompt_stamps[key] && config.prompt_stamps[key] === hash(stored)) {
            config[key] = current;
            config.prompt_stamps[key] = hash(current);
            console.info(`[Breeze Director] upgraded the unedited "${key}" to the new default.`);
        }
    }
}

const PLAYER_DEFAULTS = {
    autoplay_next: true,
    resume: {}, // "chatId:messageId" -> unit index
};

const HISTORY_LIMIT = 5;

const ctx = () => SillyTavern.getContext();
const inFlight = new Map();

/**
 * Fill missing keys in place and hand back the same object every time.
 * bind() closes over whatever this returns, so replacing the stored object
 * orphans that closure and silently discards every later panel edit.
 */
function fill(store, key, defaults) {
    const config = store[key] ?? (store[key] = {});
    for (const [name, value] of Object.entries(defaults)) {
        if (name in config) continue;
        // Clone containers, or every install shares one mutable default.
        config[name] = (value && typeof value === 'object' && !Array.isArray(value))
            ? { ...value }
            : value;
    }
    return config;
}

function settings() {
    const config = fill(ctx().extensionSettings, MODULE, DEFAULTS);
    syncPrompts(config);
    return config;
}

function playerSettings() {
    return fill(ctx().extensionSettings, PLAYER_MODULE, PLAYER_DEFAULTS);
}

/** Exactly how the TTS extension splits a message into narration jobs. */
function splitLines(mes) {
    return String(mes ?? '').split('\n').filter(line => line.length > 0);
}

/** A narration unit is one paragraph: exactly how TTS splits jobs by line. */
function buildUnits(mes) {
    return splitLines(mes).map(text => ({ text }));
}

// SillyTavern's parseMessageSegments (tts/index.js) minus its \*action\*
// alternative: this chat is plaintext, so an asterisk is an asterisk. Leaving
// that alternative in would let a stray pair — "2 * 3 * 4", a footnote marker —
// be read as markup and silently stripped out of what gets spoken.
// A paragraph stays the unit of direction; segments only decide who reads what.
const SEGMENT_PATTERN = /(".*?")|(\u201C.*?\u201D)|(\u00AB.*?\u00BB)|(\u300C.*?\u300D)|(\u300E.*?\u300F)|(\uFF02.*?\uFF02)/gim;

/**
 * Split one paragraph into spans that may each take their own voice, matching
 * ST's rules: delimiters stripped, pieces trimmed, empties dropped, and the
 * whole line kept when nothing matches. Only quoted speech changes speaker;
 * everything around it is narration.
 */
function splitSegments(line) {
    const segments = [];
    const regex = new RegExp(SEGMENT_PATTERN.source, 'gim');
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(line)) !== null) {
        if (match.index > lastIndex) {
            const before = line.slice(lastIndex, match.index).trim();
            if (before) segments.push({ text: before, kind: 'narration' });
        }
        // Every alternative left in the pattern is a quote form.
        const content = match[0].slice(1, -1).trim();
        if (content) segments.push({ text: content, kind: 'dialogue' });
        lastIndex = match.index + match[0].length;
    }

    if (lastIndex < line.length) {
        const rest = line.slice(lastIndex).trim();
        if (rest) segments.push({ text: rest, kind: 'narration' });
    }

    if (segments.length) return segments;
    const whole = line.trim();
    return whole ? [{ text: whole, kind: 'narration' }] : [];
}

/** Every quoted span in the message, numbered Q1..Qn for the director to attribute. */
function collectQuotes(layout) {
    const quotes = [];
    layout.forEach((segments, paragraph) => {
        segments.forEach((segment, at) => {
            if (segment.kind !== 'dialogue') return;
            quotes.push({ id: `Q${quotes.length + 1}`, paragraph, at, text: segment.text });
        });
    });
    return quotes;
}

const GENERIC_SPEAKERS = new Set(['', 'unknown', 'unclear', 'narrator', 'none', 'null', 'n/a']);

/** Is this quote spoken by someone other than the message's own character? */
function isForeignSpeaker(speaker, message) {
    const name = String(speaker ?? '').trim().toLowerCase();
    if (!name || GENERIC_SPEAKERS.has(name)) return false;
    return name !== String(message?.name ?? '').trim().toLowerCase();
}

// The provider is a separate extension, deployed separately, so it can be older
// than this one. These are the methods added after the first release: without
// them the feature they serve degrades, but nothing may throw — an exception
// here lands in castVoice's catch and looks exactly like "the model said no".
const PROVIDER_FEATURES = ['voicePreset', 'preview', 'dropClips'];

function missingProviderFeatures() {
    const breeze = globalThis.breezeTts;
    if (!breeze?.available) return [];
    return PROVIDER_FEATURES.filter(name => typeof breeze[name] !== 'function');
}

/** A base voice's preset, or null if this provider is too old to offer them. */
function basePreset(name) {
    const breeze = globalThis.breezeTts;
    if (!name || typeof breeze?.voicePreset !== 'function') return null;
    try {
        return breeze.voicePreset(name);
    } catch (error) {
        console.warn('[Breeze Director] could not read base voice', name, error);
        return null;
    }
}

/** The voice the character themselves narrates with, per the TTS voice map. */
function charVoice(message) {
    return globalThis.breezeTts?.voiceForCharacter(message?.name) ?? null;
}

/** The voice for non-quote text: the configured narrator, else the character's own. */
function defaultVoice(message) {
    const breeze = globalThis.breezeTts;
    const narrator = settings().narrator_voice;
    if (narrator && breeze?.hasVoice(narrator)) return narrator;
    return charVoice(message);
}

/**
 * Resolve a stored segment to a voice at play time. Only a foreign speaker has
 * a voice pinned into the chat; everything else resolves live, so editing the
 * narrator setting or the voice map keeps working on old messages.
 */
function voiceForSegment(segment, message) {
    if (segment?.kind !== 'dialogue') return defaultVoice(message);
    if (segment.voice && globalThis.breezeTts?.hasVoice(segment.voice)) return segment.voice;
    return charVoice(message) ?? defaultVoice(message);
}

/**
 * The clips one paragraph plays, in order. Each carries a hint naming the
 * message and paragraph it came from, so the director returns that paragraph's
 * instruction outright instead of matching a fragment back to it.
 */
function clipsFor(message, line, messageId, paragraph) {
    const hint = { messageId, paragraph };
    const segments = line?.segments;
    if (!segments?.length) {
        return [{ text: line?.text ?? '', voice: defaultVoice(message), speaker: null, hint }];
    }
    return segments.map(segment => ({
        text: segment.text,
        voice: voiceForSegment(segment, message),
        speaker: segment.kind === 'dialogue' ? (segment.speaker || null) : null,
        hint,
    }));
}

// Strips quote marks so a segment matches the paragraph it came from. Asterisks
// stay: in plaintext they are content, not markup.
const normalize = s => String(s ?? '').replace(/["'`\u201C\u201D\u00AB\u00BB]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Stored direction, but only if it still belongs to the current swipe. */
function getDirection(message) {
    const stored = message?.extra?.breeze_direction;
    if (!stored) return null;
    if ((stored.swipe_id ?? 0) !== (message.swipe_id ?? 0)) return null;
    return stored;
}

function hasDirection(index) {
    return !!getDirection(ctx().chat?.[index]);
}

// ---------------------------------------------------------------- generation

/**
 * Every model call goes through here.
 *
 * A reasoning model spends its budget thinking before it writes anything, so a
 * request sized for the answer alone comes back empty — this extension's
 * original bug, and it recurred the moment auxiliary calls were added with
 * budgets of 80 and 200 tokens. The floor is therefore the user's own
 * max_tokens, never the caller's estimate of how long the answer is.
 */
async function callModel(label, prompt, minTokens, roomy) {
    const config = settings();
    // Reasoning is billed against the same budget, so the retry buys thinking
    // room rather than a longer answer.
    const budget = Math.max(Number(config.max_tokens) || 0, minTokens) * (roomy ? 3 : 1);

    const result = await ctx().ConnectionManagerRequestService.sendRequest(
        config.profile, prompt, budget,
    );

    const clean = (value) => String(value ?? '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/```(?:json)?/gi, '')
        .trim();

    return { content: clean(result?.content), reasoning: clean(result?.reasoning), budget };
}

/** Plain text from the model, retried once with more room if it comes back empty. */
async function askModel(label, prompt, minTokens) {
    let reply = await callModel(label, prompt, minTokens);
    if (!reply.content) {
        console.warn(`[Breeze Director] ${label}: empty at budget ${reply.budget}, `
            + 'retrying with room to think.');
        reply = await callModel(label, prompt, minTokens, true);
    }
    if (!reply.content) {
        console.warn(`[Breeze Director] ${label}: still empty at budget ${reply.budget}. `
            + 'Raise Max response tokens, or use a non-reasoning connection profile.');
    }
    return reply.content;
}

/**
 * A JSON object from the model. Falls back to the reasoning channel, because a
 * model that runs out of room mid-thought has often already written the answer
 * there — and retries once with a larger budget before giving up.
 */
async function askJson(label, prompt, minTokens) {
    for (const roomy of [false, true]) {
        const reply = await callModel(label, prompt, minTokens, roomy);
        const parsed = extractJson(reply.content) ?? extractJson(reply.reasoning);
        if (parsed) return parsed;

        console.warn(`[Breeze Director] ${label}: no usable JSON at budget ${reply.budget}`
            + (roomy ? '. Giving up.' : ', retrying with room to think.'),
            reply.content || '(empty completion)');
    }
    return null;
}

/**
 * The first balanced {...} that parses. Scanning rather than taking the first
 * brace to the last matters for reasoning models, which like to muse in prose
 * containing braces before emitting the JSON.
 */
function extractJson(text) {
    for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
        let depth = 0;
        let inString = false;
        let escaped = false;

        for (let i = start; i < text.length; i++) {
            const ch = text[i];
            if (escaped) { escaped = false; continue; }
            if (ch === '\\') { escaped = true; continue; }
            if (ch === '"') { inString = !inString; continue; }
            if (inString) continue;
            if (ch === '{') depth++;
            else if (ch === '}' && --depth === 0) {
                try {
                    return JSON.parse(text.slice(start, i + 1));
                } catch { /* not this one; try the next opening brace */ }
                break;
            }
        }
    }
    return null;
}

/** Quote ids come back as Q1, q1 or plain 1 depending on the model's mood. */
function normalizeQuoteId(id) {
    const text = String(id ?? '').trim().toUpperCase();
    const digits = text.match(/^Q?(\d+)$/);
    return digits ? `Q${digits[1]}` : text;
}

/** Substitute without letting $& and friends in chat text be interpreted. */
function put(template, token, value) {
    return template.replace(token, () => value);
}

function buildPrompt(message, units) {
    const context = ctx();
    const parts = units.map((unit, i) => `${i + 1}. ${unit.text}`).join('\n\n');

    let prompt = put(settings().prompt, /{{parts}}/g, parts);
    prompt = put(prompt, /{{count}}/g, String(units.length));
    prompt = put(prompt, /{{message}}/g, String(message?.mes ?? ''));
    prompt = put(prompt, /{{char}}/g, String(message?.name ?? context.name2 ?? ''));
    prompt = put(prompt, /{{user}}/g, String(context.name1 ?? ''));
    return prompt;
}

/**
 * Read a completion into { instructions, speakers }. Three shapes are accepted,
 * because prompts persist in settings: the current object form, a bare array
 * from a pre-cast saved prompt, and anything else via the first-line fallback.
 */
function parseDirection(raw, count) {
    const text = String(raw ?? '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/```(?:json)?/gi, '')
        .trim();

    // Pad short replies with the last usable direction.
    const pad = (list) => {
        const clean = list.map(v => String(v ?? '').trim()).filter(Boolean);
        if (!clean.length) return null;
        while (clean.length < count) clean.push(clean[clean.length - 1]);
        return clean.slice(0, count);
    };

    const objectStart = text.indexOf('{');
    const objectEnd = text.lastIndexOf('}');
    if (objectStart !== -1 && objectEnd > objectStart) {
        try {
            const parsed = JSON.parse(text.slice(objectStart, objectEnd + 1));
            const instructions = Array.isArray(parsed?.directions) ? pad(parsed.directions) : null;
            if (instructions) {
                const speakers = {};
                for (const [id, name] of Object.entries(parsed?.speakers ?? {})) {
                    speakers[String(id).trim().toUpperCase()] = String(name ?? '').trim();
                }
                return { instructions, speakers };
            }
        } catch { /* fall through to the array form */ }
    }

    const arrayStart = text.indexOf('[');
    const arrayEnd = text.lastIndexOf(']');
    if (arrayStart !== -1 && arrayEnd > arrayStart) {
        try {
            const parsed = JSON.parse(text.slice(arrayStart, arrayEnd + 1));
            if (Array.isArray(parsed)) {
                const instructions = pad(parsed);
                if (instructions) return { instructions, speakers: {} };
            }
        } catch { /* fall through to the single-instruction path */ }
    }

    // Model ignored the format: use its first line as one direction for everything.
    const single = text.split('\n').map(l => l.trim()).filter(Boolean)[0];
    if (!single) return null;
    return {
        instructions: new Array(count).fill(single.replace(/^["\'`]|["\'`]$/g, '')),
        speakers: {},
    };
}

async function generate(index, { quiet = true } = {}) {
    const config = settings();
    const context = ctx();

    if (!config.profile) {
        if (!quiet) toastr.warning('Pick a connection profile first.', 'Breeze Director');
        return null;
    }

    const message = context.chat?.[index];
    if (!message) return null;

    const units = buildUnits(message.mes);
    if (!units.length) return null;

    const layout = units.map(unit => splitSegments(unit.text));
    const quotes = collectQuotes(layout);
    const attribute = config.cast_enabled && quotes.length > 0;

    // Who speaks gets its own call, or several: one job per prompt, and each
    // chunk knows who the ones before it named.
    const speakers = attribute ? await identifySpeakers(message, units, quotes) : {};

    const completion = await askModel('direction', buildPrompt(message, units), 600 + 80 * units.length);
    if (!completion) {
        if (!quiet) toastr.error('Model returned an empty completion.', 'Breeze Director');
        return null;
    }

    const parsed = parseDirection(completion, units.length);
    if (!parsed) {
        console.warn('[Breeze Director] could not parse a completion:', result?.content);
        if (!quiet) toastr.error('Model returned nothing usable.', 'Breeze Director');
        return null;
    }

    // askCasting quotes a speaker's own lines back at the model; tag them now.
    for (const quote of quotes) {
        quote.speaker = String(speakers[quote.id] ?? '').trim();
    }

    const lines = [];
    for (let i = 0; i < units.length; i++) {
        const line = { text: units[i].text, instruction: parsed.instructions[i] };
        const segments = layout[i];

        // One plain narration span is the common case: store nothing extra, so
        // records stay small and pre-casting directions keep loading unchanged.
        if (segments.length !== 1 || segments[0].kind !== 'narration') {
            line.segments = [];
            for (let at = 0; at < segments.length; at++) {
                const segment = segments[at];
                const entry = { text: segment.text, kind: segment.kind };

                if (segment.kind === 'dialogue') {
                    const quote = quotes.find(q => q.paragraph === i && q.at === at);
                    const speaker = String(speakers[quote?.id] ?? '').trim();
                    entry.speaker = speaker || null;
                    // Only a foreign speaker gets a voice pinned; the character's
                    // own lines resolve live so voice-map edits keep working.
                    if (isForeignSpeaker(speaker, message)) {
                        entry.voice = await castVoice(speaker, quotes);
                    }
                }
                line.segments.push(entry);
            }
        }
        lines.push(line);
    }

    // Keep the previous take so a regeneration you dislike can be undone.
    const previous = getDirection(message);
    const history = previous
        ? [{ ts: previous.ts ?? Date.now(), lines: previous.lines }, ...(previous.history ?? [])]
        : [];

    message.extra = message.extra ?? {};
    message.extra.breeze_direction = {
        swipe_id: message.swipe_id ?? 0,
        ts: Date.now(),
        lines,
        history: history.slice(0, HISTORY_LIMIT),
    };

    await context.saveChat();
    markButton(index);
    return message.extra.breeze_direction;
}

/** Single-flight per message, so auto-run and narration never duplicate a call. */
function run(index, options) {
    if (inFlight.has(index)) return inFlight.get(index);

    const pending = generate(index, options)
        .catch(error => {
            console.error('[Breeze Director] generation failed:', error);
            if (!options?.quiet) toastr.error(String(error?.message ?? error), 'Breeze Director');
            return null;
        })
        .finally(() => inFlight.delete(index));

    inFlight.set(index, pending);
    return pending;
}

// ---------------------------------------------------------------- the TTS hook

function locate(text) {
    const chat = ctx().chat ?? [];
    const needle = normalize(text).slice(0, 40);
    for (let i = chat.length - 1; i >= 0; i--) {
        if (needle && normalize(chat[i]?.mes).includes(needle)) return i;
    }
    return chat.length - 1;
}

/**
 * Which paragraph's instruction applies to this text. Only used when no hint
 * was passed — SillyTavern's own narration path, where the text is a whole
 * paragraph and matching is dependable.
 */
function pickLine(direction, text) {
    const needle = normalize(text);
    if (!needle) return direction.lines[0]?.instruction;

    const exact = direction.lines.find(l => normalize(l.text) === needle);
    if (exact) return exact.instruction;

    // A fragment can sit inside more than one paragraph; the longest container
    // is the least bad guess. Pass a hint and this never runs.
    let best = null;
    let bestLength = -1;
    for (const line of direction.lines) {
        const body = normalize(line.text);
        if (!body.includes(needle) && !needle.includes(body)) continue;
        if (body.length > bestLength) {
            best = line;
            bestLength = body.length;
        }
    }
    return (best ?? direction.lines[0])?.instruction;
}

globalThis.breezeDirector = async function (text, voiceId, preset, hint) {
    const config = settings();
    if (!config.enabled) return null;

    // A hint names the paragraph outright; locate() only guesses from the text.
    const index = Number.isInteger(hint?.messageId) ? hint.messageId : locate(text);
    const message = ctx().chat?.[index];
    if (!message) return null;

    // If a precompute is still running for this message, wait for it rather
    // than firing a second call or silently falling back.
    if (inFlight.has(index)) await inFlight.get(index);

    let direction = getDirection(message);
    if (!direction) {
        if (config.on_missing !== 'generate') return null;
        await run(index);
        direction = getDirection(message);
    }
    if (!direction) return null;

    const line = Number.isInteger(hint?.paragraph)
        ? direction.lines[hint.paragraph]?.instruction
        : pickLine(direction, text);
    if (!line) return null;

    const base = preset?.instruction;
    const instruction = (config.mode === 'append' && base) ? `${base} ${line}` : line;
    return { instruction, cfg_scale: Number(config.cfg_scale) };
};

// ------------------------------------------------------- voices and prefetch

const voiceJobs = new Map();

function cardFor(name) {
    const characters = ctx().characters ?? [];
    return characters.find(c => c.name === name) ?? null;
}

function slug(name) {
    const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return base || 'voice';
}

async function designVoice(name) {
    const config = settings();
    const context = ctx();
    const breeze = globalThis.breezeTts;

    const card = cardFor(name);
    const description = [card?.description, card?.personality, card?.scenario]
        .map(v => String(v ?? '').trim()).filter(Boolean).join('\n\n');

    if (!description) {
        console.info(`[Breeze Director] no card text for "${name}", skipping voice design.`);
        return null;
    }

    const prompt = config.voice_prompt
        .replace(/{{char}}/g, name)
        .replace(/{{description}}/g, description)
        .replace(/{{user}}/g, String(context.name1 ?? ''));

    const text = await askModel('voice design', prompt, 300);
    let line = text.split('\n').map(l => l.trim()).filter(Boolean)[0] ?? '';
    line = line.replace(/^["'`]|["'`]$/g, '').trim();
    if (!line) return null;

    let voiceName = slug(name);
    let suffix = 2;
    while (breeze.hasVoice(voiceName)) voiceName = `${slug(name)}-${suffix++}`;

    await breeze.addVoice(voiceName, { instruction: line, cfg_scale: Number(config.cfg_scale) });
    await breeze.assignVoice(name, voiceName);

    console.info(`[Breeze Director] designed voice "${voiceName}" for ${name}: ${line}`);
    toastr.success(`Designed a voice for ${name}.`, 'Breeze Director');
    return voiceName;
}

// -------------------------------------------------------------------- casting
// A speaker keeps one voice for a whole chat: re-picking per message would make
// the same stranger sound like a different person every paragraph.

const castJobs = new Map();

// Set by bind(), so the settings roster repaints as speakers are cast.
let onCastChanged = null;

function currentChatId() {
    return ctx().getCurrentChatId?.() ?? 'chat';
}

function castMap() {
    const config = settings();
    config.cast = config.cast ?? {};
    const id = currentChatId();
    config.cast[id] = config.cast[id] ?? {};
    return config.cast[id];
}

/** Keep the cast from accumulating every chat ever opened. */
function pruneCast() {
    const config = settings();
    const chats = Object.keys(config.cast ?? {});
    for (const stale of chats.slice(0, Math.max(0, chats.length - CAST_CHAT_LIMIT))) {
        delete config.cast[stale];
    }
}

// ------------------------------------------------------------- identification
// Who speaks each quote is its own question, with its own call. Asking the
// director to do it alongside the delivery direction gave it two jobs and not
// enough context for either.

const PROFILE_FIELDS = ['gender', 'age', 'tone', 'accent'];

function cleanProfile(raw) {
    const profile = {};
    for (const field of PROFILE_FIELDS) {
        const value = String(raw?.[field] ?? '').trim();
        if (value && value.toLowerCase() !== 'unknown') profile[field] = value;
    }
    return Object.keys(profile).length ? profile : null;
}

/** One identification call over paragraphs [from, to). */
async function askIdentify(message, units, from, to, quotes, known) {
    const config = settings();
    const context = ctx();

    const parts = units.slice(from, to)
        .map((unit, i) => `${from + i + 1}. ${unit.text}`)
        .join('\n\n');
    const list = quotes
        .map(q => `${q.id} (paragraph ${q.paragraph + 1}): ${q.text}`)
        .join('\n');

    // Context that actually helps: whose message this is, and who has already
    // been named — in this message's earlier chunks and in the chat's cast.
    const card = cardFor(message?.name);
    const description = [card?.description, card?.personality]
        .map(v => String(v ?? '').trim()).filter(Boolean).join('\n\n');

    const cast = castMap();
    const seen = [...new Set([...Object.keys(cast), ...Object.values(known)])]
        .filter(name => name && name.toLowerCase() !== 'unknown');

    const lines = [];
    if (description) lines.push(`About ${message?.name}:\n${description}`);
    if (seen.length) lines.push(`People already named in this scene: ${seen.join(', ')}`);
    if (from > 0) lines.push(`These are paragraphs ${from + 1}-${to} of a longer message.`);
    const contextBlock = lines.length ? `\n${lines.join('\n\n')}\n` : '';

    let prompt = put(config.identify_prompt, /{{context}}/g, contextBlock);
    prompt = put(prompt, /{{parts}}/g, parts);
    prompt = put(prompt, /{{quotes}}/g, list);
    prompt = put(prompt, /{{char}}/g, String(message?.name ?? context.name2 ?? ''));
    prompt = put(prompt, /{{user}}/g, String(context.name1 ?? ''));

    const parsed = await askJson('identification', prompt, 300 + 60 * quotes.length);
    if (!parsed) return null;

    // Accept either the flat map we ask for or a {speakers:{...}} wrapper.
    const source = (parsed.speakers && typeof parsed.speakers === 'object')
        ? parsed.speakers
        : parsed;

    const speakers = {};
    for (const [id, name] of Object.entries(source)) {
        const value = String(name ?? '').trim();
        if (value) speakers[normalizeQuoteId(id)] = value;
    }

    const missed = quotes.filter(q => !speakers[q.id]).length;
    console.info(`[Breeze Director] identified ${quotes.length - missed} of ${quotes.length} quotes`
        + (missed ? ` (${missed} unattributed)` : '') + '.');
    return speakers;
}

/**
 * Attribute every quote in the message, in chunks of `identify_chunk`
 * paragraphs. -1, 0 or anything larger than the message means one call for the
 * whole thing. Each chunk is told who earlier chunks already named.
 */
async function identifySpeakers(message, units, quotes) {
    const size = Number(settings().identify_chunk);
    const step = (!Number.isFinite(size) || size < 1) ? units.length : size;

    const speakers = {};
    for (let from = 0; from < units.length; from += step) {
        const to = Math.min(from + step, units.length);
        const slice = quotes.filter(q => q.paragraph >= from && q.paragraph < to);
        if (!slice.length) continue;

        Object.assign(speakers, await askIdentify(message, units, from, to, slice, speakers) ?? {});
    }
    return speakers;
}

/** Cast entries were bare voice names before base and profile existed. */
function castEntry(value) {
    if (!value) return null;
    if (typeof value === 'string') return { voice: value, base: null };
    return value;
}

/**
 * The Breeze instruction for a cast voice, composed from its profile.
 *
 * Identity — gender, age, accent — is dropped when the base is a clone, because
 * describing a voice that the reference audio already fixes only fights it.
 * Tone survives either way: it is manner, not timbre.
 */
function voiceInstruction(entry, cloned) {
    const parts = cloned
        ? [entry.tone]
        : [
            [entry.gender, entry.age].map(v => String(v ?? '').trim()).filter(Boolean).join(', '),
            entry.accent ? `${String(entry.accent).trim()} accent` : '',
            entry.tone,
        ];

    const sentence = parts
        .map(part => String(part ?? '').trim().replace(/\s*[.;,]+$/, ''))
        .filter(Boolean)
        .join('. ');
    return sentence ? `${sentence}.` : '';
}

/** Build the provider preset for a cast entry: base timbre, composed instruction. */
function castPreset(entry) {
    const inherited = basePreset(entry.base);
    // Clone mode needs both halves, so carry them together or not at all.
    const cloned = !!(inherited?.ref_audio_url && inherited?.ref_text);

    // With nothing said about them, fall back to the base's own instruction so
    // they at least sound like it, rather than like nothing at all.
    const preset = {
        instruction: voiceInstruction(entry, cloned) || String(inherited?.instruction ?? ''),
        cfg_scale: Number(inherited?.cfg_scale ?? settings().cfg_scale),
    };
    if (cloned) {
        preset.ref_audio_url = inherited.ref_audio_url;
        preset.ref_text = inherited.ref_text;
    }
    return preset;
}

/** A free voice name derived from the speaker's, not colliding with an existing one. */
function freeVoiceName(speaker) {
    const breeze = globalThis.breezeTts;
    const base = slug(speaker);
    let name = base;
    let suffix = 2;
    while (breeze.hasVoice(name)) name = `${base}-${suffix++}`;
    return name;
}

/**
 * Put a named speaker on the cast sheet, voiced or not. An entry with no voice
 * is the sheet's invitation to fill one in by hand, which is better than the
 * speaker vanishing because nothing could be derived for them automatically.
 */
function rememberSpeaker(speaker) {
    const cast = castMap();
    const entry = castEntry(cast[speaker]) ?? { voice: null, base: null };
    cast[speaker] = entry;
    pruneCast();
    return entry;
}

/** Write (or rewrite) the provider voice for a cast entry. */
async function applyCast(speaker, entry) {
    const breeze = globalThis.breezeTts;
    // Reuse the existing name so segments already stored keep pointing at it.
    const name = entry.voice && breeze.hasVoice(entry.voice) ? entry.voice : freeVoiceName(speaker);
    await breeze.addVoice(name, castPreset(entry));
    entry.voice = name;
    return name;
}

/** Ask the director for this speaker's voice: a base to build on, and a description. */
async function askCasting(speaker, quotes) {
    const config = settings();
    const breeze = globalThis.breezeTts;
    const available = breeze?.listVoices() ?? [];
    if (!config.profile || !available.length) return null;

    const spoken = quotes
        .filter(q => q.speaker === speaker)
        .slice(0, 6)
        .map(q => `- ${q.text}`)
        .join('\n');

    // Showing the running cast is what keeps a scene consistent: the model can
    // reuse a base for the same person under another name.
    const cast = castMap();
    const roster = Object.entries(cast)
        .filter(([who]) => who !== speaker)
        .map(([who, value]) => {
            const entry = castEntry(value);
            return `- ${who} → base ${entry.base ?? entry.voice}`;
        })
        .join('\n');

    const card = cardFor(speaker);
    const description = [card?.description, card?.personality]
        .map(v => String(v ?? '').trim()).filter(Boolean).join('\n\n');

    let prompt = put(config.voice_cast_prompt, /{{speaker}}/g, speaker);
    prompt = put(prompt, /{{context}}/g, description ? `\nWhat is known of them:\n${description}\n` : '');
    prompt = put(prompt, /{{lines}}/g, spoken || '(none recorded)');
    prompt = put(prompt, /{{voices}}/g, available.map(name => `- ${name}`).join('\n'));
    prompt = put(prompt, /{{cast}}/g, roster ? put(CAST_BLOCK, /{{list}}/g, roster) : '');

    const parsed = await askJson('casting', prompt, 400);
    if (!parsed) return null;

    // The model may quote the name or wrap it in a sentence; match generously.
    const wanted = String(parsed.base ?? '').trim().toLowerCase();
    const base = available.find(name => name.toLowerCase() === wanted)
        ?? available.find(name => wanted.includes(name.toLowerCase()))
        ?? null;

    return { base, profile: cleanProfile(parsed) };
}

/**
 * The voice a foreign speaker should use. Manual voice-map entries win, then
 * the chat's cast, then a freshly derived voice. Never throws: the caller falls
 * back to the default voice.
 */
async function castVoice(speaker, quotes = []) {
    const breeze = globalThis.breezeTts;
    if (!breeze?.available) return null;

    // Record them first: whatever happens next, they belong on the sheet.
    const entry = rememberSpeaker(speaker);
    const settle = (voice) => {
        ctx().saveSettingsDebounced();
        onCastChanged?.();
        return voice;
    };

    // An edit in the cast sheet pins the entry, and pinning outranks everything.
    if (entry.pinned && breeze.hasVoice(entry.voice)) return settle(entry.voice);

    // Otherwise a hand-assigned voice-map entry beats anything decided here —
    // but the speaker is still listed, with where the voice came from.
    const mapped = breeze.voiceForCharacter(speaker);
    if (mapped) {
        entry.voice = mapped;
        entry.source = 'voicemap';
        return settle(mapped);
    }

    if (entry.voice && breeze.hasVoice(entry.voice)) return settle(entry.voice);

    if (castJobs.has(speaker)) return castJobs.get(speaker);

    const pending = (async () => {
        const casting = await askCasting(speaker, quotes);
        if (casting?.base) entry.base = casting.base;
        for (const field of PROFILE_FIELDS) {
            if (!entry[field] && casting?.profile?.[field]) entry[field] = casting.profile[field];
        }

        // Nothing to build on: leave them unvoiced rather than dropping them.
        if (!entry.base && !voiceInstruction(entry, false)) return null;

        delete entry.source;
        await applyCast(speaker, entry);
        return entry.voice;
    })()
        .then(voice => {
            if (voice) {
                console.info(`[Breeze Director] cast ${speaker} as "${voice}"`
                    + (entry.base ? ` from base "${entry.base}"` : '') + '.');
                toastr.info(`Cast ${speaker} as "${voice}".`, 'Breeze Director');
            } else {
                console.info(`[Breeze Director] ${speaker} is on the cast sheet `
                    + 'with no voice yet — give them one there.');
            }
            return settle(voice);
        })
        .catch(error => {
            console.error('[Breeze Director] casting failed for', speaker, error);
            toastr.error(`Could not cast ${speaker}: ${error?.message ?? error}`, 'Breeze Director');
            return settle(null);
        })
        .finally(() => castJobs.delete(speaker));

    castJobs.set(speaker, pending);
    return pending;
}

/**
 * Identify and cast the speakers in one message, leaving its direction alone.
 * This is the casting half of generate(), for when that is all you want.
 */
async function castMessage(index) {
    const message = ctx().chat?.[index];
    if (!message) return [];

    const units = buildUnits(message.mes);
    const quotes = collectQuotes(units.map(unit => splitSegments(unit.text)));
    if (!quotes.length) return [];

    const speakers = await identifySpeakers(message, units, quotes);
    for (const quote of quotes) {
        quote.speaker = String(speakers[quote.id] ?? '').trim();
    }

    const cast = [];
    for (const quote of quotes) {
        if (!isForeignSpeaker(quote.speaker, message) || cast.includes(quote.speaker)) continue;
        cast.push(quote.speaker);
        await castVoice(quote.speaker, quotes);
    }
    return cast;
}

/** Messages with quoted speech in them, newest first. */
function quotedMessages(limit) {
    const chat = ctx().chat ?? [];
    const found = [];
    for (let i = chat.length - 1; i >= 0 && found.length < limit; i--) {
        const quotes = collectQuotes(buildUnits(chat[i]?.mes).map(unit => splitSegments(unit.text)));
        if (quotes.length) found.push(i);
    }
    return found;
}

/** Ensure the character has a voice, designing one from their card if not. */
async function ensureVoice(name) {
    const config = settings();
    const breeze = globalThis.breezeTts;
    if (!name || !breeze?.available || !config.profile) return null;

    const existing = breeze.voiceForCharacter(name);
    if (existing) return existing;
    if (!config.auto_voice) return null;

    if (voiceJobs.has(name)) return voiceJobs.get(name);

    const pending = designVoice(name)
        .catch(error => {
            console.error('[Breeze Director] voice design failed:', error);
            return null;
        })
        .finally(() => voiceJobs.delete(name));

    voiceJobs.set(name, pending);
    return pending;
}

/** Generate every clip for a message ahead of playback, sequentially. */
async function prefetchMessage(index) {
    const breeze = globalThis.breezeTts;
    const message = ctx().chat?.[index];
    if (!breeze?.available || !message) return;

    const direction = getDirection(message);
    const units = buildUnits(message.mes);

    for (let i = 0; i < units.length; i++) {
        for (const clip of clipsFor(message, direction?.lines?.[i] ?? units[i], index, i)) {
            if (clip.voice) await breeze.prefetch(clip.text, clip.voice, clip.hint);
        }
    }
}

/** Everything that should happen before narration starts. */
async function prepare(index) {
    const config = settings();
    if (!config.enabled) return;

    const message = ctx().chat?.[index];
    if (!message) return;

    if (config.auto && !hasDirection(index)) await run(index);
    await ensureVoice(message.name);
    if (config.prefetch) await prefetchMessage(index);
}

// ---------------------------------------------------------------- editor UI


const DIRECT_BUTTON_HTML = '<div title="Voice direction" class="mes_button mes_breeze_direct fa-solid fa-masks-theater"></div>';
const PLAY_BUTTON_HTML = '<div title="Narration player" class="mes_button mes_breeze_play fa-solid fa-headphones"></div>';

function markButton(index) {
    $(`#chat .mes[mesid="${index}"] .mes_breeze_direct`).css('opacity', hasDirection(index) ? '1' : '');
}

function addButtons() {
    const inject = (host) => {
        if (!host.find('.mes_breeze_play').length) host.prepend(PLAY_BUTTON_HTML);
        if (!host.find('.mes_breeze_direct').length) host.prepend(DIRECT_BUTTON_HTML);
    };

    inject($('#message_template .extraMesButtons'));
    $('#chat .mes .extraMesButtons').each(function () { inject($(this)); });
    $('#chat .mes').each(function () { markButton(Number($(this).attr('mesid'))); });
}

// ------------------------------------------------------------------- position

function positionKey(messageId) {
    return `${ctx().getCurrentChatId?.() ?? 'chat'}:${messageId}`;
}

function savePosition(messageId, index) {
    const config = playerSettings();
    config.resume[positionKey(messageId)] = index;

    // Keep the map from growing without bound.
    const keys = Object.keys(config.resume);
    if (keys.length > 200) delete config.resume[keys[0]];

    ctx().saveSettingsDebounced();
}

function loadPosition(messageId) {
    return playerSettings().resume[positionKey(messageId)] ?? 0;
}

function clearPosition(messageId) {
    delete playerSettings().resume[positionKey(messageId)];
    ctx().saveSettingsDebounced();
}

// --------------------------------------------------------------------- player

const player = {
    audio: new Audio(),
    units: [],        // paragraphs; each holds the clips it plays in order
    index: 0,         // paragraph
    clipIndex: 0,     // segment within the paragraph
    messageId: null,
    url: null,
    onChange: null,
    loadToken: 0,

    async load(messageId) {
        const message = ctx().chat?.[messageId];
        if (!message) throw new Error('Message not found.');

        const breeze = globalThis.breezeTts;
        if (!breeze?.available) throw new Error('Select the Breeze TTS provider first.');

        if (!defaultVoice(message)) {
            throw new Error(`No Breeze voice assigned to ${message.name}, and no narrator voice set.`);
        }

        this.stop();
        this.messageId = messageId;

        // Paragraph-granular units keep resume keys and panel rows unchanged;
        // the voice switching lives inside each unit's clip list.
        const direction = getDirection(message);
        this.units = buildUnits(message.mes).map((unit, i) => ({
            text: unit.text,
            clips: clipsFor(message, direction?.lines?.[i] ?? unit, messageId, i).filter(c => c.voice),
        }));

        this.index = Math.min(loadPosition(messageId), Math.max(this.units.length - 1, 0));
        this.clipIndex = 0;
        return this.units;
    },

    async playAt(index, clipIndex = 0) {
        if (index < 0 || index >= this.units.length) return this.stop();

        const clips = this.units[index].clips;
        if (clipIndex >= clips.length) return this.playAt(index + 1);

        this.index = index;
        this.clipIndex = clipIndex;
        // Resume is paragraph-granular: only record on entering one.
        if (clipIndex === 0) savePosition(this.messageId, index);
        this.notify('loading');

        // Ignore results from any earlier play that is still resolving.
        const token = ++this.loadToken;
        let clip;
        try {
            const wanted = clips[clipIndex];
            clip = await globalThis.breezeTts.getClip(wanted.text, wanted.voice, wanted.hint);
        } catch (error) {
            toastr.error(String(error?.message ?? error), 'Breeze Player');
            return this.notify('error');
        }
        if (token !== this.loadToken) return;

        this.revoke();
        this.url = URL.createObjectURL(clip);
        this.audio.src = this.url;
        this.audio.playbackRate = Number(ctx().extensionSettings?.tts?.playback_rate ?? 1);
        await this.audio.play().catch(() => { });
        this.notify('playing');

        // Warm whatever comes next: the rest of this paragraph, then the next.
        const next = clips[clipIndex + 1] ?? this.units[index + 1]?.clips?.[0];
        if (next) globalThis.breezeTts.prefetch(next.text, next.voice, next.hint);
    },

    next() { return this.playAt(this.index + 1); },
    prev() { return this.playAt(this.index - 1); },

    toggle() {
        if (this.audio.paused) {
            if (!this.audio.src) return this.playAt(this.index, this.clipIndex);
            this.audio.play().catch(() => { });
            this.notify('playing');
        } else {
            this.audio.pause();
            this.notify('paused');
        }
    },

    stop() {
        this.loadToken++;
        this.clipIndex = 0;
        this.audio.pause();
        this.audio.removeAttribute('src');
        this.revoke();
        this.notify('stopped');
    },

    revoke() {
        if (this.url) URL.revokeObjectURL(this.url);
        this.url = null;
    },

    notify(state) {
        // index only: the panel reads clipIndex off the player for the rest.
        if (typeof this.onChange === 'function') this.onChange(state, this.index);
    },
};

player.audio.addEventListener('ended', () => {
    // Mid-paragraph the reading always continues; autoplay only governs whether
    // playback carries on across a paragraph break.
    const clips = player.units[player.index]?.clips ?? [];
    if (player.clipIndex + 1 < clips.length) {
        return player.playAt(player.index, player.clipIndex + 1);
    }

    if (!playerSettings().autoplay_next) return player.notify('paused');
    if (player.index + 1 < player.units.length) {
        player.playAt(player.index + 1);
    } else {
        clearPosition(player.messageId);
        player.notify('finished');
    }
});

// ------------------------------------------------------------------------- UI
// ------------------------------------------------------------- inline panel
// One panel per message, rendered into the message block itself rather than a
// popup, so the chat stays visible and playback can highlight as it goes.

const panels = new Map(); // messageId -> { root, rows, repaint, refreshTakes }

function panelHost(messageId) {
    const block = $(`#chat .mes[mesid="${messageId}"] .mes_block`);
    return block.length ? block : null;
}

function closePanel(messageId) {
    panels.get(messageId)?.root.remove();
    panels.delete(messageId);
}

function closeAllPanels() {
    [...panels.keys()].forEach(closePanel);
}

function button(icon, title, handler, label) {
    const element = document.createElement('div');
    element.className = label ? 'menu_button' : `menu_button fa-solid ${icon}`;
    if (label) element.textContent = label;
    element.title = title;
    element.style.flex = '0 0 auto';
    element.addEventListener('click', handler);
    return element;
}

/** Bytes as MB or KB, whichever reads better. */
function size(bytes) {
    return bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

function stamp(ts) {
    if (!ts) return 'earlier take';
    const date = new Date(ts);
    return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/** Who reads each span of a paragraph, with a per-segment voice override. */
function castRows(message, segments, editable) {
    const box = document.createElement('div');
    box.style.cssText = 'margin-top:0.35em;display:flex;flex-direction:column;gap:0.25em;';
    const available = globalThis.breezeTts?.listVoices?.() ?? [];

    for (const segment of segments) {
        const line = document.createElement('div');
        line.style.cssText = 'display:flex;gap:0.4em;align-items:center;'
            + 'font-size:calc(var(--mainFontSize) * 0.9);';

        const who = document.createElement('span');
        who.style.cssText = 'opacity:0.7;flex:0 0 auto;';
        who.textContent = segment.kind === 'dialogue' ? (segment.speaker || 'unattributed') : 'narration';

        const text = document.createElement('span');
        text.style.cssText = 'flex:1;min-width:0;opacity:0.55;'
            + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        text.textContent = segment.text;

        const select = document.createElement('select');
        select.className = 'text_pole';
        select.style.cssText = 'flex:0 0 auto;width:auto;';

        // "auto" spells out what would play, so an override is an informed choice.
        const auto = document.createElement('option');
        auto.value = '';
        auto.textContent = `auto (${voiceForSegment({ ...segment, voice: null }, message) ?? 'none'})`;
        select.append(auto);
        for (const name of available) {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            select.append(option);
        }

        select.value = segment.voice ?? '';
        select.disabled = !editable;
        select.addEventListener('change', async () => {
            if (select.value) segment.voice = select.value;
            else delete segment.voice;
            await ctx().saveChat();
        });

        line.append(who, text, select);
        box.append(line);
    }
    return box;
}

async function openPanel(messageId, { play = false, expandAll = false } = {}) {
    const context = ctx();
    const message = context.chat?.[messageId];
    const host = panelHost(messageId);
    if (!message || !host) return;

    if (panels.has(messageId) && !play) return closePanel(messageId);
    if (!panels.has(messageId)) closeAllPanels();

    let direction = getDirection(message);
    let viewing = 0; // 0 = current take, 1..n = history

    const root = document.createElement('div');
    root.className = 'breeze-panel';
    root.style.cssText = 'margin-top:0.6em;padding:0.6em;border:1px solid var(--white20a);border-radius:6px;';

    // --- toolbar --------------------------------------------------------
    const bar = document.createElement('div');
    bar.className = 'flex-container';
    bar.style.cssText = 'gap:0.35em;align-items:center;flex-wrap:wrap;margin-bottom:0.5em;';

    const takes = document.createElement('select');
    takes.className = 'text_pole';
    takes.style.cssText = 'flex:1 1 12em;min-width:8em;';

    const playButton = button('fa-play', 'Play / pause', () => togglePlayback(messageId));
    const prevButton = button('fa-backward-step', 'Previous paragraph', () => player.prev());
    const nextButton = button('fa-forward-step', 'Next paragraph', () => player.next());
    const stopButton = button('fa-stop', 'Stop', () => player.stop());
    const regenButton = button('fa-rotate', 'Generate a new take', () => regenerate(messageId));
    const expandButton = button('fa-chevron-down', 'Expand or collapse every paragraph', () => toggleAll(messageId));
    const eraseButton = button('fa-trash', 'Erase cached audio for this message', () => eraseClips(messageId));

    bar.append(playButton, prevButton, nextButton, stopButton, regenButton, expandButton, takes, eraseButton);
    root.append(bar);

    const status = document.createElement('small');
    status.style.cssText = 'opacity:0.7;display:block;margin-bottom:0.4em;';
    root.append(status);

    const list = document.createElement('div');
    root.append(list);

    host.append(root);

    // --- painting -------------------------------------------------------
    let rows = [];
    const expanded = new Set(expandAll ? buildUnits(message.mes).map((_, i) => i) : []);

    const takeLines = () => (viewing === 0 ? direction?.lines : direction?.history?.[viewing - 1]?.lines) ?? [];

    function refreshTakes() {
        takes.innerHTML = '';
        if (!direction) {
            const option = document.createElement('option');
            option.textContent = 'No direction yet';
            takes.append(option);
            takes.disabled = true;
            return;
        }
        takes.disabled = false;
        const current = document.createElement('option');
        current.value = '0';
        current.textContent = `Current — ${stamp(direction.ts)}`;
        takes.append(current);
        (direction.history ?? []).forEach((take, i) => {
            const option = document.createElement('option');
            option.value = String(i + 1);
            option.textContent = `Take ${direction.history.length - i} — ${stamp(take.ts)}`;
            takes.append(option);
        });
        takes.value = String(viewing);
    }

    function repaint(state = 'ready', playingIndex = -1) {
        const units = buildUnits(message.mes);
        const lines = takeLines();
        const editable = viewing === 0;

        // The exact clip on air, so the panel can name the voice reading it.
        const active = playingIndex >= 0 && player.messageId === messageId
            ? player.units[playingIndex]?.clips?.[player.clipIndex] ?? null
            : null;
        const who = active?.voice ? ` — ${active.speaker ?? 'narration'} in "${active.voice}"` : '';

        list.innerHTML = '';
        rows = units.map((unit, i) => {
            const row = document.createElement('div');
            row.style.cssText = 'border-top:1px solid var(--white20a);padding:0.35em 0;';

            const headRow = document.createElement('div');
            headRow.style.cssText = 'display:flex;gap:0.4em;align-items:flex-start;cursor:pointer;';

            const chevron = document.createElement('div');
            chevron.className = `fa-solid ${expanded.has(i) ? 'fa-chevron-down' : 'fa-chevron-right'}`;
            chevron.style.cssText = 'opacity:0.6;padding-top:0.25em;min-width:1em;';

            const text = document.createElement('div');
            text.style.cssText = 'flex:1;min-width:0;';
            text.textContent = unit.text;
            if (!expanded.has(i)) {
                text.style.cssText += 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
            }
            if (i === playingIndex) text.style.fontWeight = 'bold';

            const playOne = document.createElement('div');
            playOne.className = 'fa-solid fa-play';
            playOne.title = 'Play from here';
            playOne.style.cssText = 'opacity:0.6;padding-top:0.25em;cursor:pointer;';
            playOne.addEventListener('click', event => {
                event.stopPropagation();
                playFrom(messageId, i);
            });

            headRow.append(chevron, text, playOne);
            headRow.addEventListener('click', () => {
                expanded.has(i) ? expanded.delete(i) : expanded.add(i);
                repaint(state, playingIndex);
            });
            row.append(headRow);

            // Chips make a multi-voice paragraph visible without expanding it.
            const voices = [...new Set((lines[i]?.segments ?? [])
                .map(segment => voiceForSegment(segment, message))
                .filter(Boolean))];
            if (voices.length > 1) {
                const chips = document.createElement('div');
                chips.style.cssText = 'display:flex;gap:0.3em;flex-wrap:wrap;margin:0.2em 0 0 1.4em;'
                    + 'font-size:calc(var(--mainFontSize) * 0.85);';
                for (const name of voices) {
                    const chip = document.createElement('span');
                    const live = i === playingIndex && name === active?.voice;
                    chip.style.cssText = 'border:1px solid var(--white20a);border-radius:4px;'
                        + `padding:0 0.35em;opacity:${live ? '1' : '0.55'};`
                        + (live ? 'font-weight:bold;' : '');
                    chip.textContent = name;
                    chips.append(chip);
                }
                row.append(chips);
            }

            let input = null;
            if (expanded.has(i)) {
                input = document.createElement('textarea');
                input.className = 'text_pole textarea_compact';
                input.rows = 2;
                input.style.marginTop = '0.3em';
                input.placeholder = direction ? 'No instruction for this paragraph' : 'Generate a take first';
                input.value = lines[i]?.instruction ?? '';
                input.readOnly = !editable || !direction;
                input.addEventListener('change', async () => {
                    if (!editable || !direction) return;
                    if (direction.lines[i]) direction.lines[i].instruction = input.value.trim();
                    message.extra.breeze_direction = direction;
                    await ctx().saveChat();
                });
                row.append(input);

                const segments = lines[i]?.segments ?? [];
                if (segments.length) row.append(castRows(message, segments, editable));
            }

            if (i === playingIndex) row.style.background = 'var(--white20a)';
            list.append(row);
            return { row, input };
        });

        if (viewing !== 0) {
            const restore = button(null, 'Make this the current take', () => restoreTake(messageId), 'Restore this take');
            restore.style.marginTop = '0.5em';
            list.append(restore);
        }

        playButton.classList.toggle('fa-play', state !== 'playing');
        playButton.classList.toggle('fa-pause', state === 'playing');
        status.textContent = !direction
            ? 'No direction yet — press the rotate button to generate one.'
            : state === 'loading'
                ? `Generating audio for paragraph ${playingIndex + 1}…${who}`
                : playingIndex >= 0
                    ? `Paragraph ${playingIndex + 1} of ${units.length} — ${state}${who}`
                    : `${units.length} paragraphs`;
    }

    takes.addEventListener('change', () => {
        viewing = Number(takes.value);
        repaint();
    });

    const entry = {
        root,
        repaint,
        refreshTakes,
        get direction() { return direction; },
        set direction(value) { direction = value; },
        get viewing() { return viewing; },
        set viewing(value) { viewing = value; },
        expanded,
    };
    panels.set(messageId, entry);

    refreshTakes();
    repaint();

    if (play) await playFrom(messageId, loadPosition(messageId));
}

async function regenerate(messageId) {
    const entry = panels.get(messageId);
    if (!entry) return;

    const icon = entry.root.querySelector('.fa-rotate');
    icon?.classList.add('fa-spin');
    try {
        const fresh = await generate(messageId, { quiet: false });
        if (fresh) {
            entry.direction = fresh;
            entry.viewing = 0;
            entry.refreshTakes();
            entry.repaint();
        }
    } catch (error) {
        // Surfaced rather than swallowed: a silent no-op looks like a broken button.
        console.error('[Breeze Director] regenerate failed:', error);
        toastr.error(String(error?.message ?? error), 'Breeze Director');
    } finally {
        icon?.classList.remove('fa-spin');
    }
}

function restoreTake(messageId) {
    const entry = panels.get(messageId);
    const message = ctx().chat?.[messageId];
    const direction = entry?.direction;
    if (!entry || !direction || entry.viewing === 0) return;

    const chosen = direction.history.splice(entry.viewing - 1, 1)[0];
    direction.history.unshift({ ts: direction.ts ?? Date.now(), lines: direction.lines });
    direction.lines = chosen.lines;
    direction.ts = chosen.ts ?? Date.now();
    direction.history = direction.history.slice(0, HISTORY_LIMIT);

    message.extra.breeze_direction = direction;
    ctx().saveChat();

    entry.viewing = 0;
    entry.refreshTakes();
    entry.repaint();
}

function toggleAll(messageId) {
    const entry = panels.get(messageId);
    const message = ctx().chat?.[messageId];
    if (!entry || !message) return;

    const total = buildUnits(message.mes).length;
    if (entry.expanded.size >= total) entry.expanded.clear();
    else for (let i = 0; i < total; i++) entry.expanded.add(i);
    entry.repaint();
}

async function eraseClips(messageId) {
    const message = ctx().chat?.[messageId];
    const breeze = globalThis.breezeTts;
    if (!message || !breeze?.available) return;

    // A message can now span several voices, and clips are keyed per voice.
    const direction = getDirection(message);
    const units = buildUnits(message.mes);
    const byVoice = new Map();
    units.forEach((unit, i) => {
        for (const clip of clipsFor(message, direction?.lines?.[i] ?? unit, messageId, i)) {
            if (!clip.voice) continue;
            if (!byVoice.has(clip.voice)) byVoice.set(clip.voice, []);
            byVoice.get(clip.voice).push(clip.text);
        }
    });

    if (!byVoice.size) {
        return toastr.info(`No Breeze voice assigned to ${message.name}.`, 'Breeze');
    }

    // Older providers only offer an all-or-nothing clear; say so rather than
    // quietly wiping every other message's audio too.
    if (typeof breeze.dropClips !== 'function') {
        const context = ctx();
        const confirmed = await context.callGenericPopup(
            'This build of the Breeze provider can only clear the whole clip cache, '
            + 'not just this message. Clear everything?',
            context.POPUP_TYPE.CONFIRM,
        );
        if (!confirmed) return;
        const before = await breeze.cacheStats();
        await breeze.clearCache();
        return toastr.success(`Cleared ${before.count} clips (${size(before.bytes)}).`, 'Breeze');
    }

    let count = 0;
    let bytes = 0;
    for (const [voice, texts] of byVoice) {
        const dropped = await breeze.dropClips(texts, voice);
        count += dropped.count;
        bytes += dropped.bytes;
    }

    toastr.success(
        count ? `Erased ${count} clips (${size(bytes)}) for this message.` : 'Nothing cached for this message.',
        'Breeze',
    );
}

async function playFrom(messageId, index) {
    try {
        await player.load(messageId);
    } catch (error) {
        toastr.warning(String(error?.message ?? error), 'Breeze Player');
        return;
    }

    player.onChange = (state, at) => panels.get(messageId)?.repaint(state, at);
    await player.playAt(index);
}

function togglePlayback(messageId) {
    if (player.messageId === messageId && player.audio.src) return player.toggle();
    return playFrom(messageId, loadPosition(messageId));
}

function resumeLatest() {
    const config = playerSettings();
    const chatId = ctx().getCurrentChatId?.() ?? 'chat';
    const prefix = `${chatId}:`;

    const candidates = Object.keys(config.resume)
        .filter(key => key.startsWith(prefix))
        .map(key => Number(key.slice(prefix.length)))
        .filter(Number.isInteger);

    if (!candidates.length) {
        toastr.info('Nothing to resume in this chat.', 'Breeze Player');
        return;
    }
    openPanel(Math.max(...candidates), { play: true });
}
// ------------------------------------------------------------------ cast sheet
// One row per speaker the director has cast in this chat: the base voice it
// built them from, and the tone description that separates them from it.
// Edits apply immediately — there is no save button to forget to press.

async function openCastSheet() {
    const context = ctx();
    const breeze = globalThis.breezeTts;
    if (!breeze?.available) {
        return toastr.warning('Select the Breeze TTS provider first.', 'Breeze Director');
    }

    const cast = castMap();
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'text-align:left;';

    const heading = document.createElement('h3');
    heading.textContent = 'Voice cast';
    const note = document.createElement('small');
    note.style.cssText = 'display:block;opacity:0.7;margin-bottom:0.6em;';
    note.textContent = 'Each speaker gets a base voice for timbre and a tone description '
        + 'of their own. Changes are saved as you make them.';
    wrapper.append(heading, note);

    // --- toolbar --------------------------------------------------------
    const bar = document.createElement('div');
    bar.className = 'flex-container';
    bar.style.cssText = 'gap:0.4em;align-items:center;flex-wrap:wrap;margin-bottom:0.6em;';

    const addButton = button(null, 'Add a speaker by hand', () => addSpeaker(), 'Add speaker');
    const scanButton = button(null, 'Find speakers in recent messages', () => scanChat(), 'Scan chat');
    const progress = document.createElement('small');
    progress.style.cssText = 'opacity:0.7;flex:1 1 auto;';

    bar.append(addButton, scanButton, progress);
    wrapper.append(bar);

    const list = document.createElement('div');
    wrapper.append(list);

    /**
     * Pre-stage someone who has not spoken yet. Added by hand means chosen
     * deliberately, so the entry is pinned: nothing later overrides it.
     */
    async function addSpeaker() {
        const name = await context.callGenericPopup(
            'Name of the speaker to add:', context.POPUP_TYPE.INPUT, '',
        );
        const speaker = String(name ?? '').trim();
        if (!speaker) return;
        if (cast[speaker]) return toastr.info(`${speaker} is already cast.`, 'Breeze Director');

        cast[speaker] = { voice: null, base: null, pinned: true };
        context.saveSettingsDebounced();
        onCastChanged?.();
        paint();
    }

    /** Run the casting half of the director over recent messages. */
    async function scanChat() {
        if (!settings().profile) {
            return toastr.warning('Pick a connection profile first.', 'Breeze Director');
        }

        const targets = quotedMessages(CAST_SCAN_LIMIT);
        if (!targets.length) {
            return toastr.info('No quoted speech in this chat yet.', 'Breeze Director');
        }

        const confirmed = await context.callGenericPopup(
            `Scan ${targets.length} message${targets.length === 1 ? '' : 's'} for speakers? `
            + `That is at least ${targets.length} model calls, plus one for each new voice.`,
            context.POPUP_TYPE.CONFIRM,
        );
        if (!confirmed) return;

        scanButton.classList.add('disabled');
        const named = new Set();
        try {
            for (let i = 0; i < targets.length; i++) {
                progress.textContent = `Scanning message ${i + 1} of ${targets.length}…`;
                for (const speaker of await castMessage(targets[i])) named.add(speaker);
                paint();
            }
            progress.textContent = named.size
                ? `Found ${[...named].join(', ')}.`
                : 'No new speakers found.';
        } catch (error) {
            console.error('[Breeze Director] cast scan failed:', error);
            progress.textContent = 'Scan failed — see the console.';
        } finally {
            scanButton.classList.remove('disabled');
        }
    }

    function paint() {
        const available = breeze.listVoices();
        const speakers = Object.keys(cast).sort();

        list.innerHTML = '';
        if (!speakers.length) {
            const empty = document.createElement('small');
            empty.style.opacity = '0.6';
            empty.textContent = 'Nobody cast yet. Speakers appear here as the director names them.';
            list.append(empty);
            return;
        }

        for (const speaker of speakers) {
            const entry = castEntry(cast[speaker]);
            const row = document.createElement('div');
            row.style.cssText = 'border-top:1px solid var(--white20a);padding:0.6em 0;';

            const head = document.createElement('div');
            head.style.cssText = 'display:flex;gap:0.4em;align-items:center;flex-wrap:wrap;';

            const who = document.createElement('b');
            who.style.cssText = 'flex:1 1 8em;min-width:0;';
            who.textContent = speaker;

            const voiced = !!entry.voice && breeze.hasVoice(entry.voice);
            const voice = document.createElement('small');
            voice.style.cssText = 'opacity:0.6;flex:0 0 auto;';
            voice.textContent = voiced
                ? (entry.source === 'voicemap' ? `${entry.voice} (from voice map)` : entry.voice)
                : (entry.voice ? `${entry.voice} (missing)` : 'no voice yet');

            head.append(who, voice);

            // Base voice: timbre this character was built from.
            const baseSelect = document.createElement('select');
            baseSelect.className = 'text_pole';
            baseSelect.style.cssText = 'flex:0 0 auto;width:auto;';
            const none = document.createElement('option');
            none.value = '';
            none.textContent = '— no base —';
            baseSelect.append(none);
            for (const name of available) {
                const option = document.createElement('option');
                option.value = name;
                option.textContent = name;
                baseSelect.append(option);
            }
            baseSelect.value = available.includes(entry.base) ? entry.base : '';
            baseSelect.addEventListener('change', async () => {
                entry.base = baseSelect.value || null;
                cast[speaker] = entry;
                await rederive(speaker, entry);
                context.saveSettingsDebounced();
                paint();
            });

            const preview = button('fa-play', `Hear ${speaker}`, async () => {
                if (!voiced) {
                    return toastr.info('Give them a base voice or a tone first.', 'Breeze Director');
                }
                if (typeof breeze.preview !== 'function') {
                    return toastr.warning('This build of the Breeze provider cannot preview. '
                        + 'Redeploy breeze-tts.', 'Breeze Director');
                }
                try {
                    await breeze.preview(entry.voice);
                } catch (error) {
                    toastr.error(String(error?.message ?? error), 'Breeze');
                }
            });
            if (!voiced) preview.style.opacity = '0.4';

            const recast = button('fa-rotate', 'Choose a base voice again', async () => {
                const base = await askCasting(speaker, [], entry);
                if (!base) return toastr.warning('Nothing usable came back.', 'Breeze Director');
                entry.base = base;
                cast[speaker] = entry;
                await rederive(speaker, entry);
                context.saveSettingsDebounced();
                paint();
            });

            const forget = button('fa-xmark', 'Forget this speaker', () => {
                delete cast[speaker];
                context.saveSettingsDebounced();
                onCastChanged?.();
                paint();
            });

            head.append(baseSelect, preview, recast, forget);
            row.append(head);

            // The fields the director filled in, all editable.
            const fields = document.createElement('div');
            fields.style.cssText = 'display:flex;gap:0.4em;flex-wrap:wrap;margin-top:0.35em;';
            for (const field of ['gender', 'age', 'accent']) {
                const input = document.createElement('input');
                input.className = 'text_pole';
                input.type = 'text';
                input.style.cssText = 'flex:1 1 7em;min-width:5em;';
                input.placeholder = field;
                input.value = entry[field] ?? '';
                input.addEventListener('change', async () => {
                    const value = input.value.trim();
                    if (value) entry[field] = value;
                    else delete entry[field];
                    cast[speaker] = entry;
                    await rederive(speaker, entry);
                    context.saveSettingsDebounced();
                    paint();
                });
                fields.append(input);
            }
            row.append(fields);

            const tone = document.createElement('textarea');
            tone.className = 'text_pole textarea_compact';
            tone.rows = 2;
            tone.style.marginTop = '0.35em';
            tone.placeholder = 'tone and manner of speaking';
            tone.value = entry.tone ?? '';
            tone.addEventListener('change', async () => {
                const value = tone.value.trim();
                if (value) entry.tone = value;
                else delete entry.tone;
                cast[speaker] = entry;
                await rederive(speaker, entry);
                context.saveSettingsDebounced();
                paint();
            });
            row.append(tone);

            // What Breeze is actually told, so an edit's effect is visible.
            const built = document.createElement('small');
            built.style.cssText = 'display:block;opacity:0.6;margin-top:0.25em;';
            const instruction = (!entry.base || breeze.hasVoice(entry.base))
                ? castPreset(entry).instruction
                : voiceInstruction(entry, false);
            built.textContent = instruction
                ? `Breeze hears: ${instruction}`
                : 'Nothing to send yet — pick a base voice or describe their tone.';
            row.append(built);

            list.append(row);
        }
    }

    /**
     * Rewrite the speaker's provider voice after any edit. Editing here pins the
     * entry, so a hand-assigned voice-map entry no longer overrides it — the
     * edit was an explicit choice and should stick.
     */
    async function rederive(speaker, entry) {
        if (!entry.base && !voiceInstruction(entry, false)) return;
        entry.pinned = true;
        delete entry.source;
        await applyCast(speaker, entry);
        onCastChanged?.();
    }

    paint();
    await context.callGenericPopup(wrapper, context.POPUP_TYPE.DISPLAY, '', { wide: true, large: true });
}

const SETTINGS_HTML = `
<div class="breeze-director-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>Breeze Voice Director</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <label class="checkbox_label"><input id="bd_enabled" type="checkbox"> Enabled</label>
      <label class="checkbox_label"><input id="bd_auto" type="checkbox"> Generate automatically on new character messages</label>
      <label class="checkbox_label"><input id="bd_auto_user" type="checkbox"> …and on user messages</label>
      <label class="checkbox_label"><input id="bd_prefetch" type="checkbox"> Pre-generate audio after directing</label>
      <label class="checkbox_label"><input id="bd_auto_voice" type="checkbox"> Design a voice from the character card when one is missing</label>
      <label class="checkbox_label"><input id="bd_cast" type="checkbox"> Give quoted speech its own voice per speaker</label>
      <small>Click the masks icon on any message to view, generate, or edit its direction.</small>
      <small id="bd_paragraph_warn" style="color:var(--golden);display:block;"></small>
      <small id="bd_provider_warn" style="color:var(--golden);display:block;"></small>

      <label for="bd_narrator">Narrator voice (everything outside quotes):</label>
      <select id="bd_narrator" class="text_pole"></select>

      <label for="bd_profile">Connection Profile:</label>
      <select id="bd_profile" class="text_pole"></select>

      <label for="bd_missing">If a message has no direction when narration starts:</label>
      <select id="bd_missing" class="text_pole">
        <option value="static">Use the voice's own instruction (no LLM call)</option>
        <option value="generate">Generate it now (delays playback)</option>
      </select>

      <label for="bd_mode">Combine with the voice's own instruction:</label>
      <select id="bd_mode" class="text_pole">
        <option value="replace">Replace it</option>
        <option value="append">Append to it</option>
      </select>

      <label for="bd_identify_chunk">Paragraphs per speaker-identification call:</label>
      <input id="bd_identify_chunk" type="number" min="-1" step="1" class="text_pole">
      <small>-1 sends the whole message in one call, which gives the most context.
      Lower it only if long messages lose track of who is who.</small>

      <label for="bd_cfg">CFG scale:</label>
      <input id="bd_cfg" type="number" min="1" max="10" step="1" class="text_pole">

      <label for="bd_tokens">Max response tokens:</label>
      <input id="bd_tokens" type="number" min="64" max="4096" step="32" class="text_pole">

      <label for="bd_prompt">Prompt (<code>{{parts}}</code>, <code>{{count}}</code>,
      <code>{{message}}</code>, <code>{{char}}</code>, <code>{{user}}</code>):</label>
      <textarea id="bd_prompt" class="text_pole textarea_compact" rows="14"></textarea>
      <input id="bd_reset" class="menu_button" type="button" value="Reset prompt">

      <label for="bd_identify_prompt">Speaker identification prompt (<code>{{context}}</code>,
      <code>{{parts}}</code>, <code>{{quotes}}</code>, <code>{{char}}</code>,
      <code>{{user}}</code>):</label>
      <textarea id="bd_identify_prompt" class="text_pole textarea_compact" rows="12"></textarea>
      <input id="bd_identify_reset" class="menu_button" type="button" value="Reset identification prompt">

      <label for="bd_voice_prompt">Voice design prompt (<code>{{char}}</code>, <code>{{description}}</code>):</label>
      <textarea id="bd_voice_prompt" class="text_pole textarea_compact" rows="10"></textarea>
      <input id="bd_voice_reset" class="menu_button" type="button" value="Reset voice prompt">

      <label for="bd_voice_cast_prompt">Voice casting prompt (<code>{{speaker}}</code>,
      <code>{{card}}</code>, <code>{{lines}}</code>, <code>{{voices}}</code>,
      <code>{{cast}}</code>):</label>
      <textarea id="bd_voice_cast_prompt" class="text_pole textarea_compact" rows="10"></textarea>
      <input id="bd_voice_cast_reset" class="menu_button" type="button" value="Reset casting prompt">
      <small id="bd_cast_prompt_warn" style="color:var(--golden);display:block;"></small>

      <hr>
      <b>Cast for this chat</b>
      <small>Each speaker the director names gets a base voice and a tone description
      of their own.</small>
      <div class="flex-container" style="gap:0.5em;align-items:center;margin-top:0.4em;">
        <input id="bd_cast_open" class="menu_button" type="button" value="Open voice cast">
        <input id="bd_cast_clear" class="menu_button" type="button" value="Forget whole cast">
        <span id="bd_cast_count" class="flex1"></span>
      </div>

      <hr>
      <b>Player</b>
      <label class="checkbox_label"><input id="bp_autoplay" type="checkbox"> Continue to the next paragraph automatically</label>
      <small>The masks icon on a message opens its panel inline; the headphones icon opens it
      and starts playing. Position is remembered per message, so stopping mid-way and coming
      back picks up where you left off.</small>

      <div class="flex-container" style="gap:0.5em;align-items:center;margin-top:0.5em;">
        <input id="bp_erase" class="menu_button" type="button" value="Erase cached audio">
        <span id="bp_cache_size" class="flex1"></span>
      </div>
    </div>
  </div>
</div>`;

function bind() {
    const config = settings();
    const save = () => ctx().saveSettingsDebounced();

    const checkbox = (id, key) => $(id).prop('checked', config[key]).on('change', function () {
        config[key] = !!$(this).prop('checked');
        save();
    });
    const field = (id, key, cast = String) => $(id).val(config[key]).on('input change', function () {
        config[key] = cast($(this).val());
        save();
    });

    checkbox('#bd_enabled', 'enabled');
    checkbox('#bd_auto', 'auto');
    checkbox('#bd_auto_user', 'auto_user');
    checkbox('#bd_prefetch', 'prefetch');
    checkbox('#bd_auto_voice', 'auto_voice');
    checkbox('#bd_cast', 'cast_enabled');
    field('#bd_missing', 'on_missing');
    field('#bd_mode', 'mode');
    field('#bd_cfg', 'cfg_scale', Number);
    field('#bd_tokens', 'max_tokens', Number);
    field('#bd_identify_chunk', 'identify_chunk', Number);
    field('#bd_identify_prompt', 'identify_prompt');
    field('#bd_prompt', 'prompt');
    field('#bd_voice_prompt', 'voice_prompt');
    field('#bd_voice_cast_prompt', 'voice_cast_prompt');

    // Two silent-failure modes worth naming: a saved prompt from before casting
    // never returns speakers, and with ST's own paragraph narration off it hands
    // the provider the whole message as one job.
    const warn = () => {
        // The two extensions deploy separately, so they can drift apart.
        const missing = missingProviderFeatures();
        $('#bd_provider_warn').text(missing.length
            ? `The Breeze provider is missing ${missing.join(', ')} — redeploy breeze-tts `
                + 'alongside this extension, or casting and previews will not work.'
            : '');
        $('#bd_cast_prompt_warn').text(config.voice_cast_prompt.includes('{{cast}}')
            ? ''
            : 'This saved casting prompt cannot see the existing cast — click '
                + '"Reset casting prompt" so the director keeps voices consistent.');
        $('#bd_paragraph_warn').text(ctx().extensionSettings?.tts?.narrate_by_paragraphs
            ? ''
            : 'SillyTavern\'s "Narrate by paragraphs" is off, so its own narration reads '
                + 'each message as a single job. The player here is unaffected.');
    };
    warn();
    $('#bd_prompt').on('input', warn);

    // Voices come from the provider's JSON, which the user can edit at any time.
    const fillVoices = () => {
        const available = globalThis.breezeTts?.listVoices?.() ?? [];
        const select = $('#bd_narrator');
        select.empty().append($('<option/>').val('').text('— the character\'s own voice —'));
        for (const name of available) select.append($('<option/>').val(name).text(name));
        select.val(available.includes(config.narrator_voice) ? config.narrator_voice : '');
    };
    fillVoices();
    $('#bd_narrator').on('focus', fillVoices).on('change', function () {
        config.narrator_voice = String($(this).val() ?? '');
        save();
    });

    // The sheet is the editor; the panel only reports and opens it.
    const renderCast = () => {
        const cast = settings().cast?.[currentChatId()] ?? {};
        const count = Object.keys(cast).length;
        $('#bd_cast_count').text(count ? `${count} cast` : 'nobody cast yet');
    };
    renderCast();
    onCastChanged = renderCast;

    $('#bd_cast_open').on('click', openCastSheet);

    $('#bd_cast_clear').on('click', () => {
        const cast = settings().cast?.[currentChatId()] ?? {};
        for (const speaker of Object.keys(cast)) delete cast[speaker];
        save();
        renderCast();
        toastr.info('Cast forgotten for this chat.', 'Breeze Director');
    });

    $('#bd_reset').on('click', () => {
        config.prompt = DEFAULT_PROMPT;
        $('#bd_prompt').val(DEFAULT_PROMPT);
        save();
        warn();
    });

    $('#bd_identify_reset').on('click', () => {
        config.identify_prompt = DEFAULT_IDENTIFY_PROMPT;
        $('#bd_identify_prompt').val(DEFAULT_IDENTIFY_PROMPT);
        save();
    });

    $('#bd_voice_cast_reset').on('click', () => {
        config.voice_cast_prompt = DEFAULT_VOICE_CAST_PROMPT;
        $('#bd_voice_cast_prompt').val(DEFAULT_VOICE_CAST_PROMPT);
        save();
        warn();
    });
    const playerConfig = playerSettings();
    $('#bp_autoplay').prop('checked', playerConfig.autoplay_next).on('change', function () {
        playerConfig.autoplay_next = !!$(this).prop('checked');
        save();
    });

    const showCacheSize = async () => {
        const stats = await globalThis.breezeTts?.cacheStats?.() ?? { count: 0, bytes: 0 };
        $('#bp_cache_size').text(stats.count ? `${stats.count} clips — ${size(stats.bytes)}` : 'cache empty');
    };
    showCacheSize();

    $('#bp_erase').on('click', async () => {
        await globalThis.breezeTts?.clearCache?.();
        showCacheSize();
        toastr.success('Cached audio erased.', 'Breeze');
    });

    $('#bd_voice_reset').on('click', () => {
        config.voice_prompt = DEFAULT_VOICE_PROMPT;
        $('#bd_voice_prompt').val(DEFAULT_VOICE_PROMPT);
        save();
    });

    try {
        ctx().ConnectionManagerRequestService.handleDropdown('#bd_profile', config.profile, profile => {
            config.profile = profile?.id ?? '';
            save();
        });
    } catch {
        $('#bd_profile').replaceWith('<small>Connection Manager is disabled — enable it to pick a profile.</small>');
    }
}

jQuery(async () => {
    $('#extensions_settings2').append(SETTINGS_HTML);
    bind();
    addButtons();

    // Deployed separately, so check rather than assume they match.
    const missing = missingProviderFeatures();
    if (missing.length) {
        console.warn(`[Breeze Director] the Breeze provider is missing ${missing.join(', ')}. `
            + 'Redeploy breeze-tts from the same checkout as this extension.');
        toastr.warning(`Breeze provider is out of date (missing ${missing.join(', ')}).`,
            'Breeze Director');
    }

    $(document).on('click', '.mes_breeze_direct', function () {
        const index = Number($(this).closest('.mes').attr('mesid'));
        if (Number.isInteger(index)) openPanel(index);
    });

    $(document).on('click', '.mes_breeze_play', function () {
        const index = Number($(this).closest('.mes').attr('mesid'));
        if (Number.isInteger(index)) openPanel(index, { play: true });
    });

    $('#tts_wand_container').append(`
        <div id="breezeDirectorEdit" class="list-group-item flex-container flexGap5" title="Voice direction for the last message">
            <div class="extensionsMenuExtensionButton fa-solid fa-masks-theater"></div>
            <span>Voice direction</span>
        </div>`);
    $('#breezeDirectorEdit').on('click', () => {
        const index = (ctx().chat?.length ?? 0) - 1;
        if (index >= 0) openPanel(index, { expandAll: true });
        else toastr.info('No messages in this chat.', 'Breeze Director');
    });

    $('#tts_wand_container').append(`
        <div id="breezeVoiceCast" class="list-group-item flex-container flexGap5" title="Voices cast in this chat">
            <div class="extensionsMenuExtensionButton fa-solid fa-users"></div>
            <span>Voice cast</span>
        </div>`);
    $('#breezeVoiceCast').on('click', openCastSheet);

    $('#tts_wand_container').append(`
        <div id="breezePlayerResume" class="list-group-item flex-container flexGap5" title="Resume Breeze narration">
            <div class="extensionsMenuExtensionButton fa-solid fa-headphones"></div>
            <span>Resume narration</span>
        </div>`);
    $('#breezePlayerResume').on('click', resumeLatest);

    const { eventSource, event_types } = ctx();

    const onRendered = (id, fromUser) => {
        const config = settings();
        addButtons();
        if (!config.enabled) return;
        if (fromUser && !config.auto_user) return;
        const index = Number(id);
        if (Number.isInteger(index)) prepare(index);
    };

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, id => onRendered(id, false));
    eventSource.on(event_types.USER_MESSAGE_RENDERED, id => onRendered(id, true));
    eventSource.on(event_types.MESSAGE_SWIPED, id => {
        const index = Number(id);
        closePanel(index);
        if (settings().enabled && Number.isInteger(index)) prepare(index);
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        inFlight.clear();
        voiceJobs.clear();
        castJobs.clear();
        onCastChanged?.();
        player.stop();
        closeAllPanels();
        addButtons();
    });
});
