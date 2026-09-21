// SillyTavern extension: Breeze TTS, Director & Player.
//
// One extension, three halves that were once three folders:
//
//   Provider — registers "Breeze" in the TTS provider dropdown, wraps its raw
//              PCM in WAV, caches clips in IndexedDB, and publishes
//              globalThis.breezeTts.
//   Director — an LLM call per message writes per-paragraph delivery direction,
//              another works out who speaks each quote, and each speaker is
//              cast a voice of their own.
//   Player   — an inline panel per message: paragraph seek, resume, take
//              history, per-segment voice overrides.
//
// The two halves still talk through globalThis.breezeTts and
// globalThis.breezeDirector rather than calling each other directly. That
// boundary is worth keeping: the provider must work with no director present,
// and the director must tolerate a provider that is absent or older.
//
// They were separate extensions until they drifted apart once too often — a
// director deployed against a months-old provider fails silently, because an
// exception inside casting is indistinguishable from the model declining.
// Shipping them together removes that failure mode entirely.
//
// The provider's voices are the user's to curate, in its own settings box.
// Nothing here writes one: a cast member is one of those voices as a base, plus
// a description, composed into an instruction when a line is generated.
import { registerTtsProvider, getPreviewString, saveTtsProviderSettings } from '../../tts/index.js';

// Shared by both halves. Pure formatting, no concern of either.

/** Bytes as MB or KB, whichever reads better. */
function size(bytes) {
    return bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

// ===========================================================================
// PROVIDER
// ===========================================================================


const PROVIDER_NAME = 'Breeze'; // as it appears in SillyTavern's provider dropdown
const SAMPLE_RATE = 24000; // Breeze streams mono s16le at 24 kHz
const BYTES_PER_SAMPLE = 2;
const DEFAULT_VOICE_MARKER = '[Default Voice]';

// What a line is read with when nothing else says anything: a blank take on a
// voice that carries no instruction. Breeze needs one of its three field
// combinations to pick a mode, so "say nothing" cannot be sent as nothing.
const PLAIN_INSTRUCTION = 'Read the line plainly and clearly, at a natural pace.';

const DEFAULT_VOICES = {
    'narrator': {
        instruction: 'A calm, warm narrator with clear diction and unhurried pacing.',
        cfg_scale: 4,
    },
    'villain': {
        instruction: 'A gravelly older man, menacing and slow, with a hint of amusement.',
        cfg_scale: 4,
    },
};

/** Wrap raw PCM bytes in a 44-byte WAV header so the browser can play them. */
function toWav(pcm) {
    const length = pcm.size ?? pcm.byteLength;
    const header = new ArrayBuffer(44);
    const view = new DataView(header);
    const str = (offset, text) => {
        for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };
    const byteRate = SAMPLE_RATE * BYTES_PER_SAMPLE;

    str(0, 'RIFF');
    view.setUint32(4, 36 + length, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);            // PCM
    view.setUint16(22, 1, true);            // mono
    view.setUint32(24, SAMPLE_RATE, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, BYTES_PER_SAMPLE, true);
    view.setUint16(34, 16, true);
    str(36, 'data');
    view.setUint32(40, length, true);

    return new Blob([header, pcm], { type: 'audio/wav' });
}

// ------------------------------------------------------------------ clip cache
// IndexedDB rather than the chat file: audio is far too big to ride along in
// chat JSON, and this survives reloads without bloating exports.

const DB_NAME = 'breeze-tts';
const STORE = 'clips';
const DB_VERSION = 2; // v2 adds the voiceText index
let dbPromise = null;

function db() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const database = request.result;
                const store = database.objectStoreNames.contains(STORE)
                    ? request.transaction.objectStore(STORE)
                    : database.createObjectStore(STORE, { keyPath: 'key' });
                if (!store.indexNames.contains('ts')) store.createIndex('ts', 'ts');
                // The primary key folds in the instruction, so erasing the audio
                // for one message needs a second way in. Rows written before v2
                // carry no voice/text, stay out of this index, and age out via LRU.
                if (!store.indexNames.contains('voiceText')) {
                    store.createIndex('voiceText', ['voice', 'text']);
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
    return dbPromise;
}

function tx(mode, run) {
    return db().then(database => new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE, mode);
        const request = run(transaction.objectStore(STORE));
        transaction.onerror = () => reject(transaction.error);
        if (request) {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        } else {
            transaction.oncomplete = () => resolve();
        }
    }));
}

const cache = {
    async get(key) {
        try {
            const row = await tx('readonly', store => store.get(key));
            if (!row) return null;
            // Refresh recency without blocking the caller.
            tx('readwrite', store => store.put({ ...row, ts: Date.now() })).catch(() => { });
            return row.blob;
        } catch (error) {
            console.warn('[Breeze] cache read failed:', error);
            return null;
        }
    },
    async put(key, blob, limit, meta = {}) {
        try {
            await tx('readwrite', store => store.put({
                key, blob, ts: Date.now(), voice: meta.voice ?? '', text: meta.text ?? '',
            }));
            await cache.evict(limit);
        } catch (error) {
            console.warn('[Breeze] cache write failed:', error);
        }
    },
    async evict(limit) {
        const total = await cache.count();
        if (total <= limit) return;
        const excess = total - limit;
        await tx('readwrite', store => {
            let removed = 0;
            const cursorRequest = store.index('ts').openCursor();
            cursorRequest.onsuccess = () => {
                const cursor = cursorRequest.result;
                if (!cursor || removed >= excess) return;
                cursor.delete();
                removed++;
                cursor.continue();
            };
            return null;
        });
    },
    count() {
        return tx('readonly', store => store.count()).catch(() => 0);
    },
    /** Clip count and total bytes on disk. */
    async stats() {
        try {
            const database = await db();
            return await new Promise((resolve, reject) => {
                const transaction = database.transaction(STORE, 'readonly');
                const request = transaction.objectStore(STORE).openCursor();
                let count = 0;
                let bytes = 0;
                request.onsuccess = () => {
                    const cursor = request.result;
                    if (!cursor) return resolve({ count, bytes });
                    count++;
                    bytes += cursor.value?.blob?.size ?? 0;
                    cursor.continue();
                };
                request.onerror = () => reject(request.error);
            });
        } catch {
            return { count: 0, bytes: 0 };
        }
    },
    /** Delete every cached clip for these lines in this voice, whatever the instruction. */
    async dropMany(voice, texts) {
        let count = 0;
        let bytes = 0;
        try {
            const database = await db();
            await new Promise((resolve, reject) => {
                const transaction = database.transaction(STORE, 'readwrite');
                const index = transaction.objectStore(STORE).index('voiceText');
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error);

                for (const text of new Set(texts)) {
                    const cursorRequest = index.openCursor(IDBKeyRange.only([voice, text]));
                    cursorRequest.onsuccess = () => {
                        const cursor = cursorRequest.result;
                        if (!cursor) return;
                        count++;
                        bytes += cursor.value?.blob?.size ?? 0;
                        cursor.delete();
                        cursor.continue();
                    };
                }
            });
        } catch (error) {
            console.warn('[Breeze] cache drop failed:', error);
        }
        return { count, bytes };
    },
    clear() {
        return tx('readwrite', store => store.clear());
    },
};

// ------------------------------------------------------------------ public API
// Declared before the provider class: registerTtsProvider() constructs and loads
// the provider during the register call, so anything bound afterwards is too late.

globalThis.breezeTts = {
    _provider: null,
    _bind(provider) { this._provider = provider; },
    get available() { return !!this._provider; },
    listVoices() { return this._provider?.listVoices() ?? []; },
    hasVoice(name) { return this._provider?.hasVoice(name) ?? false; },
    voiceForCharacter(character) { return this._provider?.voiceForCharacter(character) ?? null; },
    assignedVoice(character) { return this._provider?.assignedVoice(character) ?? null; },
    prefetch(text, voice, hint) { return this._provider?.prefetch(text, voice, hint) ?? Promise.resolve(false); },
    getClip(text, voice, hint) { return this._provider?._clip(text, voice, hint); },
    cacheStats() { return cache.stats(); },
    /** What would be sent for this line, without sending it. */
    explain(text, voice, hint) { return this._provider?._plan(text, voice, hint) ?? null; },
    /** Is this plan's clip already in the cache? */
    async isCached(key) { return !!(await cache.get(key)); },
    /** Play a base voice under an instruction that is not stored anywhere. */
    previewWith(voice, instruction, cfgScale) {
        return this._provider?.previewTtsVoice(voice, { instruction, cfg_scale: cfgScale });
    },
    /** A copy of a voice's raw preset, for deriving another voice from it. */
    voicePreset(name) {
        const preset = this._provider?.voicePreset(name);
        return preset ? { ...preset } : null;
    },
    dropClips(texts, voice) { return cache.dropMany(voice, texts); },
    clearCache() { return cache.clear(); },
};

