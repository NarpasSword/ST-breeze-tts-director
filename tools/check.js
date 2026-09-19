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


const [, bytes] = GLib.file_get_contents(ARGV[0] || 'index.js');
const source = new TextDecoder().decode(bytes);

try {
    // new Function() compiles a classic script body: syntax errors and
    // top-level ReferenceErrors both surface here.
    new Function(source)();
    print('eval          OK');
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
    voiceInstruction, cleanProfile, profileFor, PROFILE_FIELDS,
    DEFAULT_PROMPT, DEFAULT_VOICE_CAST_PROMPT };`)();
const { splitSegments, collectQuotes, isForeignSpeaker, parseDirection,
        normalize, pickLine, castEntry, hash, syncPrompts,
        voiceInstruction, cleanProfile, profileFor } = api;


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

print('profileFor');
eq('exact key', profileFor({ Bob: { tone: 'a' } }, 'Bob'), { tone: 'a' });
eq('different casing', profileFor({ bob: { tone: 'a' } }, 'Bob'), { tone: 'a' });
eq('surrounding space', profileFor({ ' Bob ': { tone: 'a' } }, 'Bob'), { tone: 'a' });
eq('absent', profileFor({ Carol: { tone: 'a' } }, 'Bob'), null);

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
         { map: { Alice: 'narrator' }, casting: 'villain',
           identify: { speakers: { Q1: 'Alice', Q2: 'Bob' },
                       profiles: { Bob: { gender: 'male', tone: 'Gruff.' } } } },
         { cast: ['Bob'], added: ['bob'] }],

        ['speaker with a voice-map entry is still listed',
         { map: { Alice: 'narrator', Bob: 'villain' }, casting: 'villain',
           identify: { speakers: { Q1: 'Alice', Q2: 'Bob' },
                       profiles: { Bob: { gender: 'male', tone: 'Gruff.' } } } },
         { cast: ['Bob'], added: [] }],

        ['profile filed under different casing is kept',
         { map: { Alice: 'narrator' }, casting: 'villain',
           identify: { speakers: { Q1: 'Alice', Q2: 'Bob' },
                       profiles: { bob: { gender: 'male', tone: 'Gruff.' } } } },
         { cast: ['Bob'], added: ['bob'], tone: 'Gruff.' }],

        ['speaker is listed even when nothing can be derived',
         { map: { Alice: 'narrator' }, casting: 'no such voice',
           identify: { speakers: { Q1: 'Alice', Q2: 'Bob' }, profiles: {} } },
         { cast: ['Bob'], added: [] }],

        ['a pre-staged speaker is reused, not re-cast',
         { map: { Alice: 'narrator' }, casting: 'villain',
           prestage: { Bob: { voice: 'villain', base: 'villain', pinned: true, tone: 'Mine.' } },
           identify: { speakers: { Q1: 'Alice', Q2: 'Bob' },
                       profiles: { Bob: { gender: 'male', tone: 'Gruff.' } } } },
         { cast: ['Bob'], added: [], tone: 'Mine.', voice: 'villain' }],

        ['unattributed quotes are ignored',
         { map: { Alice: 'narrator' }, casting: 'villain',
           identify: { speakers: { Q1: 'Alice', Q2: 'unknown' }, profiles: {} } },
         { cast: [], added: [] }],
    ];

    print('\ncast scenarios');

    // Strictly sequential: every scenario rewrites the same global stubs, so
    // running them concurrently has each one generating against another's model.
    return scenarios.reduce((chain, [label, setup, want]) => chain.then(async () => {
        const added = new Map();
        context.chat = [{ name: 'Alice', swipe_id: 0, extra: {}, mes: MES }];
        context.ConnectionManagerRequestService.sendRequest = async (profile, prompt) => {
            if (prompt.includes('who speaks each line')) {
                return { content: JSON.stringify(setup.identify) };
            }
            if (prompt.includes('Choose which existing voice')) return { content: setup.casting };
            return { content: JSON.stringify(['Weary.', 'Flat and final.']) };
        };
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

        const api = new Function(source
            + ';return { generate, settings, castMap, castMessage };')();
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
                return { content: JSON.stringify({
                    speakers: { Q1: 'Alice', Q2: 'Bob' },
                    profiles: { Bob: { gender: 'male', tone: 'Gruff.' } },
                }) };
            }
            if (prompt.includes('Choose which existing voice')) return { content: 'villain' };
            throw new Error('castMessage should not ask for direction');
        };
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

        const api = new Function(source
            + ';return { settings, castMap, castMessage };')();
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
