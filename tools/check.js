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

    // Slash command API, recording what the extension registers.
    commands: new Map(),
    SlashCommandParser: {
        addCommandObject(command) {
            if (context.commands.has(command.name)) {
                throw new Error(`Duplicate command ${command.name}`);
            }
            context.commands.set(command.name, command);
        },
    },
    SlashCommand: { fromProps: (props) => props },
    SlashCommandArgument: function (description, typeList, isRequired) {
        return { description, typeList, isRequired };
    },
    SlashCommandNamedArgument: function (name, description, typeList, isRequired) {
        return { name, description, typeList, isRequired };
    },
    ARGUMENT_TYPE: { STRING: 'string', NUMBER: 'number', BOOLEAN: 'bool' },
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
        print('slash commands');
        eq('registers the four commands', [...context.commands.keys()].sort(),
           ['breeze-audio', 'breeze-blank', 'breeze-cast', 'breeze-direct']);
        for (const [name, command] of context.commands) {
            eq(`${name} takes an optional message id`,
               command.unnamedArgumentList?.[0]?.isRequired, false);
            eq(`${name} documents itself`, (command.helpString ?? '').length > 40, true);
        }
        eq('breeze-audio takes blank= and from=',
           (context.commands.get('breeze-audio').namedArgumentList ?? []).map(a => a.name).sort(),
           ['blank', 'from']);
        print('');

        print('provider selection');
        eq('dropdown put back on Breeze', fieldValues.get('#tts_provider'), 'Breeze');
        const onReady = context.listeners.get('app_ready') ?? [];
        eq('re-asserted on APP_READY', onReady.length > 0, true);
        fieldValues.set('#tts_provider', 'AllTalk');
        for (const fn of onReady) fn();
        eq('APP_READY listener corrects it again', fieldValues.get('#tts_provider'), 'Breeze');
        print('');
        return runAssertions();
    },
    (error) => {
        print('ready handler THREW: ' + error);
        print(String(error.stack || '').split('\n').slice(0, 8).join('\n'));
        imports.system.exit(1);
    },
).catch((error) => {
    // Without this a throw inside the success handler above becomes an
    // unhandled rejection with no message, which hides real failures.
    print('checks THREW: ' + error);
    print(String(error.stack || '').split('\n').slice(0, 8).join('\n'));
    imports.system.exit(1);
});

let fails = 0;
function eq(label, got, want) {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { print('  ok   ' + label); return; }
    fails++; print('  FAIL ' + label + '\n       got  ' + g + '\n       want ' + w);
}

const DEFAULT_VOICE_MARKER = '[Default Voice]';