// ------------------------------------------------------------------- provider

class BreezeTtsProvider {
    constructor() {
        globalThis.breezeTts._bind(this);
    }

    settings;
    voices = [];
    ready = false;
    separator = ' . ';
    audioElement = document.createElement('audio');
    _pending = new Map();

    defaultSettings = {
        voiceMap: {},
        provider_endpoint: 'http://127.0.0.1:7860',
        voices_json: JSON.stringify(DEFAULT_VOICES, null, 2),
        chunk_ms: 0,
        seed: 42,
        cache_enabled: true,
        cache_max: 500,
    };

    get settingsHtml() {
        return `
        <label for="breeze_endpoint">Breeze API Endpoint:</label>
        <input id="breeze_endpoint" type="text" class="text_pole"/>

        <label for="breeze_seed">Seed:</label>
        <input id="breeze_seed" type="number" class="text_pole"/>

        <label for="breeze_chunk">Stream chunk size (ms, 0 = wait for full clip):</label>
        <input id="breeze_chunk" type="number" min="0" step="100" class="text_pole"/>
        <small>Streaming disables the clip cache and can sound seamed. 0 is recommended.</small>

        <label class="checkbox_label">
            <input id="breeze_cache" type="checkbox"> Cache generated clips
        </label>
        <label for="breeze_cache_max">Max cached clips:</label>
        <input id="breeze_cache_max" type="number" min="0" step="50" class="text_pole"/>
        <div class="flex-container">
            <input id="breeze_cache_clear" class="menu_button" type="button" value="Clear cache"/>
            <span id="breeze_cache_count" class="flex1"></span>
        </div>

        <label for="breeze_voices">Voices (JSON):</label>
        <small>Each key is a voice name. Fields: <code>instruction</code>, <code>cfg_scale</code>,
        <code>ref_audio_url</code>, <code>ref_text</code>, <code>dynamic</code>.</small>
        <textarea id="breeze_voices" class="text_pole textarea_compact" rows="14"></textarea>
        <div id="breeze_status"></div>`;
    }

    async loadSettings(settings) {
        this.settings = Object.assign({}, this.defaultSettings);
        for (const key in settings) {
            if (key in this.settings) this.settings[key] = settings[key];
        }

        $('#breeze_endpoint').val(this.settings.provider_endpoint).on('input', () => this.onSettingsChange());
        $('#breeze_seed').val(this.settings.seed).on('input', () => this.onSettingsChange());
        $('#breeze_chunk').val(this.settings.chunk_ms).on('input', () => this.onSettingsChange());
        $('#breeze_cache').prop('checked', this.settings.cache_enabled).on('change', () => this.onSettingsChange());
        $('#breeze_cache_max').val(this.settings.cache_max).on('input', () => this.onSettingsChange());
        $('#breeze_voices').val(this.settings.voices_json).on('input', () => this.onSettingsChange());
        $('#breeze_cache_clear').on('click', async () => {
            await cache.clear();
            this.refreshCacheCount();
            toastr.success('Clip cache cleared.', 'Breeze');
        });

        this.refreshCacheCount();
        await this.checkReady();
    }

    onSettingsChange() {
        this.settings.provider_endpoint = String($('#breeze_endpoint').val()).replace(/\/+$/, '');
        this.settings.seed = Number($('#breeze_seed').val());
        this.settings.chunk_ms = Number($('#breeze_chunk').val());
        this.settings.cache_enabled = !!$('#breeze_cache').prop('checked');
        this.settings.cache_max = Number($('#breeze_cache_max').val());
        this.settings.voices_json = String($('#breeze_voices').val());
        this.voices = [];
        saveTtsProviderSettings();
    }

    async refreshCacheCount() {
        const { count, bytes } = await cache.stats();
        $('#breeze_cache_count').text(count ? `${count} clips — ${size(bytes)}` : 'cache empty');
    }

    dispose() { }

    _presets() {
        try {
            return JSON.parse(this.settings.voices_json);
        } catch (error) {
            toastr.error('Voices JSON is not valid.', 'Breeze TTS');
            throw error;
        }
    }

    async checkReady() {
        try {
            const response = await fetch(`${this.settings.provider_endpoint}/health`);
            const data = await response.json();
            this.ready = data.status === 'ok';
            $('#breeze_status').text(this.ready ? 'Ready' : `Status: ${data.status}`);
        } catch {
            this.ready = false;
            $('#breeze_status').text('Offline — is the Breeze API running, and is CORS enabled?');
        }
        this.voices = await this.fetchTtsVoiceObjects();
    }

    async onRefreshClick() {
        await this.checkReady();
        await this.refreshCacheCount();
    }

    async fetchTtsVoiceObjects() {
        return Object.keys(this._presets()).map(name => ({ name, voice_id: name, lang: 'en-US' }));
    }

    async getVoice(voiceName) {
        if (!this.voices.length) this.voices = await this.fetchTtsVoiceObjects();
        const match = this.voices.find(v => v.name === voiceName);
        if (!match) throw `TTS Voice name ${voiceName} not found`;
        return match;
    }

    /**
     * Settle the instruction for this line, consulting the director if present.
     * `hint` names the message and paragraph the text came from. Callers that
     * know it should pass it: without one the director has to find the line by
     * matching text, which a short quoted fragment can defeat.
     */
    async _plan(text, voiceId, hint) {
        const preset = this._presets()[voiceId];
        if (!preset) throw `Unknown Breeze voice: ${voiceId}`;

        let instruction = preset.instruction ?? '';
        let cfgScale = preset.cfg_scale ?? 1;

        // An explicit instruction settles it: the cast sheet previewing a voice
        // it has composed, with no message to direct from.
        if (hint?.instruction) {
            instruction = hint.instruction;
            cfgScale = hint.cfg_scale ?? cfgScale;
        // `bypass` plays the voice as written, undirected.
        } else if (!hint?.bypass && preset.dynamic !== false
            && typeof globalThis.breezeDirector === 'function') {
            try {
                const directed = await globalThis.breezeDirector(text, voiceId, preset, hint);
                if (directed?.instruction) {
                    instruction = directed.instruction;
                    cfgScale = directed.cfg_scale ?? cfgScale;
                }
            } catch (error) {
                console.error('[Breeze] director hook failed, using static preset:', error);
            }
        }

        // Breeze chooses its mode from the fields present: an instruction alone
        // is Voice Design, reference audio alone is Voice Clone, both together
        // are Voice Direction. A request carrying neither matches no template
        // at all — and that is exactly what a blank take on a voice with no
        // instruction of its own would send, which is why blank takes made no
        // sound while directed ones did. Read the line plainly instead.
        if (!instruction && !preset.ref_audio_url) {
            console.debug('[Breeze] nothing composed an instruction; reading plainly.');
            instruction = PLAIN_INSTRUCTION;
        }

        const key = JSON.stringify([
            this.settings.provider_endpoint, voiceId, instruction, cfgScale,
            this.settings.seed, preset.ref_audio_url ?? '', text,
        ]);

        return { preset, instruction, cfgScale, key };
    }

    /** POST to Breeze. Retries while the server is busy generating something else. */
    async _fetch(text, plan) {
        const form = new FormData();
        form.append('text', text);
        form.append('seed', String(this.settings.seed));
        form.append('cfg_scale', String(plan.cfgScale));
        if (plan.instruction) form.append('instruction', plan.instruction);

        if (plan.preset.ref_audio_url) {
            const audio = await fetch(plan.preset.ref_audio_url).then(r => r.blob());
            form.append('ref_audio', audio, 'reference.wav');
            form.append('ref_text', plan.preset.ref_text ?? '');
        }

        for (let attempt = 0; attempt < 40; attempt++) {
            const response = await fetch(`${this.settings.provider_endpoint}/v1/audio/speech`, {
                method: 'POST',
                body: form,
            });
            if (response.status === 409) {
                await new Promise(resolve => setTimeout(resolve, 500));
                continue;
            }
            if (!response.ok) throw new Error(`Breeze HTTP ${response.status}: ${await response.text()}`);
            return response;
        }
        throw new Error('Breeze stayed busy for too long.');
    }

