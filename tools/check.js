// Check the extension outside a browser:
//
//     gjs tools/check.js index.js
//
// Two phases.
//
// 1. Load. Runs index.js under minimal stubs for the browser and SillyTavern
//    globals it touches, then its jQuery ready handler. This catches the
//    failure that is otherwise invisible until the extension silently vanishes
//    from the UI: anything throwing at module eval or inside bind() aborts the
//    rest of the file, so no settings panel, no buttons, no listeners. A syntax
//    check will not catch it — a missing top-level const parses fine.
//
// 2. Assert. Exercises the pure logic against the file as actually loaded,
//    rather than against blocks copied out of it.
//

const GLib = imports.gi.GLib;

function el() {
    return {
        style: { cssText: '', setProperty() {} },
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        append() {}, appendChild() {}, addEventListener() {}, remove() {},
        querySelector: () => el(), querySelectorAll: () => [],
        textContent: '', innerHTML: '', value: '', className: '', title: '',
        rows: 0, placeholder: '', readOnly: false, disabled: false, hidden: false,
    };
}

let readyFn = null;
function jq(arg) {
    if (typeof arg === 'function') { readyFn = arg; return undefined; }
    const o = {
        length: 1,
        append: () => o, prepend: () => o, on: () => o, off: () => o,
        prop: (k, v) => (v === undefined ? false : o),
        val: (v) => (v === undefined ? '' : o),
        text: (v) => (v === undefined ? '' : o),
        html: (v) => (v === undefined ? '' : o),
        css: () => o, attr: () => undefined, empty: () => o, remove: () => o,
        find: () => o, closest: () => o, each: () => o, replaceWith: () => o,
        addClass: () => o, removeClass: () => o, toggleClass: () => o, trigger: () => o,
    };
    return o;
}
jq.fn = {};

const context = {
    extensionSettings: {},
    chat: [], characters: [], name1: 'You', name2: 'Char',
    getCurrentChatId: () => 'chat-1',
    saveSettingsDebounced() {}, saveChat: async () => {},
    callGenericPopup: async () => true,
    POPUP_TYPE: { CONFIRM: 1 },
    eventSource: { on() {} },
    event_types: {
        CHARACTER_MESSAGE_RENDERED: 'a', USER_MESSAGE_RENDERED: 'b',
        MESSAGE_SWIPED: 'c', CHAT_CHANGED: 'd',
    },
    ConnectionManagerRequestService: {
        handleDropdown() {}, sendRequest: async () => ({ content: '' }),
    },
};

globalThis.$ = jq;
globalThis.jQuery = jq;
globalThis.document = { createElement: el, addEventListener() {} };
globalThis.toastr = { success() {}, info() {}, warning() {}, error() {} };
globalThis.SillyTavern = { getContext: () => context };
globalThis.Audio = function () {
    return {
        addEventListener() {}, pause() {}, removeAttribute() {},
        play: async () => {}, paused: true, playbackRate: 1, currentTime: 0, src: '',
    };
};
globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
globalThis.indexedDB = { open: () => ({}) };
globalThis.FormData = function () { return { append() {} }; };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), blob: async () => ({}) });

// Bindings the extension imports from SillyTavern's own tts extension. The
// import statement is stripped below, so these stand in as free variables.
let registeredProvider = null;
globalThis.registerTtsProvider = (name, cls) => { registeredProvider = { name, cls }; };
globalThis.getPreviewString = () => 'preview';
globalThis.saveTtsProviderSettings = () => {};
globalThis.initVoiceMap = async () => {};


const [, bytes] = GLib.file_get_contents(ARGV[0] || 'index.js');
// new Function() compiles a classic script body, which cannot hold imports.
// Stripping them leaves the imported names as free variables, stubbed above.
const source = new TextDecoder().decode(bytes)
    .replace(/^\s*import\s[^;]*;/gm, '');

