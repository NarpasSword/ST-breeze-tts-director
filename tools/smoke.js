// Smoke-test the extension outside a browser:
//
//     gjs tools/smoke.js index.js
//
// Loads index.js under minimal stubs for the handful of browser and
// SillyTavern globals it touches, then runs its jQuery ready handler. This
// catches the failure that is otherwise invisible until the extension silently
// vanishes from the UI: anything that throws at module eval or during bind()
// aborts the rest of the file, so no settings panel, no buttons, no listeners.
//
// It proves the file loads. It does not exercise playback, casting or the LLM.

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
    () => print('ready handler OK'),
    (error) => {
        print('ready handler THREW: ' + error);
        print(String(error.stack || '').split('\n').slice(0, 8).join('\n'));
        imports.system.exit(1);
    },
);