    /**
     * A complete WAV clip, from cache when possible. `info`, when passed, comes
     * back saying whether the clip was already there — the difference between
     * "pre-generated" and "nothing to do" that the caller cannot otherwise see.
     */
    async _clip(text, voiceId, hint, info = {}) {
        const plan = await this._plan(text, voiceId, hint);

        if (this.settings.cache_enabled) {
            const hit = await cache.get(plan.key);
            if (hit) {
                console.debug('[Breeze] cache hit');
                info.cached = true;
                return hit;
            }
        }

        // Prefetch and playback can ask for the same clip at once; generate once.
        if (this._pending.has(plan.key)) return this._pending.get(plan.key);

        const work = (async () => {
            const response = await this._fetch(text, plan);
            const clip = toWav(await response.blob());
            if (this.settings.cache_enabled) {
                await cache.put(plan.key, clip, Number(this.settings.cache_max), { voice: voiceId, text });
                this.refreshCacheCount();
            }
            return clip;
        })();

        this._pending.set(plan.key, work);
        try {
            return await work;
        } finally {
            this._pending.delete(plan.key);
        }
    }

    /**
     * Generate and cache ahead of playback. Errors are swallowed by design.
     *
     * Returns which of the four things happened, not a bare boolean: a clip
     * already in the cache, a cache that is switched off and a request that
     * failed are all "no audio was generated", and telling a reader they are
     * the same thing is what made a silent pre-generation impossible to place.
     * Every value but `'cache-off'` and `'failed'` is truthy, as before.
     */
    async prefetch(text, voiceId, hint) {
        if (!this.settings.cache_enabled) return 'cache-off';
        try {
            const info = {};
            await this._clip(text, voiceId, hint, info);
            return info.cached ? 'cached' : 'generated';
        } catch (error) {
            console.warn('[Breeze] prefetch failed:', error);
            return false;
        }
    }

    async *generateTts(text, voiceId) {
        // Streaming path: playable chunks as PCM arrives, no caching.
        if (Number(this.settings.chunk_ms) > 0) {
            const plan = await this._plan(text, voiceId);
            const response = await this._fetch(text, plan);
            const minBytes = Math.floor(SAMPLE_RATE * BYTES_PER_SAMPLE * this.settings.chunk_ms / 1000);
            const reader = response.body.getReader();
            let buffer = [];
            let size = 0;

            const flush = () => {
                // Never split a 16-bit sample across chunks.
                let pending = new Blob(buffer);
                let carry = null;
                if (pending.size % BYTES_PER_SAMPLE !== 0) {
                    carry = pending.slice(pending.size - 1);
                    pending = pending.slice(0, pending.size - 1);
                }
                buffer = carry ? [carry] : [];
                size = carry ? carry.size : 0;
                return new Response(toWav(pending), { headers: { 'Content-Type': 'audio/wav' } });
            };

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer.push(value);
                size += value.length;
                if (size >= minBytes) yield flush();
            }
            if (size > 0) yield flush();
            return;
        }

        yield new Response(await this._clip(text, voiceId), {
            headers: { 'Content-Type': 'audio/wav' },
        });
    }

    async previewTtsVoice(voiceId, hint = { bypass: true }) {
        this.audioElement.pause();
        this.audioElement.currentTime = 0;

        const clip = await this._clip(getPreviewString('en-US'), voiceId, hint);
        const url = URL.createObjectURL(clip);
        this.audioElement.src = url;
        this.audioElement.onended = () => URL.revokeObjectURL(url);
        await this.audioElement.play();
    }

    // ----------------------------------------------------- methods the API uses

    listVoices() {
        return Object.keys(this._presets());
    }

    hasVoice(name) {
        return Object.prototype.hasOwnProperty.call(this._presets(), name);
    }

    voicePreset(name) {
        return this._presets()[name] ?? null;
    }

    /**
     * The voice a character was *explicitly* given in the voice map.
     *
     * Distinct from voiceForCharacter() below, which follows [Default Voice] to
     * whatever it points at. SillyTavern gives every character that marker
     * until someone picks otherwise (tts/index.js:1525), so following it here
     * would read "nobody chose a voice for them" as "the user chose this one".
     */
    assignedVoice(character) {
        const value = (this.settings.voiceMap ?? {})[character];
        if (!value || value === 'disabled' || value === DEFAULT_VOICE_MARKER) return null;
        return this.hasVoice(value) ? value : null;
    }

    /** Resolve which voice a character narrates with, following the default marker. */
    voiceForCharacter(character) {
        const map = this.settings.voiceMap ?? {};
        let value = map[character];
        if (value === DEFAULT_VOICE_MARKER) value = map[DEFAULT_VOICE_MARKER];
        if (!value || value === 'disabled' || value === DEFAULT_VOICE_MARKER) return null;
        return this.hasVoice(value) ? value : null;
    }
}

/**
 * Put the provider dropdown back on Breeze.
 *
 * SillyTavern fills that dropdown and selects the saved provider during its own
 * init (`tts/index.js:876`), which runs before any third-party provider has
 * registered. With Breeze saved, `.val('Breeze')` matches no option yet, so the
 * select falls back to showing its first entry — AllTalk. Registering adds the
 * option but never revisits the selection, leaving the dropdown describing a
 * provider that is not the one loaded.
 */
function showRegisteredProvider() {
    const context = SillyTavern.getContext();

    const select = () => {
        if (context.extensionSettings?.tts?.currentProvider !== PROVIDER_NAME) return;
        const dropdown = $('#tts_provider');
        if (dropdown.val() === PROVIDER_NAME) return;
        // Value only: firing change would re-run ST's provider switch, and the
        // provider is already loaded — only the display is out of step.
        dropdown.val(PROVIDER_NAME);
    };

    select();
    // APP_READY auto-fires for listeners added after it, so this cannot race
    // with however far along SillyTavern's own init happens to be.
    context.eventSource.on(context.event_types.APP_READY, select);
}

// Registration throws if something else already claimed the name — which is
// exactly what happens when the old standalone breeze-tts extension is still
// installed. Unguarded, that exception aborts this whole file and the
// extension vanishes from the UI with no visible cause.
try {
    registerTtsProvider(PROVIDER_NAME, BreezeTtsProvider);
    jQuery(showRegisteredProvider);
} catch (error) {
    console.error('[Breeze] could not register the TTS provider:', error);
    toastr.error('The Breeze TTS provider is already registered. Disable the separate '
        + '"Breeze TTS Provider" extension — this one now includes it.', 'Breeze');
}

// ===========================================================================
// DIRECTOR AND PLAYER
// ===========================================================================

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

const DEFAULT_VOICE_CAST_PROMPT = `Cast a speaking voice for one character.

Character: {{speaker}}
{{context}}
Lines they speak:
{{lines}}

Available base voices:
{{voices}}
{{cast}}
First choose a base: the voice on that list whose sound is nearest theirs. Match on
apparent gender first, then age, then texture. Several characters may share a base —
your description is what tells them apart — so choose on sound alone, never on who
has been cast already or on where a voice sits in the list.

Then describe the voice itself:
  gender  — one or two words
  age     — approximate, such as "late teens" or "forties"
  tone    — AT MOST 15 WORDS. Pitch, texture, pace, habitual manner. Short plain
            phrases, no semicolons, no dashes, no sub-clauses.
  accent  — only where there is a clear basis for one, else ""

Describe the voice as it always sounds, not how it changes with mood. How a line is
felt is directed separately, line by line; this is the instrument, not the
performance. Nothing about appearance, history, or what is happening to them.

Good tone: "Bright and light. Quick, clipped delivery with an upward lilt."
Too much: anything naming what they feel, when they feel it, or what lies beneath it.

Leave a field as "" when nothing supports it. Do not invent.

Reply with ONLY a JSON object, no commentary, no code fences:
{"base": "<a voice name from the list>", "gender": "", "age": "", "tone": "", "accent": ""}`;

/** Spliced into the casting prompt at {{cast}} once anyone has been cast. */
const CAST_BLOCK = `
Already cast in this scene:
{{list}}

Reuse one of those bases only if this is the same person under another name.
`;

// Horizontal rules: --- *** ___ ===, and rows of tildes. Page furniture, not
// speech, and Breeze reads them aloud as a run of dashes.
const DEFAULT_EXCLUSIONS = '^[-*_=~]{3,}$';

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
    prefetch: true,
    cast_enabled: true,
    narrator_voice: '',   // '' = the character's own voice
    voice_cast_prompt: DEFAULT_VOICE_CAST_PROMPT,
    identify_prompt: DEFAULT_IDENTIFY_PROMPT,
    identify_chunk: -1,   // paragraphs per identification call; -1 = whole message
    exclusions: DEFAULT_EXCLUSIONS,  // one regex per line; matching lines go unread
    skip_tags: true,      // drop <tag>…</tag> blocks, as SillyTavern's own TTS does
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