try {
    // new Function() compiles a classic script body: syntax errors and
    // top-level ReferenceErrors both surface here.
    new Function(source)();
    print('eval          OK');
    print('provider      ' + (registeredProvider
        ? `registered as "${registeredProvider.name}"`
        : 'NOT REGISTERED'));
    if (!registeredProvider) throw new Error('provider never registered');
} catch (error) {
    print('eval          THREW: ' + error);
    print(String(error.stack || ''));
    imports.system.exit(1);
}

if (!readyFn) {
    print('ready handler NOT REGISTERED');
    imports.system.exit(1);
}

readyFn().then(
    () => {
        print('ready handler OK\n');
        runAssertions();
    },
    (error) => {
        print('ready handler THREW: ' + error);
        print(String(error.stack || '').split('\n').slice(0, 8).join('\n'));
        imports.system.exit(1);
    },
);

let fails = 0;
function eq(label, got, want) {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { print('  ok   ' + label); return; }
    fails++; print('  FAIL ' + label + '\n       got  ' + g + '\n       want ' + w);
}

function runAssertions() {
const api = new Function(source + `;return {
    splitSegments, collectQuotes, isForeignSpeaker, parseDirection,
    normalize, pickLine, castEntry, hash, syncPrompts,
    voiceInstruction, cleanProfile, PROFILE_FIELDS,
    extractJson, normalizeQuoteId,
    DEFAULT_PROMPT, DEFAULT_VOICE_CAST_PROMPT };`)();
const { splitSegments, collectQuotes, isForeignSpeaker, parseDirection,
        normalize, pickLine, castEntry, hash, syncPrompts,
        voiceInstruction, cleanProfile,
        extractJson, normalizeQuoteId } = api;


print('splitSegments');
eq('plain prose', splitSegments('He turned away.'), [{ text: 'He turned away.', kind: 'narration' }]);
eq('mixed', splitSegments('He turned. "I told you." The door slammed.'),
   [{ text: 'He turned.', kind: 'narration' }, { text: 'I told you.', kind: 'dialogue' },
    { text: 'The door slammed.', kind: 'narration' }]);
eq('asterisks are plain content', splitSegments('*she sighs* "Fine."'),
   [{ text: '*she sighs*', kind: 'narration' }, { text: 'Fine.', kind: 'dialogue' }]);
eq('stray asterisk survives', splitSegments('Worth 2 * 3 * 4 in total.'),
   [{ text: 'Worth 2 * 3 * 4 in total.', kind: 'narration' }]);
eq('curly quotes', splitSegments('“Go on,” he said.'),
   [{ text: 'Go on,', kind: 'dialogue' }, { text: 'he said.', kind: 'narration' }]);
eq('unbalanced quote', splitSegments('He said "wait'), [{ text: 'He said "wait', kind: 'narration' }]);
eq('blank line', splitSegments('   '), []);

print('collectQuotes');
eq('numbering', collectQuotes([splitSegments('A "one" B'), splitSegments('"two" C "three"')]),
   [{ id: 'Q1', paragraph: 0, at: 1, text: 'one' }, { id: 'Q2', paragraph: 1, at: 0, text: 'two' },
    { id: 'Q3', paragraph: 1, at: 2, text: 'three' }]);

print('isForeignSpeaker');
const msg = { name: 'Alice' };
eq('same char', isForeignSpeaker('alice', msg), false);
eq('unknown', isForeignSpeaker('unknown', msg), false);
eq('foreign', isForeignSpeaker('Bob', msg), true);

print('parseDirection');
eq('object form', parseDirection('{"directions":["a","b"],"speakers":{"Q1":"Bob"}}', 2),
   { instructions: ['a', 'b'], speakers: { Q1: 'Bob' } });
eq('legacy array', parseDirection('["a","b"]', 2), { instructions: ['a', 'b'], speakers: {} });
eq('padded', parseDirection('["a"]', 3), { instructions: ['a', 'a', 'a'], speakers: {} });
eq('empty', parseDirection('', 2), null);

print('normalize / pickLine');
eq('curly quotes stripped', normalize('“I told you.”'), 'i told you.');
eq('asterisk kept', normalize('2 * 3'), '2 * 3');
const dir = { lines: [{ text: 'He turned. "Yes." The door shut.', instruction: 'A' },
                      { text: 'Later, softly: "Yes."', instruction: 'B' }] };
eq('exact wins', pickLine(dir, 'Later, softly: "Yes."'), 'B');
eq('ambiguous takes longest', pickLine(dir, 'Yes.'), 'A');

print('castEntry');
eq('legacy string', castEntry('villain'), { voice: 'villain', base: null });
eq('object passes through',
   castEntry({ voice: 'bob', base: 'villain', gender: 'male', tone: 'Gruff.' }),
   { voice: 'bob', base: 'villain', gender: 'male', tone: 'Gruff.' });
eq('empty', castEntry(undefined), null);

print('cleanProfile');
eq('keeps filled fields', cleanProfile({ gender: 'male', age: ' 40s ', tone: 'Gruff.', accent: '' }),
   { gender: 'male', age: '40s', tone: 'Gruff.' });
eq('drops unknown', cleanProfile({ gender: 'unknown', tone: 'Soft.' }), { tone: 'Soft.' });
eq('drops unlisted keys', cleanProfile({ tone: 'Soft.', mood: 'angry' }), { tone: 'Soft.' });
eq('all empty is null', cleanProfile({ gender: '', age: '  ' }), null);
eq('missing is null', cleanProfile(undefined), null);

print('extractJson');
eq('plain object', extractJson('{"a":1}'), { a: 1 });
eq('skips prose braces before the json',
   extractJson('Let me think {this is not json} then: {"a":1}'), { a: 1 });
eq('ignores braces inside strings', extractJson('{"a":"} not the end {","b":2}'), { a: '} not the end {', b: 2 });
eq('handles nesting', extractJson('{"a":{"b":2}}'), { a: { b: 2 } });
eq('no json at all', extractJson('nothing here'), null);
eq('unbalanced', extractJson('{"a":1'), null);

print('normalizeQuoteId');
eq('already canonical', normalizeQuoteId('Q1'), 'Q1');
eq('lowercase', normalizeQuoteId('q2'), 'Q2');
eq('bare number', normalizeQuoteId('3'), 'Q3');
eq('padded', normalizeQuoteId(' q4 '), 'Q4');
eq('non-numeric left alone', normalizeQuoteId('Alice'), 'ALICE');

print('voiceInstruction');
const bob = { gender: 'male', age: 'late forties', accent: 'Scottish', tone: 'Gruff and clipped.' };
eq('design mode composes everything', voiceInstruction(bob, false),
   'male, late forties. Scottish accent. Gruff and clipped.');
eq('clone mode keeps tone only', voiceInstruction(bob, true), 'Gruff and clipped.');
eq('skips absent fields', voiceInstruction({ tone: 'Soft.' }, false), 'Soft.');
eq('trailing punctuation not doubled', voiceInstruction({ gender: 'female', tone: 'Wry;' }, false),
   'female. Wry.');
eq('empty profile', voiceInstruction({}, false), '');
eq('clone mode with no tone', voiceInstruction({ gender: 'male' }, true), '');

print('syncPrompts');
const shipped = api.DEFAULT_PROMPT;
let cfg = { prompt: 'OLD DEFAULT', prompt_stamps: { prompt: hash('OLD DEFAULT') } };
syncPrompts(cfg);
eq('unedited prompt upgrades', cfg.prompt, shipped);
eq('stamp follows', cfg.prompt_stamps.prompt, hash(shipped));

cfg = { prompt: 'MY OWN PROMPT', prompt_stamps: { prompt: hash('OLD DEFAULT') } };
syncPrompts(cfg);
eq('edited prompt is left alone', cfg.prompt, 'MY OWN PROMPT');

cfg = { prompt: 'PRE-EXISTING, NO STAMP' };
syncPrompts(cfg);
eq('unstamped prompt is left alone', cfg.prompt, 'PRE-EXISTING, NO STAMP');

cfg = { prompt: shipped, prompt_stamps: {} };
syncPrompts(cfg);
eq('current prompt gets stamped', cfg.prompt_stamps.prompt, hash(shipped));

runCastScenarios();
}

