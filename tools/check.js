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

// Every element built through document.createElement is kept, with the handlers
// bound to it, so a test can fire them. Registering a handler proves nothing;
// running it is what catches a name that no longer resolves inside it.
const built = [];

function el() {
    const node = {
        handlers: {},
        style: { cssText: '', setProperty() {} },
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        append() {}, appendChild() {}, remove() {},
        addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); },
        querySelector: () => el(), querySelectorAll: () => [],
        textContent: '', innerHTML: '', value: '', className: '', title: '',
        rows: 0, placeholder: '', readOnly: false, disabled: false, hidden: false,
    };
    built.push(node);
    return node;
}

/** Fire every handler bound since the marker, reporting any that throw. */
async function fireAll(from, label) {
    let fired = 0;
    for (const node of built.slice(from)) {
        for (const [type, fns] of Object.entries(node.handlers)) {
            for (const fn of fns) {
                fired++;
                try {
                    await fn({ stopPropagation() {}, preventDefault() {} });
                } catch (error) {
                    fails++;
                    print(`  FAIL ${label}: a ${type} handler threw: ${error}`);
                }
            }
        }
    }
    return fired;
}

// The extension registers more than one jQuery-ready callback; keep them all.
const readyFns = [];

// Selector -> value, so a test can see what the extension wrote where.
const fieldValues = new Map();