// Whitespace plus the zero-width characters that occupy a line while showing
// nothing: zero-width space/non-joiner/joiner and the byte-order mark.
const BLANK = /[\s\u200B-\u200D\uFEFF]/;
const BLANK_EDGES = new RegExp(`^${BLANK.source}+|${BLANK.source}+$`, 'g');

/**
 * How the TTS extension splits a message into narration jobs, with one
 * deliberate difference: a line that *looks* empty is treated as empty.
 *
 * ST drops only lines of length zero. A message with CRLF endings splits on
 * "\n" into lines still carrying their "\r", so every paragraph break becomes a
 * one-character line that survives that test and renders as a blank paragraph —
 * a row in the panel, a unit to direct, and a clip of nothing to generate.
 * Lines of spaces and of zero-width characters do the same.
 *
 * Skipping them makes our paragraph numbering diverge from ST's line numbering,
 * which costs nothing: the player addresses paragraphs through an explicit hint,
 * and ST's own path finds them by matching text.
 */
function splitLines(mes) {
    return readableText(mes)
        .split('\n')
        .map(line => line.replace(BLANK_EDGES, ''))
        .filter(line => line && !isExcluded(line));
}

// Tag blocks can span lines, so they have to go before the text is split. The
// pattern is SillyTavern's own (tts/index.js:682), so that checking this box
// removes exactly what checking theirs would.
const TAG_BLOCK = /<.*?>[\s\S]*?<\/.*?>/g;

/** The message as it should be read aloud, with anything unspoken removed. */
function readableText(mes) {
    const text = String(mes ?? '');
    return settings().skip_tags ? text.replace(TAG_BLOCK, '') : text;
}

// Compiling per line would be wasteful — splitLines runs on every repaint — so
// the compiled set is kept until the setting text itself changes.
let compiledExclusions = { source: null, patterns: [] };

function exclusionPatterns() {
    const source = String(settings().exclusions ?? '');
    if (compiledExclusions.source === source) return compiledExclusions.patterns;

    const patterns = [];
    for (const line of source.split('\n')) {
        const pattern = line.trim();
        if (!pattern) continue;
        try {
            patterns.push(new RegExp(pattern));
        } catch (error) {
            // One bad pattern must not silence the rest, or the whole message.
            console.warn(`[Breeze Director] ignoring invalid exclusion /${pattern}/:`, error.message);
        }
    }

    compiledExclusions = { source, patterns };
    return patterns;
}