async function runAssertions() {
const api = new Function(source + `;return {
    isExcluded, readableText, getDirection, DEFAULT_EXCLUSIONS, settings, hasProfile,
    splitSegments, collectQuotes, isNamedSpeaker, parseDirection,
    normalize, pickLine, castEntry, hash, syncPrompts, skipped, isSkipped, setSkipped,
    voiceInstruction, cleanProfile, PROFILE_FIELDS, splitLines, buildUnits, targetMessage,
    extractJson, normalizeQuoteId,
    DEFAULT_PROMPT, DEFAULT_VOICE_CAST_PROMPT };`)();
const { isExcluded, readableText, getDirection,
        splitSegments, collectQuotes, isNamedSpeaker, parseDirection,
        normalize, pickLine, castEntry, hash, syncPrompts, skipped, isSkipped, setSkipped,
        voiceInstruction, cleanProfile, splitLines, buildUnits, targetMessage,
        extractJson, normalizeQuoteId } = api;


print('targetMessage');
const savedChat = context.chat;
context.chat = [{ mes: 'a' }, { mes: 'b' }, { mes: 'c' }];
eq('no argument is the last message', targetMessage(undefined), 2);
eq('blank argument is the last message', targetMessage('  '), 2);
eq('an index', targetMessage('1'), 1);
eq('first message', targetMessage('0'), 0);
eq('negative counts back', targetMessage('-1'), 2);
eq('negative, further back', targetMessage('-3'), 0);
eq('past the end', targetMessage('9'), -1);
eq('too far back', targetMessage('-9'), -1);
eq('not a number is the last message', targetMessage('last'), 2);
context.chat = [];
eq('empty chat', targetMessage(undefined), -1);
context.chat = savedChat;

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

print('exclusions');
const config = api.settings();
config.exclusions = api.DEFAULT_EXCLUSIONS;
config.skip_tags = false;
eq('three dashes', isExcluded('---'), true);
eq('a long rule', isExcluded('--------'), true);
eq('asterisk rule', isExcluded('***'), true);
eq('underscore rule', isExcluded('___'), true);
eq('two dashes are not a rule', isExcluded('--'), false);
eq('an em dash in prose', isExcluded('He turned\u2014and left.'), false);
eq('a rule with words is read', isExcluded('--- Chapter 2 ---'), false);
eq('ordinary prose', isExcluded('The first thing visible is smoke.'), false);
eq('rules drop out of the units', splitLines('one\n---\ntwo'), ['one', 'two']);

config.exclusions = '^\\[.*\\]$\n(((';
eq('custom pattern applies', isExcluded('[scene break]'), true);
eq('an invalid pattern is skipped, not fatal', isExcluded('---'), false);
config.exclusions = api.DEFAULT_EXCLUSIONS;

print('skip tags');
config.skip_tags = true;
eq('a tag block goes', readableText('before<div>hidden</div>after'), 'beforeafter');
eq('across lines too', readableText('a\n<i>\nhidden\n</i>\nb'), 'a\n\nb');
eq('prose with a less-than survives', readableText('2 < 3 and 4 > 1'), '2 < 3 and 4 > 1');
eq('a lone tag is not a block', readableText('a <br> b'), 'a <br> b');
eq('whole lines of tags leave no paragraph',
   splitLines('one\n<note>skip me</note>\ntwo'), ['one', 'two']);
config.skip_tags = false;
eq('off, the tag is read', readableText('before<div>hidden</div>after'),
   'before<div>hidden</div>after');

print('getDirection');
const withLines = (mes, lines, swipe = 0) => ({
    mes, swipe_id: swipe,
    extra: { breeze_direction: { swipe_id: 0, lines: lines.map(t => ({ text: t, instruction: 'x' })) } },
});
eq('matching take is kept', !!getDirection(withLines('one\ntwo', ['one', 'two'])), true);
eq('take from a different swipe is dropped',
   getDirection(withLines('one\ntwo', ['one', 'two'], 1)), null);
eq('take with the wrong paragraph count is dropped',
   getDirection(withLines('one\ntwo', ['one', 'two', 'three'])), null);
eq('a take written before an exclusion existed is dropped',
   getDirection(withLines('one\n---\ntwo', ['one', '---', 'two'])), null);

print('skipping paragraphs');
const skipMsg = { mes: 'one\ntwo\nthree', extra: {} };
eq('nothing skipped by default', [...skipped(skipMsg)], []);
eq('everything plays by default', isSkipped(skipMsg, 1), false);
await setSkipped(skipMsg, 1, true);
eq('unchecking records it', skipMsg.extra.breeze_skip, [1]);
eq('and reads back', isSkipped(skipMsg, 1), true);
eq('its neighbours are unaffected', isSkipped(skipMsg, 0), false);
await setSkipped(skipMsg, 0, true);
eq('kept in order', skipMsg.extra.breeze_skip, [0, 1]);
await setSkipped(skipMsg, 1, true);
eq('skipping twice is not two entries', skipMsg.extra.breeze_skip, [0, 1]);
await setSkipped(skipMsg, 0, false);
eq('rechecking removes it', skipMsg.extra.breeze_skip, [1]);
await setSkipped(skipMsg, 1, false);
eq('the field goes away when nothing is skipped',
   'breeze_skip' in skipMsg.extra, false);

print('isNamedSpeaker');
const msg = { name: 'Alice' };
eq('another character', isNamedSpeaker('Bob', msg), true);
eq('the message character is cast too', isNamedSpeaker('alice', msg), true);
eq('the user is cast too', isNamedSpeaker(context.name1, msg), true);
eq('unknown is not a speaker', isNamedSpeaker('unknown', msg), false);
eq('narrator is not a speaker', isNamedSpeaker('narrator', msg), false);
eq('nothing is not a speaker', isNamedSpeaker('', msg), false);
// A character really can be called Narrator; the placeholder list must not
// swallow the person doing most of the talking.
eq('a character named Narrator is a speaker',
   isNamedSpeaker('Narrator', { name: 'Narrator' }), true);
eq('but a stray "narrator" attribution still is not',
   isNamedSpeaker('Narrator', { name: 'Alice' }), false);

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

print('hasProfile');
const { hasProfile } = api;
eq('a tone counts', hasProfile({ base: 'x', tone: 'Gruff.' }), true);
eq('any field counts', hasProfile({ base: 'x', accent: 'Scottish' }), true);
eq('a base alone is not a description', hasProfile({ base: 'x' }), false);
eq('nothing', hasProfile({}), false);
eq('missing', hasProfile(undefined), false);

print('cleanProfile');
eq('keeps filled fields', cleanProfile({ gender: 'male', age: ' 40s ', tone: 'Gruff.', accent: '' }),
   { gender: 'male', age: '40s', tone: 'Gruff.' });
eq('drops unknown', cleanProfile({ gender: 'unknown', tone: 'Soft.' }), { tone: 'Soft.' });
eq('drops unlisted keys', cleanProfile({ tone: 'Soft.', mood: 'angry' }), { tone: 'Soft.' });
eq('all empty is null', cleanProfile({ gender: '', age: '  ' }), null);
// A long tone is kept, not truncated — mangling someone's voice is worse than
// a wordy one — but it warns, which is how it becomes visible at all.
const wordy = Array(40).fill('word').join(' ');
eq('an over-long tone survives', cleanProfile({ tone: wordy })?.tone, wordy);
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
         { cast: ['Alice', 'Bob'], base: 'villain', tone: 'Gruff.' }],

        ['speaker with a voice-map entry is still listed',
         { map: { Alice: 'narrator', Bob: 'villain' },
           identify: { Q1: 'Alice', Q2: 'Bob' } },
         { cast: ['Alice', 'Bob'] }],

        ['answer recovered from the reasoning channel',
         { map: { Alice: 'narrator' },
           raw: '',
           reasoning: 'Working through it... {"Q1":"Alice","Q2":"Bob"}' },
         { cast: ['Alice', 'Bob'], base: 'villain', tone: 'Gruff.' }],

        ['speaker is listed even when nothing can be derived',
         { map: { Alice: 'narrator' }, casting: { base: 'no such voice' },
           identify: { Q1: 'Alice', Q2: 'Bob' } },
         { cast: ['Alice', 'Bob'] }],

        ['a pre-staged speaker is reused, not re-cast',
         { map: { Alice: 'narrator' }, casting: { base: 'villain', gender: 'male', tone: 'Gruff.' },
           prestage: { Bob: { voice: 'villain', base: 'villain', pinned: true, tone: 'Mine.' } },
           identify: { Q1: 'Alice', Q2: 'Bob' } },
         { cast: ['Alice', 'Bob'], base: 'villain', tone: 'Mine.' }],

        ['survives a reasoning preamble and odd quote ids',
         { map: { Alice: 'narrator' }, casting: { base: 'villain', gender: 'male', tone: 'Gruff.' },
           raw: 'Hmm {let me see}. Here:\n{"1":"Alice","q2":"Bob"}' },
         { cast: ['Alice', 'Bob'], base: 'villain' }],

        ['casts when a base voice cannot be read',
         { map: { Alice: 'narrator' }, unreadableBase: true,
           identify: { Q1: 'Alice', Q2: 'Bob' } },
         { cast: ['Alice', 'Bob'], base: 'villain', tone: 'Gruff.' }],

        ['a [Default Voice] entry is not a choice of base',
         { map: { Alice: '[Default Voice]', '[Default Voice]': 'narrator' },
           casting: { base: 'villain', gender: 'female', tone: 'Dry.' },
           identify: { Q1: 'Alice', Q2: 'Bob' } },
         { cast: ['Alice', 'Bob'], base: 'villain', aliceBase: 'villain' }],

        ['unattributed quotes are ignored',
         { map: { Alice: 'narrator' }, identify: { Q1: 'Alice', Q2: 'unknown' } },
         { cast: ['Alice'] }],
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
            if (prompt.includes('Available base voices')) {
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
            assignedVoice: (n) => {
                const value = setup.map[n];
                return (!value || value === DEFAULT_VOICE_MARKER) ? null : value;
            },
            voiceForCharacter: (n) => {
                const value = setup.map[n];
                return (value === DEFAULT_VOICE_MARKER
                    ? setup.map[DEFAULT_VOICE_MARKER] : value) ?? null;
            },
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
            // Sorted: insertion order depends on who was pre-staged, which is
            // not what any of these scenarios is about.
            eq(label + ' — cast', Object.keys(cast).sort(), [...want.cast].sort());
            // The provider's voices are the user's to manage: this extension
            // composes on top of them and must never write one.
            eq(label + ' — provider voices untouched', [...added.keys()], []);
            if (want.base) eq(label + ' — base chosen', cast.Bob?.base, want.base);
            // The message's own character is cast as well, taking their
            // voice-map entry as the base rather than a model's guess — and
            // still getting a description, which a voice-map entry does not
            // supply. Stopping at the base was why the character sat on the
            // sheet blank while side characters were fully described.
            if (want.aliceBase) {
                // Nobody chose a voice for her, so the director chose the base
                // rather than inheriting whatever [Default Voice] points at.
                eq(label + ' — character is cast freely',
                   [cast.Alice?.base, cast.Alice?.source], [want.aliceBase, undefined]);
            } else if (cast.Alice && !setup.prestage?.Alice) {
                eq(label + ' — character takes their voice-map voice',
                   [cast.Alice.base, cast.Alice.source], ['narrator', 'voicemap']);
                // Only where the model had a description to give; the
                // nothing-can-be-derived scenario deliberately has none.
                if (setup.casting?.tone) {
                    eq(label + ' — and is described like anyone else',
                       cast.Alice.tone, setup.casting.tone);
                }
            }
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
            if (prompt.includes('Available base voices')) {
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
            assignedVoice: (n) => (n === 'Alice' ? 'narrator' : null),
            voiceForCharacter: (n) => (n === 'Alice' ? 'narrator' : null),
            voicePreset: (n) => (BASE.includes(n) ? { cfg_scale: 4 } : added.get(n) ?? null),
            prefetch: async () => true, getClip: async () => null,
        };
        const config = api.settings();
        config.profile = 'test';
        config.cast = {};

        try {
            const named = await api.castMessage(0);
            eq('castMessage — names the speakers', named, ['Alice', 'Bob']);
            eq('castMessage — casts them', Object.keys(api.castMap()).sort(), ['Alice', 'Bob']);
            eq('castMessage — adds no provider voices', [...added.keys()], []);
            eq('castMessage — leaves direction alone',
               context.chat[0].extra.breeze_direction ?? null, null);
        } catch (error) {
            fails++;
            print('  FAIL castMessage threw: ' + error);
        }

        // Pre-generation must direct before it caches: a clip is keyed by the
        // instruction it was made under, so audio made first is audio wasted.
        print('\npre-generation');
        try {
            const pre = new Function(source
                + ';return { settings, castMap, pregenerate, prefetchMessage, player };')();
            globalThis.breezeTts = {
                available: true,
                listVoices: () => [...BASE, ...added.keys()],
                hasVoice: (n) => BASE.includes(n) || added.has(n),
                addVoice: async (n, preset) => { added.set(n, preset); return n; },
                assignedVoice: (n) => (n === 'Alice' ? 'narrator' : null),
                voiceForCharacter: (n) => (n === 'Alice' ? 'narrator' : null),
                voicePreset: (n) => (BASE.includes(n) ? { cfg_scale: 4 } : null),
                prefetch: async () => true,
                getClip: async () => null,
            };
            context.chat = [{ name: 'Alice', swipe_id: 0, extra: {}, mes: MES }];
            context.ConnectionManagerRequestService.sendRequest = async (profile, prompt) => {
                if (prompt.includes('who speaks each line')) {
                    return { content: JSON.stringify({ Q1: 'Alice', Q2: 'Bob' }) };
                }
                if (prompt.includes('Available base voices')) {
                    return { content: JSON.stringify({ base: 'villain', tone: 'Gruff.' }) };
                }
                return { content: JSON.stringify(['Weary.', 'Flat and final.']) };
            };
            const config = pre.settings();
            config.profile = 'test';
            config.cast = {};

            eq('nothing directed yet', context.chat[0].extra.breeze_direction ?? null, null);
            const made = await pre.pregenerate(0);
            eq('directs before caching', !!context.chat[0].extra.breeze_direction, true);
            eq('generates a clip per segment', made, 4);
            eq('adds no provider voices', [...added.keys()], []);

            // An unchecked paragraph is not generated and not played.
            context.chat[0].extra.breeze_skip = [0];
            eq('skipped paragraphs are not generated', await pre.prefetchMessage(0), 2);

            const { player: skipPlayer } = new Function(source + ';return { player };')();
            globalThis.breezeTts = {
                available: true,
                hasVoice: () => true,
                assignedVoice: () => 'narrator',
                voiceForCharacter: () => 'narrator',
                voicePreset: () => ({ cfg_scale: 4 }),
                prefetch: async () => true,
                getClip: async () => null,
            };
            await skipPlayer.load(0);
            eq('a skipped paragraph has no clips', skipPlayer.units[0].clips.length, 0);
            eq('the rest still do', skipPlayer.units[1].clips.length > 0, true);
            // Asking to play the skipped paragraph must land on the next one.
            await skipPlayer.playAt(0, 0);
            eq('playing a skipped paragraph moves past it', skipPlayer.index, 1);
            delete context.chat[0].extra.breeze_skip;
        } catch (error) {
            fails++;
            print('  FAIL pre-generation threw: ' + error);
        }

        // A blank take is the other way of settling the direction: no model
        // call at all, and audio cached against it stays valid because nothing
        // will direct the message later.
        print('\nblank takes');
        try {
            const bt = new Function(source + ';return { settings, buildUnits, blankTake, isBlank,'
                + ' getDirection, pregenerate, prefetchMessage, openPanel, deleteTake,'
                + ' panels, player };')();
            globalThis.breezeTts = {
                available: true,
                listVoices: () => [...BASE],
                hasVoice: (n) => BASE.includes(n),
                addVoice: async (n, preset) => { added.set(n, preset); return n; },
                assignedVoice: () => 'narrator',
                voiceForCharacter: () => 'narrator',
                voicePreset: () => ({ cfg_scale: 4 }),
                prefetch: async () => true,
                getClip: async () => null,
                // The panel's own buttons reach further into the provider than
                // pre-generation does; the erase button wants all three.
                cacheStats: async () => ({ count: 0, bytes: 0 }),
                dropClips: async () => ({ count: 0, bytes: 0 }),
                clearCache: async () => {},
            };

            let calls = 0;
            context.ConnectionManagerRequestService.sendRequest = async () => {
                calls++;
                return { content: '[]' };
            };
            context.chat = [{ name: 'Alice', swipe_id: 0, extra: {}, mes: MES }];
            const config = bt.settings();
            config.profile = 'test';
            config.cast = {};

            const units = bt.buildUnits(MES);
            const take = (instruction, extra = {}) => units.map((unit, i) => ({
                text: unit.text, instruction, ...(i === 0 ? extra : {}),
            }));

            context.chat[0].extra.breeze_direction = {
                swipe_id: 0, ts: 1, history: [],
                lines: take('Weary.', { segments: [{ text: units[0].text, kind: 'dialogue', speaker: 'Bob' }] }),
            };

            const blanked = await bt.blankTake(0);
            eq('every instruction is cleared', blanked.lines.every(l => l.instruction === ''), true);
            eq('and the take reads as blank', bt.isBlank(blanked), true);
            eq('the take it replaced went to the history', blanked.history.length, 1);
            eq('which still says what it said', blanked.history[0].lines[0].instruction, 'Weary.');
            eq('who speaks is not direction, so it rides along',
               blanked.lines[0].segments?.[0]?.speaker, 'Bob');
            eq('no model call was made', calls, 0);
            eq('blanking twice does not churn the history', (await bt.blankTake(0)).history.length, 1);

            delete context.chat[0].extra.breeze_direction;
            const made = await bt.pregenerate(0, { blank: true });
            eq('blank pre-generation asks the model for nothing', calls, 0);
            eq('a clip per paragraph, none of them cast', made, units.length);
            eq('and a blank take is left behind',
               bt.isBlank(bt.getDirection(context.chat[0])), true);
            eq('from= skips the paragraphs before it',
               await bt.prefetchMessage(0, { from: units.length - 1 }), 1);
            eq('past the end generates nothing',
               await bt.prefetchMessage(0, { from: units.length }), 0);

            // Deleting a take runs through the panel, so it exercises the
            // toolbar handler as well as the bookkeeping underneath it.
            context.chat[0].extra.breeze_direction = {
                swipe_id: 0, ts: 3, lines: take('New.'),
                history: [{ ts: 2, lines: take('Old.') }, { ts: 1, lines: take('Older.') }],
            };
            await bt.openPanel(0);
            eq('the panel opened', bt.panels.has(0), true);

            // Viewing take 2 ("Older.") and deleting it leaves the current one alone.
            bt.panels.get(0).viewing = 2;
            await bt.deleteTake(0);
            let after = bt.getDirection(context.chat[0]);
            eq('deleting a take from the history leaves the current one', after.lines[0].instruction, 'New.');
            eq('and removes just that one', after.history.map(h => h.lines[0].instruction), ['Old.']);

            await bt.deleteTake(0);
            after = bt.getDirection(context.chat[0]);
            eq('deleting the current take promotes the one behind it',
               after.lines[0].instruction, 'Old.');
            eq('which leaves nothing behind it', after.history.length, 0);

            await bt.deleteTake(0);
            eq('deleting the last take leaves no direction at all',
               context.chat[0].extra.breeze_direction ?? null, null);
            eq('still nothing to delete', await bt.deleteTake(0) ?? null, null);

            // Every control the panel builds, run rather than merely bound —
            // the toolbar's blank, delete and pre-generate buttons and each
            // paragraph's own icons. A name that stopped resolving inside one
            // is invisible until the button is pressed.
            context.chat[0].extra.breeze_direction = {
                swipe_id: 0, ts: 3, lines: take('New.'), history: [{ ts: 2, lines: take('Old.') }],
            };
            bt.panels.get(0)?.root.remove();
            bt.panels.delete(0);
            const marker = built.length;
            await bt.openPanel(0);
            const fired = await fireAll(marker, 'player panel');
            eq('the panel bound handlers, and they ran', fired > 5, true);

            // Pressing play left the player running, and the buttons that do not
            // await their work left promises in flight. A repaint landing during
            // a later section would build elements that section then fires as
            // its own, so let them finish here and stop the player after.
            for (let i = 0; i < 100; i++) await Promise.resolve();
            bt.player.stop();
            bt.panels.get(0)?.root.remove();
            bt.panels.delete(0);
        } catch (error) {
            fails++;
            print('  FAIL blank takes threw: ' + error);
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
                assignedVoice: () => null,
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