function jq(arg) {
    if (typeof arg === 'function') { readyFns.push(arg); return undefined; }
    const key = String(arg);
    const o = {
        length: 1,
        append: () => o, prepend: () => o, on: () => o, off: () => o,
        prop: (k, v) => (v === undefined ? false : o),
        val: (v) => {
            if (v === undefined) return fieldValues.get(key) ?? '';
            fieldValues.set(key, v);
            return o;
        },
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
    popups: [],
    callGenericPopup: async (content, type, value, options) => {
        context.popups.push({ type, options: options ?? {} });
        return true;
    },
    POPUP_TYPE: { CONFIRM: 1 },
    listeners: new Map(),
    eventSource: {
        on(event, fn) { (context.listeners.get(event) ?? context.listeners.set(event, []).get(event)).push(fn); },
    },
    event_types: {
        CHARACTER_MESSAGE_RENDERED: 'a', USER_MESSAGE_RENDERED: 'b',
        MESSAGE_SWIPED: 'c', CHAT_CHANGED: 'd', APP_READY: 'app_ready',
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

if (!readyFns.length) {
    print('ready handler NOT REGISTERED');
    imports.system.exit(1);
}

// Pretend SillyTavern already saved Breeze as the chosen provider, and that its
// own init selected the dropdown before our option existed.
context.extensionSettings.tts = { currentProvider: 'Breeze', narrate_by_paragraphs: true };
fieldValues.set('#tts_provider', 'AllTalk');

checkForOrphanedCalls(source);

/**
 * Every name called in the file must be declared somewhere in it, or be a
 * known global. Removing a function while a caller survives is a
 * ReferenceError that only fires when that path runs — invisible to a load
 * check and to unit tests, and it has slipped through repeatedly during
 * refactors that cut whole regions out of the file.
 */
function checkForOrphanedCalls(src) {
    const code = stripLiterals(src);

    const declared = new Set();
    for (const re of [
        /(?:^|\s)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
        /(?:^|\s)(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
        /(?:^|\s)class\s+([A-Za-z_$][\w$]*)/g,
        /([A-Za-z_$][\w$]*)\s*(?:=|:)\s*(?:async\s*)?(?:function|\()/g,
        // Class and object-literal shorthand methods, including get/set.
        /(?:^|[\s,{])(?:async\s+)?\*?\s*(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/g,
    ]) {
        for (const m of code.matchAll(re)) declared.add(m[1]);
    }

    const known = new Set([
        'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'await',
        'else', 'do', 'try', 'function', 'of', 'in', 'delete', 'void', 'yield', 'case',
        'async', 'await', 'static', 'get', 'set',
        'Object', 'Array', 'String', 'Number', 'Boolean', 'JSON', 'Math', 'Promise',
        'Set', 'Map', 'WeakMap', 'Date', 'RegExp', 'Error', 'Symbol', 'BigInt',
        'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'setTimeout', 'clearTimeout',
        'fetch', 'Blob', 'Response', 'Request', 'FormData', 'DataView', 'ArrayBuffer',
        'Uint8Array', 'Int16Array', 'TextDecoder', 'TextEncoder', 'URL', 'indexedDB',
        'IDBKeyRange', 'structuredClone', 'encodeURIComponent', 'decodeURIComponent',
        'require', 'import', 'super', 'constructor',
    ]);

    // Destructured bindings: const [key, shipped] of ..., const { a, b } = ...
    for (const m of code.matchAll(/(?:const|let|var)\s*[[{]([^\]}]*)[\]}]/g)) {
        for (const part of m[1].split(',')) {
            const name = part.trim().split(/[\s:=]/).pop();
            if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
        }
    }

    // Parameter names are bindings too: (resolve, reject) => ... declares both.
    for (const m of code.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
        for (const part of m[1].split(',')) {
            const name = part.trim().replace(/^\.\.\./, '').split(/[\s=]/)[0];
            if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
        }
    }

    const orphans = new Set();
    for (const m of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
        const name = m[1];
        if (declared.has(name) || known.has(name)) continue;
        if (name in globalThis) continue;
        orphans.add(name);
    }

    if (orphans.size) {
        print('orphaned      CALLED BUT NEVER DECLARED: ' + [...orphans].sort().join(', '));
        imports.system.exit(1);
    }
    print('orphaned      none');
}

/** A slash here opens a regex, not a division, judging by what came before. */
function startsRegex(before) {
    const prev = before.replace(/\s+$/, '').slice(-1);
    return prev === '' || '(,=:[!&|?{};+-*%~^'.includes(prev);
}

/** Blank out comments and string/template/regex literals so they cannot look like code. */
function stripLiterals(src) {
    let out = '';
    for (let i = 0; i < src.length;) {
        const c = src[i];
        const next = src[i + 1];
        if (c === '/' && next === '/') {
            while (i < src.length && src[i] !== '\n') i++;
            continue;
        }
        if (c === '/' && next === '*') {
            i += 2;
            while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
            i += 2;
            continue;
        }
        // A regex literal can hold quotes and backticks in a character class —
        // normalize()'s does — so it must be consumed as one token, or the rest
        // of the file is read as one enormous string.
        if (c === '/' && startsRegex(out)) {
            i++;
            let inClass = false;
            while (i < src.length) {
                if (src[i] === '\\') { i += 2; continue; }
                if (src[i] === '[') inClass = true;
                else if (src[i] === ']') inClass = false;
                else if (src[i] === '/' && !inClass) { i++; break; }
                else if (src[i] === '\n') break;
                i++;
            }
            while (i < src.length && /[a-z]/.test(src[i])) i++;
            out += '/re/';
            continue;
        }
        if (c === '"' || c === "'" || c === '`') {
            const quote = c;
            i++;
            while (i < src.length) {
                if (src[i] === '\\') { i += 2; continue; }
                if (src[i] === quote) { i++; break; }
                i++;
            }
            out += '""';
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

Promise.all(readyFns.map(fn => fn())).then(
    () => {
        print('ready handler OK\n');
        print('provider selection');
        eq('dropdown put back on Breeze', fieldValues.get('#tts_provider'), 'Breeze');
        const onReady = context.listeners.get('app_ready') ?? [];
        eq('re-asserted on APP_READY', onReady.length > 0, true);
        fieldValues.set('#tts_provider', 'AllTalk');
        for (const fn of onReady) fn();
        eq('APP_READY listener corrects it again', fieldValues.get('#tts_provider'), 'Breeze');
        print('');
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
    voiceInstruction, cleanProfile, PROFILE_FIELDS, splitLines, buildUnits,
    extractJson, normalizeQuoteId,
    DEFAULT_PROMPT, DEFAULT_VOICE_CAST_PROMPT };`)();
const { splitSegments, collectQuotes, isForeignSpeaker, parseDirection,
        normalize, pickLine, castEntry, hash, syncPrompts,
        voiceInstruction, cleanProfile, splitLines, buildUnits,
        extractJson, normalizeQuoteId } = api;


print('splitLines');
eq('plain paragraphs', splitLines('one\ntwo'), ['one', 'two']);
eq('blank line between paragraphs', splitLines('one\n\ntwo'), ['one', 'two']);
eq('CRLF paragraph break', splitLines('one\r\n\r\ntwo'), ['one', 'two']);
eq('trailing CR is trimmed off', splitLines('one\r\ntwo'), ['one', 'two']);
eq('whitespace-only line', splitLines('one\n   \ntwo'), ['one', 'two']);
eq('tab-only line', splitLines('one\n\t\ntwo'), ['one', 'two']);
eq('zero-width-only line', splitLines('one\n\u200B\ntwo'), ['one', 'two']);
eq('byte-order mark line', splitLines('one\n\uFEFF\ntwo'), ['one', 'two']);
eq('inner spacing survives', splitLines('a  b'), ['a  b']);
eq('nothing at all', splitLines(''), []);
eq('only blanks', splitLines('\r\n \n\t'), []);
eq('units skip the blanks', buildUnits('one\r\n\r\ntwo').length, 2);

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
eq('legacy string becomes a base', castEntry('villain'), { base: 'villain' });
eq('a derived voice is read as a base',
   castEntry({ voice: 'bob', base: null, tone: 'Gruff.' }),
   { voice: 'bob', base: 'bob', tone: 'Gruff.' });
eq('object passes through',
   castEntry({ base: 'villain', gender: 'male', tone: 'Gruff.' }),
   { base: 'villain', gender: 'male', tone: 'Gruff.' });
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
         { cast: ['Bob'], base: 'villain', tone: 'Gruff.' }],

        ['speaker with a voice-map entry is still listed',
         { map: { Alice: 'narrator', Bob: 'villain' },
           identify: { Q1: 'Alice', Q2: 'Bob' } },
         { cast: ['Bob'] }],

        ['answer recovered from the reasoning channel',
         { map: { Alice: 'narrator' },
           raw: '',
           reasoning: 'Working through it... {"Q1":"Alice","Q2":"Bob"}' },
         { cast: ['Bob'], base: 'villain', tone: 'Gruff.' }],

        ['speaker is listed even when nothing can be derived',
         { map: { Alice: 'narrator' }, casting: { base: 'no such voice' },
           identify: { Q1: 'Alice', Q2: 'Bob' } },
         { cast: ['Bob'] }],

        ['a pre-staged speaker is reused, not re-cast',
         { map: { Alice: 'narrator' }, casting: { base: 'villain', gender: 'male', tone: 'Gruff.' },
           prestage: { Bob: { voice: 'villain', base: 'villain', pinned: true, tone: 'Mine.' } },
           identify: { Q1: 'Alice', Q2: 'Bob' } },
         { cast: ['Bob'], base: 'villain', tone: 'Mine.' }],

        ['survives a reasoning preamble and odd quote ids',
         { map: { Alice: 'narrator' }, casting: { base: 'villain', gender: 'male', tone: 'Gruff.' },
           raw: 'Hmm {let me see}. Here:\n{"1":"Alice","q2":"Bob"}' },
         { cast: ['Bob'], base: 'villain' }],

        ['casts when a base voice cannot be read',
         { map: { Alice: 'narrator' }, unreadableBase: true,
           identify: { Q1: 'Alice', Q2: 'Bob' } },
         { cast: ['Bob'], base: 'villain', tone: 'Gruff.' }],

        ['unattributed quotes are ignored',
         { map: { Alice: 'narrator' }, identify: { Q1: 'Alice', Q2: 'unknown' } },
         { cast: [] }],
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
        // The voices JSON is hand-edited, so reading a preset can throw.
        if (setup.unreadableBase) {
            globalThis.breezeTts.voicePreset = () => {
                throw new SyntaxError('Voices JSON is not valid.');
            };
        }
        const config = api.settings();
        config.profile = 'test';
        config.cast = {};
        if (setup.prestage) Object.assign(api.castMap(), setup.prestage);

        try {
            await api.generate(0, { quiet: true });
            const cast = api.castMap();
            eq(label + ' — cast', Object.keys(cast), want.cast);
            // The provider's voices are the user's to manage: this extension
            // composes on top of them and must never write one.
            eq(label + ' — provider voices untouched', [...added.keys()], []);
            if (want.base) eq(label + ' — base chosen', cast.Bob?.base, want.base);
            if (want.tone) eq(label + ' — profile kept', cast.Bob?.tone, want.tone);
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
            eq('castMessage — adds no provider voices', [...added.keys()], []);
            eq('castMessage — leaves direction alone',
               context.chat[0].extra.breeze_direction ?? null, null);
        } catch (error) {
            fails++;
            print('  FAIL castMessage threw: ' + error);
        }

        // The cast sheet builds a lot of DOM and is otherwise untested; opening
        // it here catches a reference error in any of its rows or handlers.
        print('\ncast sheet');
        try {
            const sheet = new Function(source + ';return { settings, castMap, openCastSheet };')();

            // Loading the module republishes the real breezeTts, so the stub
            // has to go back afterwards or the sheet bails at its guard.
            globalThis.breezeTts = {
                available: true,
                listVoices: () => [...BASE, ...added.keys()],
                hasVoice: (n) => BASE.includes(n) || added.has(n),
                addVoice: async (n, preset) => { added.set(n, preset); return n; },
                voiceForCharacter: () => null,
                voicePreset: (n) => (BASE.includes(n) ? { cfg_scale: 4 } : null),
                previewWith: async () => {},
                prefetch: async () => true,
                getClip: async () => null,
            };

            const config = sheet.settings();
            config.profile = 'test';
            config.cast = {};
            Object.assign(sheet.castMap(), {
                Bob: { base: 'villain', gender: 'male', tone: 'Gruff.' },
                Carol: { base: 'nope', pinned: true },
                Dave: {},
            });
            const marker = built.length;
            await sheet.openCastSheet();
            const rows = built.length - marker;
            eq('builds rows for every entry', rows > 10, true);

            // A cast longer than the dialog is unreachable without this: ST's
            // .popup-content is overflow:hidden unless the popup opts in.
            eq('opens scrollable', context.popups.at(-1)?.options.allowVerticalScrolling, true);

            const fired = await fireAll(marker, 'cast sheet');
            eq('handlers were bound and ran', fired > 5, true);
            eq('provider voices untouched by the sheet', [...added.keys()], []);
        } catch (error) {
            fails++;
            print('  FAIL cast sheet threw: ' + error);
            print(String(error.stack || '').split('\n').slice(0, 4).join('\n'));
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