/** Is this line page furniture rather than something to read aloud? */
function isExcluded(line) {
    return exclusionPatterns().some(pattern => pattern.test(line));
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

/**
 * Is this quote attributed to an actual someone?
 *
 * The message's own character and the user count: they speak as much as anyone
 * else, and casting them means their dialogue gets a voice of its own rather
 * than falling back to whatever the voice map happens to say.
 *
 * They also override the placeholder list, because a character really can be
 * called Narrator — as one of these chats has — and dropping them as a
 * placeholder would leave the person doing most of the talking uncast.
 */
function isNamedSpeaker(speaker, message) {
    const name = String(speaker ?? '').trim().toLowerCase();
    if (!name) return false;

    const context = ctx();
    const known = [message?.name, context.name1, context.name2]
        .map(value => String(value ?? '').trim().toLowerCase())
        .filter(Boolean);
    if (known.includes(name)) return true;

    return !GENERIC_SPEAKERS.has(name);
}

/** A base voice's preset. Null rather than throwing: the voices JSON is hand-edited. */
function basePreset(name) {
    if (!name) return null;
    try {
        return globalThis.breezeTts?.voicePreset(name) ?? null;
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
    const breeze = globalThis.breezeTts;
    if (segment?.kind !== 'dialogue') return defaultVoice(message);

    // A voice picked by hand in the panel wins outright.
    if (segment.voice && breeze?.hasVoice(segment.voice)) return segment.voice;

    // Otherwise the speaker's cast entry names the base to speak through. This
    // is resolved at play time, not stored, so editing the cast reaches
    // messages already in the chat.
    const entry = castFor(segment.speaker);
    if (entry?.base && breeze?.hasVoice(entry.base)) return entry.base;

    return charVoice(message) ?? defaultVoice(message);
}

/**
 * The clips one paragraph plays, in order. Each carries a hint naming the
 * message and paragraph it came from, so the director returns that paragraph's
 * instruction outright instead of matching a fragment back to it.
 */
function clipsFor(message, line, messageId, paragraph) {
    const segments = line?.segments;
    if (!segments?.length) {
        return [{
            text: line?.text ?? '',
            voice: defaultVoice(message),
            speaker: null,
            hint: { messageId, paragraph, speaker: null },
        }];
    }
    return segments.map(segment => {
        const speaker = segment.kind === 'dialogue' ? (segment.speaker || null) : null;
        return {
            text: segment.text,
            voice: voiceForSegment(segment, message),
            speaker,
            // The speaker rides along so the director can lay their voice
            // description over the paragraph's delivery direction.
            hint: { messageId, paragraph, speaker },
        };
    });
}

// Strips quote marks so a segment matches the paragraph it came from. Asterisks
// stay: in plaintext they are content, not markup.
const normalize = s => String(s ?? '').replace(/["'`\u201C\u201D\u00AB\u00BB]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

// ------------------------------------------------------------------- skipping
// Paragraphs the reader has unchecked. Kept on the message rather than on a
// take, so regenerating direction or restoring an earlier take leaves the
// choice alone — it is about the text, not about how the text is read.

/** Paragraph indices excluded from playback. */
function skipped(message) {
    return new Set(message?.extra?.breeze_skip ?? []);
}

function isSkipped(message, paragraph) {
    return skipped(message).has(paragraph);
}

/** Include or exclude a paragraph, and persist it with the chat. */
async function setSkipped(message, paragraph, skip) {
    const set = skipped(message);
    if (skip) set.add(paragraph);
    else set.delete(paragraph);

    message.extra = message.extra ?? {};
    if (set.size) message.extra.breeze_skip = [...set].sort((a, b) => a - b);
    else delete message.extra.breeze_skip;

    await ctx().saveChat();
}

/** Stored direction, but only if it still belongs to the current swipe. */
function getDirection(message) {
    const stored = message?.extra?.breeze_direction;
    if (!stored) return null;
    if ((stored.swipe_id ?? 0) !== (message.swipe_id ?? 0)) return null;

    // Paragraphs are addressed by index, so a take with a different number of
    // them belongs to different text — an edited message, or an exclusion or tag
    // setting changed since. Regenerating beats reading paragraph four's
    // direction over paragraph three.
    if ((stored.lines?.length ?? 0) !== splitLines(message.mes).length) return null;

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
                    // Everyone named is cast, the character and the user
                    // included. Which base they speak through is resolved at
                    // play time from the cast, so editing it reaches messages
                    // already in the chat.
                    if (isNamedSpeaker(speaker, message)) await castVoice(speaker, quotes);
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

/** A take that says nothing: every paragraph present, every instruction empty. */
function isBlank(direction) {
    return !!direction?.lines?.length
        && direction.lines.every(line => !String(line?.instruction ?? '').trim());
}

/**
 * Write an empty take, with no model call at all.
 *
 * A message with no take is not the same thing as a message told to be read
 * plainly: the first still runs the director the moment `on_missing` is
 * `generate`, and audio cached before that happens is audio thrown away. An
 * empty take settles the question — every paragraph is present, every
 * instruction is blank, so the lines are read with nothing but the voice's own
 * preset behind them and the clips cached against that keep matching.
 *
 * Any cast the previous take carried is kept where the text still lines up:
 * segments say who speaks, which is not delivery direction and is not what
 * blanking a take is asking to throw away.
 */
async function blankTake(index) {
    const message = ctx().chat?.[index];
    if (!message) return null;

    const units = buildUnits(message.mes);
    if (!units.length) return null;

    const previous = getDirection(message);
    if (isBlank(previous)) return previous;   // already blank; don't churn history

    const lines = units.map((unit, i) => {
        const line = { text: unit.text, instruction: '' };
        const carried = previous?.lines?.[i];
        if (carried?.segments?.length && normalize(carried.text) === normalize(unit.text)) {
            line.segments = carried.segments;
        }
        return line;
    });

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

    await ctx().saveChat();
    markButton(index);
    return message.extra.breeze_direction;
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

    // A clone base already fixes the voice; describing it again only fights the
    // reference audio, so identity words are dropped for one.
    const cloned = !!(preset?.ref_audio_url && preset?.ref_text);
    const cast = castFor(hint?.speaker);
    const voiceLine = cast ? voiceInstruction(cast, cloned) : '';

    // A hint names the paragraph outright; locate() only guesses from the text.
    const index = Number.isInteger(hint?.messageId) ? hint.messageId : locate(text);
    const message = ctx().chat?.[index];

    let line = '';
    if (message) {
        // If a precompute is still running for this message, wait for it rather
        // than firing a second call or silently falling back.
        if (inFlight.has(index)) await inFlight.get(index);

        let direction = getDirection(message);
        if (!direction && config.on_missing === 'generate') {
            await run(index);
            direction = getDirection(message);
        }
        if (direction) {
            line = (Number.isInteger(hint?.paragraph)
                ? direction.lines[hint.paragraph]?.instruction
                : pickLine(direction, text)) ?? '';
        }
    }

    // The base's own instruction is the user's description of that voice. A cast
    // member's description supersedes it, being about someone specific — but
    // only if there is one. With nothing said about the speaker, dropping it
    // would leave them sounding like nobody at all rather than like their base.
    const carried = (config.mode === 'append' || !voiceLine) ? (preset?.instruction ?? '') : '';
    const instruction = [carried, voiceLine, line].map(part => String(part ?? '').trim())
        .filter(Boolean).join(' ');
    if (!instruction) return null;

    // A base the user maintains carries its own cfg_scale; respect it.
    return { instruction, cfg_scale: preset?.cfg_scale ?? Number(config.cfg_scale) };
};

/**
 * What pre-generation would send for a message, without sending anything.
 *
 * `await breezeExplain()` in the console, for the last message, or with an
 * index. One row per clip: the voice, the instruction actually composed, and
 * whether it is already cached. Silence has several causes that look identical
 * from the outside — no voice, an empty instruction, a clip already cached —
 * and this is the one place that tells them apart line by line.
 */
globalThis.breezeExplain = async function (index = (ctx().chat?.length ?? 1) - 1) {
    const breeze = globalThis.breezeTts;
    const message = ctx().chat?.[index];
    if (!message) return 'No such message.';
    if (!breeze?.available) return 'The Breeze provider is not bound.';

    const direction = getDirection(message);
    const units = buildUnits(message.mes);
    const excluded = skipped(message);
    const take = direction ? (isBlank(direction) ? 'blank' : 'directed') : 'none';

    const rows = [];
    for (let i = 0; i < units.length; i++) {
        for (const clip of clipsFor(message, direction?.lines?.[i] ?? units[i], index, i)) {
            const plan = clip.voice ? await breeze.explain(clip.text, clip.voice, clip.hint) : null;
            rows.push({
                paragraph: i + 1,
                take,
                skipped: excluded.has(i),
                who: clip.speaker ?? 'narration',
                voice: clip.voice ?? '(none assigned)',
                instruction: plan?.instruction ?? '(no voice, so nothing planned)',
                cfg: plan?.cfgScale ?? null,
                cached: plan ? await breeze.isCached(plan.key) : false,
                text: clip.text.slice(0, 48),
            });
        }
    }
    console.table(rows);
    return rows;
};

/** The character card for a name, matched forgivingly — the model supplies it. */
function cardFor(name) {
    const wanted = String(name ?? '').trim().toLowerCase();
    if (!wanted) return null;
    return (ctx().characters ?? [])
        .find(card => String(card?.name ?? '').trim().toLowerCase() === wanted) ?? null;
}

/**
 * What a character card says about who someone is.
 *
 * Reads the v1 fields and the v2 `data` ones, as SillyTavern itself does
 * (`slash-commands.js:5541`); a card written to the v2 spec leaves the top-level
 * fields empty, and reading only those found nothing to describe them with.
 */
function cardText(name) {
    const card = cardFor(name);
    if (!card) return '';

    const data = card.data ?? {};
    return [
        card.description || data.description,
        card.personality || data.personality,
    ].map(value => String(value ?? '').trim()).filter(Boolean).join('\n\n');
}

// -------------------------------------------------------------- cast storage
// A speaker keeps one voice for a whole chat: re-picking per message would make
// the same stranger sound like a different person every paragraph. The casting
// itself is further down, after identification, which has to run first.

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

// Roughly twice what the prompt asks for. Not enforced — truncating someone's
// voice mid-phrase is worse than a long one — but worth saying out loud, since a
// sprawling tone reaches Breeze as a sprawling instruction and reads as one.
const TONE_WORD_LIMIT = 30;

function cleanProfile(raw) {
    const profile = {};
    for (const field of PROFILE_FIELDS) {
        const value = String(raw?.[field] ?? '').trim();
        if (value && value.toLowerCase() !== 'unknown') profile[field] = value;
    }

    const words = profile.tone ? profile.tone.split(/\s+/).length : 0;
    if (words > TONE_WORD_LIMIT) {
        console.warn(`[Breeze Director] a ${words}-word tone came back where 15 were `
            + 'asked for; Breeze follows a short instruction more closely. '
            + 'Shorten it in the voice cast, or tighten the casting prompt.', profile.tone);
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

/**
 * Cast entries have been three shapes. The oldest was a bare voice name, the
 * next carried a derived `voice` this extension had written into the provider.
 * Both are read as a base to build on: the provider's voices are the user's to
 * manage, and nothing here writes to them.
 */
function castEntry(value) {
    if (!value) return null;
    if (typeof value === 'string') return { base: value };
    if (!value.base && value.voice) return { ...value, base: value.voice };
    return value;
}

/** The cast entry for a speaker in the current chat, if there is one. */
function castFor(speaker) {
    if (!speaker) return null;
    return castEntry(settings().cast?.[currentChatId()]?.[speaker]);
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

/** Has anything been said about how this speaker sounds? */
function hasProfile(entry) {
    return PROFILE_FIELDS.some(field => entry?.[field]);
}

/** What Breeze will be told for this cast member, for the sheet to show. */
function castInstruction(entry) {
    const inherited = basePreset(entry.base);
    const cloned = !!(inherited?.ref_audio_url && inherited?.ref_text);
    return voiceInstruction(entry, cloned);
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

/** Ask the director for this speaker's voice: a base to build on, and a description. */
async function askCasting(speaker, quotes, base = null) {
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
            return `- ${who} → base ${entry.base}`;
        })
        .join('\n');

    const known = [];

    // The card is the best evidence there is about how someone sounds, and for
    // the chat's own character it is usually the only evidence, since their
    // lines are being read by the narrator rather than described.
    const description = cardText(speaker);
    if (description) known.push(`Their character description:\n${description}`);
    else console.info(`[Breeze Director] no character card for "${speaker}"; `
        + 'casting from their lines alone.');

    // When the base is already settled, say so: the description should fit the
    // voice they will actually speak through.
    if (base) known.push(`They already speak through the voice "${base}". Reply with that `
        + 'same base, and describe them in a way that suits it.');

    let prompt = put(config.voice_cast_prompt, /{{speaker}}/g, speaker);
    prompt = put(prompt, /{{context}}/g, known.length ? `\n${known.join('\n\n')}\n` : '');
    prompt = put(prompt, /{{lines}}/g, spoken || '(none recorded)');
    prompt = put(prompt, /{{voices}}/g, available.map(name => `- ${name}`).join('\n'));
    prompt = put(prompt, /{{cast}}/g, roster ? put(CAST_BLOCK, /{{list}}/g, roster) : '');

    const parsed = await askJson('casting', prompt, 400);
    if (!parsed) return null;

    // The model may quote the name or wrap it in a sentence; match generously.
    const wanted = String(parsed.base ?? '').trim().toLowerCase();
    const chosen = available.find(name => name.toLowerCase() === wanted)
        ?? available.find(name => wanted.includes(name.toLowerCase()))
        ?? null;

    return { base: chosen, profile: cleanProfile(parsed) };
}

/**
 * Settle which base a foreign speaker speaks through, and record them on the
 * cast sheet. A sheet edit pins the entry and wins outright; otherwise a
 * hand-assigned voice-map entry wins; otherwise the director picks one. Never
 * throws — the caller falls back to the default voice.
 */
async function castVoice(speaker, quotes = []) {
    const breeze = globalThis.breezeTts;
    if (!breeze?.available) return null;

    // Record them first: whatever happens next, they belong on the sheet.
    const entry = rememberSpeaker(speaker);
    const settle = (base) => {
        ctx().saveSettingsDebounced();
        onCastChanged?.();
        return base;
    };

    // An edit in the cast sheet pins the entry. A bare pre-stage — a name with
    // nothing on it yet — is the one thing still worth filling in.
    if (entry.pinned && (entry.base || hasProfile(entry))) return settle(entry.base);

    // A voice-map entry settles which voice they speak through, but says nothing
    // about how they sound, so it fills the base and casting still runs for the
    // description. Only an explicit assignment counts: SillyTavern marks every
    // character [Default Voice] until someone chooses, and taking that as a
    // choice pinned every character to whatever the default pointed at — which
    // is what made the director look like it always picked the same base.
    const mapped = breeze.assignedVoice(speaker);
    if (mapped && !entry.base) {
        entry.base = mapped;
        entry.source = 'voicemap';
    }

    // Already described: nothing left to decide.
    if (entry.base && breeze.hasVoice(entry.base) && hasProfile(entry)) {
        return settle(entry.base);
    }

    if (castJobs.has(speaker)) return castJobs.get(speaker);

    const pending = (async () => {
        const casting = await askCasting(speaker, quotes, entry.base);
        // A base already chosen — by the voice map or by hand — outranks the
        // model's; it only fills a gap.
        if (casting?.base && !entry.base) {
            entry.base = casting.base;
            delete entry.source;
        }
        for (const field of PROFILE_FIELDS) {
            if (!entry[field] && casting?.profile?.[field]) entry[field] = casting.profile[field];
        }
        return entry.base;
    })()
        .then(base => {
            if (base) {
                console.info(`[Breeze Director] cast ${speaker} on base "${base}": `
                    + (castInstruction(entry) || '(no description)'));
                toastr.info(`Cast ${speaker} on "${base}".`, 'Breeze Director');
            } else {
                console.info(`[Breeze Director] ${speaker} is on the cast sheet `
                    + 'with no base yet — give them one there.');
            }
            return settle(base);
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
        if (!isNamedSpeaker(quote.speaker, message) || cast.includes(quote.speaker)) continue;
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

/**
 * Generate every clip for a message ahead of playback, sequentially. Returns how
 * many were produced, which is what the pre-generate button and command report.
 *
 * `from` starts partway down a long message, so a run interrupted three
 * paragraphs in can be picked up where it stopped rather than from the top.
 */
async function prefetchReport(index, { from = 0 } = {}) {
    const report = {
        made: 0, cached: 0, failed: 0, voiceless: 0, skipped: 0, paragraphs: 0,
        reason: null,
    };
    const breeze = globalThis.breezeTts;
    const message = ctx().chat?.[index];
    if (!message) { report.reason = 'no-message'; return report; }
    if (!breeze?.available) { report.reason = 'no-provider'; return report; }

    const direction = getDirection(message);
    const units = buildUnits(message.mes);
    const excluded = skipped(message);
    report.paragraphs = units.length;

    for (let i = Math.max(0, from); i < units.length; i++) {
        if (excluded.has(i)) { report.skipped++; continue; }
        for (const clip of clipsFor(message, direction?.lines?.[i] ?? units[i], index, i)) {
            if (!clip.voice) { report.voiceless++; continue; }

            const outcome = await breeze.prefetch(clip.text, clip.voice, clip.hint);
            if (outcome === 'cached') report.cached++;
            else if (outcome === 'cache-off') report.reason = 'cache-off';
            else if (outcome) report.made++;
            else report.failed++;
        }
    }

    // Pre-generation that produces nothing looks identical from the outside
    // whatever the cause, so say which one it was every time.
    console.info(`[Breeze Director] pre-generated message ${index}`
        + ` from paragraph ${Math.max(0, from) + 1}:`, report);
    return report;
}

/** How many clips were generated — what the pre-generate command reports. */
async function prefetchMessage(index, options) {
    return (await prefetchReport(index, options)).made;
}

/**
 * Everything a message needs to play later, generated now and left in the cache.
 *
 * Direction comes first even when only audio was asked for: a clip is cached
 * against the instruction it was generated under, so audio made before the
 * direction exists is audio that has to be thrown away and made again.
 *
 * `blank` is the other way of settling that: write an empty take instead of
 * asking the model for one, and cache the audio the voice makes on its own.
 */
async function pregenerateReport(index, { quiet = true, blank = false, from = 0 } = {}) {
    const message = ctx().chat?.[index];
    if (!message) return { made: 0, reason: 'no-message' };

    if (blank) await blankTake(index);
    else if (settings().enabled && !hasDirection(index)) await run(index, { quiet });
    return prefetchReport(index, { from });
}

/** How many clips were generated — what `/breeze-audio` returns. */
async function pregenerate(index, options) {
    return (await pregenerateReport(index, options)).made;
}

/** Everything that should happen before narration starts. */
async function prepare(index) {
    const config = settings();
    if (!config.enabled) return;

    const message = ctx().chat?.[index];
    if (!message) return;

    if (config.auto && !hasDirection(index)) await run(index);
    if (config.prefetch) await prefetchMessage(index);
}

// ----------------------------------------------------------- message buttons

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
    return `${currentChatId()}:${messageId}`;
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
        const excluded = skipped(message);
        this.units = buildUnits(message.mes).map((unit, i) => ({
            text: unit.text,
            // An unchecked paragraph has nothing to play; playAt() and
            // nextPosition() already step over a unit with no clips.
            clips: excluded.has(i)
                ? []
                : clipsFor(message, direction?.lines?.[i] ?? unit, messageId, i).filter(c => c.voice),
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
    const pregenButton = button('fa-cloud-arrow-down',
        'Generate this message\'s audio now, ready for later', () => pregenerateFrom(messageId));
    const blankButton = button('fa-eraser',
        'Blank the take: clear every instruction, no model call, old take kept in the history',
        () => blankFrom(messageId));
    const expandButton = button('fa-chevron-down', 'Expand or collapse every paragraph', () => toggleAll(messageId));
    const dropButton = button('fa-xmark', 'Delete the take shown here', () => deleteTake(messageId));
    const eraseButton = button('fa-trash', 'Erase cached audio for this message', () => eraseClips(messageId));

    bar.append(playButton, prevButton, nextButton, stopButton, regenButton, pregenButton,
        blankButton, expandButton, takes, dropButton, eraseButton);
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
        // Nothing to show a take of, and nothing to delete either.
        dropButton.style.opacity = direction ? '' : '0.4';
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
        current.textContent = `Current — ${stamp(direction.ts)}${isBlank(direction) ? ' (blank)' : ''}`;
        takes.append(current);
        (direction.history ?? []).forEach((take, i) => {
            const option = document.createElement('option');
            option.value = String(i + 1);
            option.textContent = `Take ${direction.history.length - i} — ${stamp(take.ts)}`
                + (isBlank(take) ? ' (blank)' : '');
            takes.append(option);
        });
        takes.value = String(viewing);
    }

    function repaint(state = 'ready', playingIndex = -1) {
        const units = buildUnits(message.mes);
        const lines = takeLines();
        const editable = viewing === 0;
        const excluded = skipped(message);

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

            // Checked means read aloud. Everything starts checked; unchecking
            // is how a paragraph is left out of playback without editing it.
            const include = document.createElement('input');
            include.type = 'checkbox';
            include.checked = !excluded.has(i);
            include.title = include.checked
                ? 'Read this paragraph aloud'
                : 'Skipped — not read aloud';
            include.style.cssText = 'margin:0.35em 0 0 0;flex:0 0 auto;cursor:pointer;';
            include.addEventListener('click', event => event.stopPropagation());
            include.addEventListener('change', async () => {
                await setSkipped(message, i, !include.checked);
                // Reload if this message is on air, so the change takes effect
                // without having to stop and start again.
                if (player.messageId === messageId) await player.load(messageId);
                repaint(state, playingIndex);
            });

            const chevron = document.createElement('div');
            chevron.className = `fa-solid ${expanded.has(i) ? 'fa-chevron-down' : 'fa-chevron-right'}`;
            chevron.style.cssText = 'opacity:0.6;padding-top:0.25em;min-width:1em;';

            const text = document.createElement('div');
            text.style.cssText = 'flex:1;min-width:0;';
            text.textContent = unit.text;
            if (!expanded.has(i)) {
                text.style.cssText += 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
            }
            if (excluded.has(i)) {
                text.style.opacity = '0.45';
                text.style.textDecoration = 'line-through';
            }
            if (i === playingIndex) text.style.fontWeight = 'bold';

            const playOne = document.createElement('div');
            playOne.className = 'fa-solid fa-play';
            playOne.title = 'Play from here';
            playOne.style.cssText = 'opacity:0.6;padding-top:0.25em;cursor:pointer;';
            playOne.addEventListener('click', async event => {
                event.stopPropagation();
                // Asking for a skipped paragraph is asking to hear it, so put it
                // back rather than starting at the next one that is included.
                if (excluded.has(i)) {
                    await setSkipped(message, i, false);
                    repaint(state, playingIndex);
                }
                playFrom(messageId, i);
            });

            // Pre-generating from a paragraph rather than from the top: a long
            // message interrupted partway need not pay for its first half twice.
            const pregenOne = document.createElement('div');
            pregenOne.className = 'fa-solid fa-cloud-arrow-down';
            pregenOne.title = 'Generate audio from this paragraph on';
            pregenOne.style.cssText = 'opacity:0.6;padding-top:0.25em;cursor:pointer;';
            pregenOne.addEventListener('click', async event => {
                event.stopPropagation();
                await pregenerateFrom(messageId, { from: i });
            });

            headRow.append(include, chevron, text, pregenOne, playOne);
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
                    : excluded.size
                    ? `${units.length} paragraphs, ${excluded.size} skipped`
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

/**
 * Say what a pre-generation run actually did.
 *
 * Every one of these used to read "nothing new to generate — it is already
 * cached", including the cases where that was untrue: no provider bound, the
 * clip cache switched off, no voice for the speaker, the server refusing. A run
 * that makes no sound is the one that most needs to say why.
 */
function announce(report, from) {
    const where = from > 0 ? ` from paragraph ${from + 1}` : '';
    const clips = n => `${n} clip${n === 1 ? '' : 's'}`;

    if (report.reason === 'no-provider') {
        return toastr.error(
            'The Breeze TTS provider is not bound. Pick "Breeze" in the TTS extension.',
            'Breeze',
        );
    }
    if (report.reason === 'cache-off') {
        return toastr.warning(
            'Pre-generation has nowhere to put the audio: turn the clip cache back on '
            + 'in the Breeze provider settings.',
            'Breeze',
        );
    }
    if (report.made) {
        const also = report.cached ? `, ${clips(report.cached)} already cached` : '';
        return toastr.success(`Generated ${clips(report.made)}${where}${also}, ready to play.`, 'Breeze');
    }
    if (report.failed) {
        return toastr.error(
            `${clips(report.failed)} failed to generate — see the console for what Breeze said.`,
            'Breeze',
        );
    }
    if (report.cached) {
        return toastr.info(`Nothing to do${where}: ${clips(report.cached)} already cached.`, 'Breeze');
    }
    if (report.voiceless) {
        return toastr.warning(
            `No Breeze voice for ${report.voiceless} of these lines — assign one in the voice map, `
            + 'or set a narrator voice in the director settings.',
            'Breeze',
        );
    }
    if (report.skipped) {
        return toastr.info(`Every paragraph${where} is unchecked, so none was generated.`, 'Breeze');
    }
    return toastr.info(`Nothing to read${where}.`, 'Breeze');
}

/**
 * Generate a message's audio up front, leaving it cached rather than playing it.
 *
 * `from` is the paragraph to start at — the panel passes the row that was
 * clicked — and `blank` says to settle the direction by emptying it rather than
 * by asking the model.
 */
async function pregenerateFrom(messageId, { from = 0, blank = false } = {}) {
    const entry = panels.get(messageId);
    // The row icons carry the same class as the toolbar button; querySelector
    // returns the toolbar one, which is where a whole-message job belongs.
    const icon = entry?.root.querySelector('.fa-cloud-arrow-down');
    icon?.classList.add('fa-spin');
    try {
        const report = await pregenerateReport(messageId, { quiet: false, from, blank });

        // Pre-generation can settle the direction on its own — by writing one or
        // by blanking it — so the panel may be holding a take that no longer exists.
        if (entry) {
            const fresh = getDirection(ctx().chat?.[messageId]);
            if (fresh !== entry.direction) {
                entry.direction = fresh;
                entry.viewing = 0;
                entry.refreshTakes();
            }
            entry.repaint();
        }
        announce(report, from);
    } catch (error) {
        console.error('[Breeze Director] pre-generation failed:', error);
        toastr.error(String(error?.message ?? error), 'Breeze');
    } finally {
        icon?.classList.remove('fa-spin');
    }
}

/**
 * A take change reaches what is already on air only if the player rebuilds its
 * units from it — paragraphs and their clips come from the take's segments — so
 * a message being read is reloaded, as unchecking a paragraph does. A reload
 * that fails is not worth losing the change over; it is logged and left.
 */
async function reloadIfPlaying(messageId) {
    if (player.messageId !== messageId) return;
    try {
        await player.load(messageId);
    } catch (error) {
        console.warn('[Breeze Player] could not reload after a take changed:', error);
    }
}

/**
 * Empty this message's take, so it is read with nothing but the voice's own
 * preset behind it. Audio is not generated here: which paragraph to start from
 * is the reader's call, and the row and toolbar cloud buttons ask it.
 */
async function blankFrom(messageId) {
    const entry = panels.get(messageId);
    const icon = entry?.root.querySelector('.fa-eraser');
    icon?.classList.add('fa-spin');
    try {
        const direction = await blankTake(messageId);
        if (!direction) return toastr.info('Nothing to blank.', 'Breeze Director');

        if (entry) {
            entry.direction = direction;
            entry.viewing = 0;
            entry.refreshTakes();
            entry.repaint();
        }
        await reloadIfPlaying(messageId);
        toastr.success(
            'Take blanked. Use the cloud button for the whole message, '
            + 'or a paragraph\'s own to start there.',
            'Breeze Director',
        );
    } catch (error) {
        console.error('[Breeze Director] blanking failed:', error);
        toastr.error(String(error?.message ?? error), 'Breeze Director');
    } finally {
        icon?.classList.remove('fa-spin');
    }
}

/**
 * Drop the take the panel is showing.
 *
 * A take from the history is simply removed. Deleting the current one promotes
 * the newest take behind it, so the undo path the history exists for still
 * works; with nothing behind it the message goes back to having no direction at
 * all, which is a real state — it is what a message starts in.
 */
async function deleteTake(messageId) {
    const context = ctx();
    const entry = panels.get(messageId);
    const message = context.chat?.[messageId];
    const direction = entry?.direction;
    if (!entry || !message || !direction) return;

    const at = entry.viewing;
    const history = direction.history ?? [];
    const label = at === 0
        ? (history.length ? 'Delete the current take and go back to the one before it?'
            : 'Delete the current take? This message has no earlier one, so it will be '
              + 'left with no direction.')
        : `Delete take ${history.length - (at - 1)}?`;

    const confirmed = await context.callGenericPopup(label, context.POPUP_TYPE.CONFIRM);
    if (!confirmed) return;

    if (at > 0) {
        history.splice(at - 1, 1);
        direction.history = history;
        message.extra.breeze_direction = direction;
    } else if (history.length) {
        const previous = history.shift();
        direction.lines = previous.lines;
        direction.ts = previous.ts ?? Date.now();
        direction.history = history;
        message.extra.breeze_direction = direction;
    } else {
        delete message.extra.breeze_direction;
        entry.direction = null;
    }

    await context.saveChat();
    markButton(messageId);

    await reloadIfPlaying(messageId);

    entry.viewing = 0;
    entry.refreshTakes();
    entry.repaint();
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
    const chatId = currentChatId();
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
    note.textContent = 'Each speaker speaks through one of your Breeze voices, under a '
        + 'description of their own. Nothing here changes the Breeze voices themselves — '
        + 'those are yours to manage. Changes are saved as you make them.';
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

            const voiced = !!entry.base && breeze.hasVoice(entry.base);
            const voice = document.createElement('small');
            voice.style.cssText = 'opacity:0.6;flex:0 0 auto;';
            voice.textContent = voiced
                ? (entry.source === 'voicemap' ? 'from voice map' : 'ready')
                : (entry.base ? `base "${entry.base}" is missing` : 'no base yet');

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
                    return toastr.info('Pick a base voice for them first.', 'Breeze Director');
                }
                try {
                    // Composed on the fly: nothing about this member is stored
                    // in the provider's voices, which are yours to manage.
                    await breeze.previewWith(
                        entry.base,
                        castInstruction(entry),
                        basePreset(entry.base)?.cfg_scale ?? Number(settings().cfg_scale),
                    );
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
            const instruction = castInstruction(entry);
            built.textContent = instruction
                ? `Breeze hears: ${instruction}`
                : entry.base
                    ? `Reads as "${entry.base}" is written. Describe them to set them apart.`
                    : 'Nothing to send yet — pick a base voice or describe their tone.';
            row.append(built);

            list.append(row);
        }
    }

    /**
     * Record an edit. Nothing is written to the provider — a cast member is a
     * base plus a description, composed when a line is generated. Editing pins
     * the entry, so a hand-assigned voice-map entry no longer overrides it: the
     * edit was an explicit choice and should stick.
     */
    function rederive(speaker, entry) {
        entry.pinned = true;
        delete entry.source;
        onCastChanged?.();
    }

    paint();
    // .popup-content is overflow:hidden unless the popup opts in, so without
    // allowVerticalScrolling a cast longer than the dialog is simply unreachable.
    await context.callGenericPopup(wrapper, context.POPUP_TYPE.DISPLAY, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });
}

// ---------------------------------------------------------------- STscript
// Everything the wand menu and the message panel can do, minus the playing.

/**
 * Which message a command means. No argument is the last message; a negative
 * one counts back from the end, as SillyTavern's own commands allow.
 */
function targetMessage(value) {
    const chat = ctx().chat ?? [];
    if (!chat.length) return -1;

    // Test for emptiness before converting: Number('') is 0, which would make a
    // command with no argument silently target the very first message.
    const raw = String(value ?? '').trim();
    if (!raw) return chat.length - 1;

    const asked = Number(raw);
    if (!Number.isInteger(asked)) return chat.length - 1;

    const index = asked < 0 ? chat.length + asked : asked;
    return (index >= 0 && index < chat.length) ? index : -1;
}

/** STscript has no booleans; a named flag arrives as whatever was typed. */
function isOn(value) {
    return /^(?:true|1|on|yes)$/i.test(String(value ?? '').trim());
}

function registerSlashCommands() {
    const context = ctx();
    const {
        SlashCommandParser, SlashCommand, SlashCommandArgument,
        SlashCommandNamedArgument, ARGUMENT_TYPE,
    } = context;
    if (!SlashCommandParser?.addCommandObject || !SlashCommand?.fromProps) {
        console.warn('[Breeze Director] this SillyTavern has no slash command API; skipping.');
        return;
    }

    const add = (name, aliases, returns, help, act, named = []) => {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name,
            aliases,
            returns,
            namedArgumentList: named,
            unnamedArgumentList: [new SlashCommandArgument(
                'message id; negative counts back from the end, default the last message',
                [ARGUMENT_TYPE.NUMBER], false,
            )],
            helpString: help,
            callback: async (args, value) => {
                const index = targetMessage(value);
                if (index < 0) {
                    toastr.warning('No such message.', 'Breeze Director');
                    return '';
                }
                return String(await act(index, args ?? {}) ?? '');
            },
        }));
    };

    // Named arguments are optional everywhere here; a build without the class
    // simply gets the commands without their flags rather than no commands.
    const flag = (props) => (SlashCommandNamedArgument
        ? [new SlashCommandNamedArgument(props.name, props.description, props.typeList, false)]
        : []);

    add('breeze-direct', ['breezedirect'], 'number of paragraphs directed', `
        <div>Write delivery direction for a message, as the director does automatically.</div>
        <div>Replaces any existing take, keeping the old one in the message's history.</div>
        <div><strong>Example:</strong> <code>/breeze-direct</code> or <code>/breeze-direct -2</code></div>`,
    async (index) => (await run(index, { quiet: false }))?.lines?.length ?? 0);

    add('breeze-cast', ['breezecast'], 'names of the speakers cast', `
        <div>Work out who speaks each quoted line, and cast a voice for anyone new.</div>
        <div>Leaves the message's direction alone.</div>
        <div><strong>Example:</strong> <code>/breeze-cast</code></div>`,
    async (index) => (await castMessage(index)).join(', '));

    add('breeze-audio', ['breezeaudio', 'breezepregen'], 'number of clips generated', `
        <div>Generate a message's audio now and leave it cached, without playing it.</div>
        <div>Directs the message first if it has no direction, since a clip is cached
        against the instruction it was made under.</div>
        <div><code>blank=true</code> writes an empty take instead of calling the model,
        so the lines are read with nothing but the voice's own preset behind them.</div>
        <div><code>from=</code> starts at that paragraph, counting from 1, instead of
        at the top.</div>
        <div><strong>Example:</strong> <code>/breeze-audio</code>,
        <code>/breeze-audio blank=true</code>, or
        <code>/breeze-audio blank=true from=3 -2</code></div>`,
    (index, args) => pregenerate(index, {
        quiet: false,
        blank: isOn(args.blank),
        // Paragraphs are numbered from 1 in the panel; match that here.
        from: Math.max(0, (Number(args.from) || 1) - 1),
    }),
    [
        ...flag({ name: 'blank', description: 'write an empty take rather than calling the model', typeList: [ARGUMENT_TYPE.BOOLEAN] }),
        ...flag({ name: 'from', description: 'first paragraph to generate, counting from 1', typeList: [ARGUMENT_TYPE.NUMBER] }),
    ]);

    add('breeze-blank', ['breezeblank'], 'number of paragraphs blanked', `
        <div>Empty a message's take: every paragraph kept, every instruction cleared,
        no model call. The take it replaces stays in the message's history.</div>
        <div>Audio cached against a blank take keeps matching, since nothing will
        direct the message later.</div>
        <div><strong>Example:</strong> <code>/breeze-blank</code></div>`,
    async (index) => (await blankTake(index))?.lines?.length ?? 0);
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
      <label class="checkbox_label"><input id="bd_cast" type="checkbox"> Give quoted speech its own voice per speaker</label>
      <small>Click the masks icon on any message to view, generate, or edit its direction.</small>
      <small id="bd_paragraph_warn" style="color:var(--golden);display:block;"></small>

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

      <label class="checkbox_label"><input id="bd_skip_tags" type="checkbox"> Skip
      <code>&lt;tag&gt;…&lt;/tag&gt;</code> blocks, as SillyTavern's own TTS does</label>

      <label for="bd_exclusions">Never read lines matching (one regex per line):</label>
      <textarea id="bd_exclusions" class="text_pole textarea_compact" rows="3"></textarea>
      <input id="bd_exclusions_reset" class="menu_button" type="button" value="Reset exclusions">
      <small>Matched against the trimmed line. The default catches horizontal rules
      like <code>---</code>, which Breeze otherwise reads as a run of dashes.</small>

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

      <label for="bd_voice_cast_prompt">Voice casting prompt (<code>{{speaker}}</code>,
      <code>{{card}}</code>, <code>{{lines}}</code>, <code>{{voices}}</code>,
      <code>{{cast}}</code>):</label>
      <textarea id="bd_voice_cast_prompt" class="text_pole textarea_compact" rows="10"></textarea>
      <input id="bd_voice_cast_reset" class="menu_button" type="button" value="Reset casting prompt">
      <small id="bd_cast_prompt_warn" style="color:var(--golden);display:block;"></small>

      <hr>
      <b>Cast for this chat</b>
      <small>Each speaker the director names is given one of your Breeze voices as a
      base, plus a description of their own. Breeze's own voices are never modified.</small>
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
    checkbox('#bd_cast', 'cast_enabled');
    field('#bd_missing', 'on_missing');
    field('#bd_mode', 'mode');
    field('#bd_cfg', 'cfg_scale', Number);
    field('#bd_tokens', 'max_tokens', Number);
    field('#bd_identify_chunk', 'identify_chunk', Number);
    field('#bd_exclusions', 'exclusions');
    checkbox('#bd_skip_tags', 'skip_tags');
    field('#bd_identify_prompt', 'identify_prompt');
    field('#bd_prompt', 'prompt');
    field('#bd_voice_cast_prompt', 'voice_cast_prompt');

    // Two silent-failure modes worth naming: a saved prompt from before casting
    // never returns speakers, and with ST's own paragraph narration off it hands
    // the provider the whole message as one job.
    const warn = () => {
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

    $('#bd_exclusions_reset').on('click', () => {
        config.exclusions = DEFAULT_EXCLUSIONS;
        $('#bd_exclusions').val(DEFAULT_EXCLUSIONS);
        save();
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
        <div id="breezeVoiceCast" class="list-group-item flex-container flexGap5" title="Voices cast in this chat">
            <div class="extensionsMenuExtensionButton fa-solid fa-users"></div>
            <span>Voice cast</span>
        </div>`);
    $('#breezeVoiceCast').on('click', openCastSheet);

    // Registering twice throws, which would abort the rest of this handler.
    try {
        registerSlashCommands();
    } catch (error) {
        console.error('[Breeze Director] could not register slash commands:', error);
    }

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
        castJobs.clear();
        onCastChanged?.();
        player.stop();
        closeAllPanels();
        addButtons();
    });
});
