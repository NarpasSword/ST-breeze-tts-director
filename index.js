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
};

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
    return fill(ctx().extensionSettings, MODULE, DEFAULTS);
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

const normalize = s => String(s ?? '').replace(/[*_"'`~]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

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

function buildPrompt(message, units) {
    const context = ctx();
    const parts = units.map((unit, i) => `${i + 1}. ${unit.text}`).join('\n\n');
    return settings().prompt
        .replace(/{{parts}}/g, parts)
        .replace(/{{count}}/g, String(units.length))
        .replace(/{{message}}/g, String(message?.mes ?? ''))
        .replace(/{{char}}/g, String(message?.name ?? context.name2 ?? ''))
        .replace(/{{user}}/g, String(context.name1 ?? ''));
}

function parseInstructions(raw, count) {
    const text = String(raw ?? '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/```(?:json)?/gi, '')
        .trim();

    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start !== -1 && end > start) {
        try {
            const parsed = JSON.parse(text.slice(start, end + 1));
            if (Array.isArray(parsed)) {
                const clean = parsed.map(v => String(v ?? '').trim()).filter(Boolean);
                if (clean.length) {
                    // Pad short replies with the last usable direction.
                    while (clean.length < count) clean.push(clean[clean.length - 1]);
                    return clean.slice(0, count);
                }
            }
        } catch { /* fall through to the single-instruction path */ }
    }

    // Model ignored the format: use its first line as one direction for everything.
    const single = text.split('\n').map(l => l.trim()).filter(Boolean)[0];
    return single ? new Array(count).fill(single.replace(/^["'`]|["'`]$/g, '')) : null;
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

    // A reasoning model can spend the whole budget thinking and return nothing,
    // so floor the request at enough room to think and still write every line.
    const budget = Math.max(Number(config.max_tokens) || 0, 600 + 80 * units.length);

    const result = await context.ConnectionManagerRequestService.sendRequest(
        config.profile,
        buildPrompt(message, units),
        budget,
    );

    // Empty and unparseable are different failures: one wants a bigger budget
    // or a non-reasoning profile, the other wants a different prompt.
    if (!String(result?.content ?? '').trim()) {
        console.warn('[Breeze Director] empty completion — the model likely spent the '
            + `budget (${budget}) on reasoning. Raw result:`, result);
        if (!quiet) toastr.error('Model returned an empty completion.', 'Breeze Director');
        return null;
    }

    const instructions = parseInstructions(result?.content, units.length);
    if (!instructions) {
        console.warn('[Breeze Director] could not parse a completion:', result?.content);
        if (!quiet) toastr.error('Model returned nothing usable.', 'Breeze Director');
        return null;
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
        lines: units.map((unit, i) => ({ text: unit.text, instruction: instructions[i] })),
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

function pickLine(direction, text) {
    const needle = normalize(text);
    if (!needle) return direction.lines[0]?.instruction;

    const exact = direction.lines.find(l => normalize(l.text) === needle);
    if (exact) return exact.instruction;

    // Quote-only narration hands us a fragment of the line.
    const partial = direction.lines.find(l => {
        const body = normalize(l.text);
        return body.includes(needle) || needle.includes(body);
    });
    return (partial ?? direction.lines[0])?.instruction;
}

globalThis.breezeDirector = async function (text, voiceId, preset) {
    const config = settings();
    if (!config.enabled) return null;

    const index = locate(text);
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

    const line = pickLine(direction, text);
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

    const result = await context.ConnectionManagerRequestService.sendRequest(
        config.profile, prompt, 200,
    );

    let line = String(result?.content ?? '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .split('\n').map(l => l.trim()).filter(Boolean)[0] ?? '';
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

    const voice = breeze.voiceForCharacter(message.name);
    if (!voice) return;

    for (const unit of buildUnits(message.mes)) {
        await breeze.prefetch(unit.text, voice);
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
    units: [],
    index: 0,
    voice: null,
    messageId: null,
    url: null,
    onChange: null,
    loadToken: 0,

    async load(messageId) {
        const message = ctx().chat?.[messageId];
        if (!message) throw new Error('Message not found.');

        const breeze = globalThis.breezeTts;
        if (!breeze?.available) throw new Error('Select the Breeze TTS provider first.');

        const voice = breeze.voiceForCharacter(message.name);
        if (!voice) throw new Error(`No Breeze voice assigned to ${message.name}.`);

        this.stop();
        this.messageId = messageId;
        this.units = buildUnits(message.mes);
        this.voice = voice;
        this.index = Math.min(loadPosition(messageId), Math.max(this.units.length - 1, 0));
        return this.units;
    },

    async playAt(index) {
        if (index < 0 || index >= this.units.length) return this.stop();

        this.index = index;
        savePosition(this.messageId, index);
        this.notify('loading');

        // Ignore results from any earlier play that is still resolving.
        const token = ++this.loadToken;
        let clip;
        try {
            clip = await globalThis.breezeTts.getClip(this.units[index].text, this.voice);
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

        // Warm the next clip while this one plays.
        const next = this.units[index + 1];
        if (next) globalThis.breezeTts.prefetch(next.text, this.voice);
    },

    next() { return this.playAt(this.index + 1); },
    prev() { return this.playAt(this.index - 1); },

    toggle() {
        if (this.audio.paused) {
            if (!this.audio.src) return this.playAt(this.index);
            this.audio.play().catch(() => { });
            this.notify('playing');
        } else {
            this.audio.pause();
            this.notify('paused');
        }
    },

    stop() {
        this.loadToken++;
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
        if (typeof this.onChange === 'function') this.onChange(state, this.index);
    },
};

player.audio.addEventListener('ended', () => {
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
                ? `Generating audio for paragraph ${playingIndex + 1}…`
                : playingIndex >= 0
                    ? `Paragraph ${playingIndex + 1} of ${units.length} — ${state}`
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

    const voice = breeze.voiceForCharacter(message.name);
    if (!voice) return toastr.info(`No Breeze voice assigned to ${message.name}.`, 'Breeze');

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

    const texts = buildUnits(message.mes).map(unit => unit.text);
    const { count, bytes } = await breeze.dropClips(texts, voice);
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
      <small>Click the masks icon on any message to view, generate, or edit its direction.</small>

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

      <label for="bd_cfg">CFG scale:</label>
      <input id="bd_cfg" type="number" min="1" max="10" step="1" class="text_pole">

      <label for="bd_tokens">Max response tokens:</label>
      <input id="bd_tokens" type="number" min="64" max="4096" step="32" class="text_pole">

      <label for="bd_prompt">Prompt (<code>{{parts}}</code>, <code>{{count}}</code>,
      <code>{{message}}</code>, <code>{{char}}</code>, <code>{{user}}</code>):</label>
      <textarea id="bd_prompt" class="text_pole textarea_compact" rows="14"></textarea>
      <input id="bd_reset" class="menu_button" type="button" value="Reset prompt">

      <label for="bd_voice_prompt">Voice design prompt (<code>{{char}}</code>, <code>{{description}}</code>):</label>
      <textarea id="bd_voice_prompt" class="text_pole textarea_compact" rows="10"></textarea>
      <input id="bd_voice_reset" class="menu_button" type="button" value="Reset voice prompt">

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
    field('#bd_missing', 'on_missing');
    field('#bd_mode', 'mode');
    field('#bd_cfg', 'cfg_scale', Number);
    field('#bd_tokens', 'max_tokens', Number);
    field('#bd_prompt', 'prompt');
    field('#bd_voice_prompt', 'voice_prompt');

    $('#bd_reset').on('click', () => {
        config.prompt = DEFAULT_PROMPT;
        $('#bd_prompt').val(DEFAULT_PROMPT);
        save();
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
        player.stop();
        closeAllPanels();
        addButtons();
    });
});