// Drives generate() end to end against a stubbed model and provider. Every one
// of these once left the cast sheet empty while the director named the speaker
// perfectly well — invisible to any unit test.
function runCastScenarios() {
    const BASE = ['narrator', 'villain'];
    const MES = 'She turned away. "I told you already."\n"Then leave," Bob said from the door.';

    const scenarios = [
        ['new speaker is cast',
         { map: { Alice: 'narrator' }, casting: { base: 'villain', gender: 'male', tone: 'Gruff.' },
           identify: { Q1: 'Alice', Q2: 'Bob' } },
         { cast: ['Bob'], added: ['bob'], tone: 'Gruff.' }],

        ['speaker with a voice-map entry is still listed',
         { map: { Alice: 'narrator', Bob: 'villain' },
           identify: { Q1: 'Alice', Q2: 'Bob' } },
         { cast: ['Bob'], added: [] }],

        ['answer recovered from the reasoning channel',
         { map: { Alice: 'narrator' },
           raw: '',
           reasoning: 'Working through it... {"Q1":"Alice","Q2":"Bob"}' },
         { cast: ['Bob'], added: ['bob'], tone: 'Gruff.' }],

        ['speaker is listed even when nothing can be derived',
         { map: { Alice: 'narrator' }, casting: { base: 'no such voice' },
           identify: { Q1: 'Alice', Q2: 'Bob' } },
         { cast: ['Bob'], added: [] }],

        ['a pre-staged speaker is reused, not re-cast',
         { map: { Alice: 'narrator' }, casting: { base: 'villain', gender: 'male', tone: 'Gruff.' },
           prestage: { Bob: { voice: 'villain', base: 'villain', pinned: true, tone: 'Mine.' } },
           identify: { Q1: 'Alice', Q2: 'Bob' } },
         { cast: ['Bob'], added: [], tone: 'Mine.', voice: 'villain' }],

        ['survives a reasoning preamble and odd quote ids',
         { map: { Alice: 'narrator' }, casting: { base: 'villain', gender: 'male', tone: 'Gruff.' },
           raw: 'Hmm {let me see}. Here:\n{"1":"Alice","q2":"Bob"}' },
         { cast: ['Bob'], added: ['bob'] }],

        ['casts against a provider too old to expose voicePreset',
         { map: { Alice: 'narrator' }, noVoicePreset: true,
           identify: { Q1: 'Alice', Q2: 'Bob' } },
         { cast: ['Bob'], added: ['bob'], tone: 'Gruff.' }],

        ['unattributed quotes are ignored',
         { map: { Alice: 'narrator' }, identify: { Q1: 'Alice', Q2: 'unknown' } },
         { cast: [], added: [] }],
    ];

    print('\ncast scenarios');

    // Strictly sequential: every scenario rewrites the same global stubs, so
    // running them concurrently has each one generating against another's model.
    return scenarios.reduce((chain, [label, setup, want]) => chain.then(async () => {
        // Scenarios that do not care what casting answers still need it to answer.
        setup.casting = setup.casting ?? { base: 'villain', gender: 'male', tone: 'Gruff.' };
        const added = new Map();
        const budgets = [];
        context.chat = [{ name: 'Alice', swipe_id: 0, extra: {}, mes: MES }];
        context.ConnectionManagerRequestService.sendRequest = async (profile, prompt, maxTokens) => {
            budgets.push([prompt.split('\n')[0].slice(0, 20), maxTokens]);
            if (prompt.includes('who speaks each line')) {
                return { content: setup.raw ?? JSON.stringify(setup.identify),
                         reasoning: setup.reasoning };
            }
            if (prompt.includes("Describe a character's voice")) {
                return { content: JSON.stringify(setup.casting) };
            }
            return { content: JSON.stringify(['Weary.', 'Flat and final.']) };
        };
        const api = new Function(source
            + ';return { generate, settings, castMap, castMessage };')();

        // After loading: the module publishes its own globalThis.breezeTts, so
        // a stub installed earlier would be overwritten by the real one.
        globalThis.breezeTts = {
            available: true,
            listVoices: () => [...BASE, ...added.keys()],
            hasVoice: (n) => BASE.includes(n) || added.has(n),
            addVoice: async (n, preset) => { added.set(n, preset); return n; },
            assignVoice: async () => {},
            voiceForCharacter: (n) => setup.map[n] ?? null,
            voicePreset: (n) => (BASE.includes(n) ? { cfg_scale: 4 } : added.get(n) ?? null),
            prefetch: async () => true,
            getClip: async () => null,
        };
        // An older provider simply does not have the newer methods.
        if (setup.noVoicePreset) delete globalThis.breezeTts.voicePreset;
        const config = api.settings();
        config.profile = 'test';
        config.cast = {};
        if (setup.prestage) Object.assign(api.castMap(), setup.prestage);

        try {
            await api.generate(0, { quiet: true });
            const cast = api.castMap();
            eq(label + ' — cast', Object.keys(cast), want.cast);
            eq(label + ' — voices added', [...added.keys()], want.added);
            if (want.tone) eq(label + ' — profile kept', cast.Bob?.tone, want.tone);
            if (want.voice) eq(label + ' — voice kept', cast.Bob?.voice, want.voice);
            // The original bug: auxiliary calls sized for the answer, not for a
            // reasoning model's thinking, came back empty and failed silently.
            const starved = budgets.filter(([, max]) => max < config.max_tokens);
            eq(label + ' — every call clears max_tokens', starved, []);
        } catch (error) {
            fails++;
            print('  FAIL ' + label + ' threw: ' + error);
        }
    }), Promise.resolve()).then(async () => {
        // castMessage() is the casting half alone: it must leave direction be.
        const added = new Map();
        context.chat = [{ name: 'Alice', swipe_id: 0, extra: {}, mes: MES }];
        context.ConnectionManagerRequestService.sendRequest = async (profile, prompt) => {
            if (prompt.includes('who speaks each line')) {
                return { content: JSON.stringify({ Q1: 'Alice', Q2: 'Bob' }) };
            }
            if (prompt.includes("Describe a character's voice")) {
                return { content: JSON.stringify({ base: 'villain', tone: 'Gruff.' }) };
            }
            throw new Error('castMessage should not ask for direction');
        };
        const api = new Function(source
            + ';return { settings, castMap, castMessage };')();

        globalThis.breezeTts = {
            available: true,
            listVoices: () => [...BASE, ...added.keys()],
            hasVoice: (n) => BASE.includes(n) || added.has(n),
            addVoice: async (n, preset) => { added.set(n, preset); return n; },
            assignVoice: async () => {},
            voiceForCharacter: (n) => (n === 'Alice' ? 'narrator' : null),
            voicePreset: (n) => (BASE.includes(n) ? { cfg_scale: 4 } : added.get(n) ?? null),
            prefetch: async () => true, getClip: async () => null,
        };
        const config = api.settings();
        config.profile = 'test';
        config.cast = {};

        try {
            const named = await api.castMessage(0);
            eq('castMessage — names the speaker', named, ['Bob']);
            eq('castMessage — casts them', Object.keys(api.castMap()), ['Bob']);
            eq('castMessage — leaves direction alone',
               context.chat[0].extra.breeze_direction ?? null, null);
        } catch (error) {
            fails++;
            print('  FAIL castMessage threw: ' + error);
        }
    }).then(finish, (error) => {
        fails++;
        print('  FAIL scenario chain threw: ' + error);
        finish();
    });
}

function finish() {
    print(fails ? '\n' + fails + ' FAILED' : '\nall passed');
    if (fails) imports.system.exit(1);
}
