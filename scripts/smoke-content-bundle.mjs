import vm from 'node:vm';
import { readFirefoxContentBundle } from './lib/firefox-bundle.mjs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function makeDomStubs() {
    const el = {
        addEventListener() {},
        removeEventListener() {},
        remove() {},
        querySelector: () => null,
        querySelectorAll: () => [],
        closest: () => null,
        contains: () => false,
        appendChild() {},
        insertAdjacentElement() {},
        getAttribute: () => null,
        setAttribute() {},
        classList: { add() {}, remove() {} },
        parentElement: null,
        nextElementSibling: null,
        previousElementSibling: null,
        children: [],
        childNodes: [],
    };
    el.parentElement = el;

    const document = {
        documentElement: el,
        body: el,
        head: el,
        querySelector: () => null,
        querySelectorAll: () => [],
        getElementById: () => null,
        contains: () => true,
        createElement: () => ({ ...el, style: { setProperty() {} }, attachShadow: () => ({ appendChild() {} }) }),
        addEventListener() {},
    };

    return document;
}

/**
 * Runs the same concatenated content.js as Chromium/Firefox releases.
 * Catches missing modules (ReferenceError on startup) before shipping a zip.
 */
export async function smokeContentBundle() {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const bundle = await readFirefoxContentBundle(pkg.version);
    const document = makeDomStubs();
    const location = {
        pathname: '/search/vacancy',
        href: 'https://nn.hh.ru/search/vacancy',
        search: '',
        origin: 'https://nn.hh.ru',
    };

    const context = {
        console,
        addEventListener() {},
        removeEventListener() {},
        setTimeout,
        clearTimeout,
        setInterval: () => 0,
        clearInterval() {},
        requestIdleCallback: (fn) => setTimeout(() => fn({ didTimeout: false, timeRemaining: () => 50 }), 0),
        cancelIdleCallback: clearTimeout,
        requestAnimationFrame: (fn) => setTimeout(fn, 0),
        cancelAnimationFrame: clearTimeout,
        MutationObserver: class MutationObserver {
            observe() {}

            disconnect() {}

            takeRecords() {
                return [];
            }
        },
        history: { pushState() {}, replaceState() {} },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        CustomEvent: class CustomEvent {
            constructor(type, init) {
                this.type = type;
                this.detail = init?.detail;
            }
        },
        document,
        location,
        navigator: { sendBeacon: () => true },
        fetch: async () => ({ ok: false, text: async () => '', json: async () => ({}) }),
        chrome: { runtime: { getURL: (path) => path } },
        Element: class Element {},
        Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
        URL,
        URLSearchParams,
    };
    context.window = context;
    context.self = context;
    context.globalThis = context;

    try {
        vm.runInNewContext(bundle, context, { timeout: 5000 });
    } catch (error) {
        throw new Error(`content bundle smoke (startup): ${error.message}`);
    }

    const required = [
        'detectPage',
        'applyNegotiationBadges',
        'mountOnVacancyPage',
        'mountOnSearchCard',
        'scan',
    ];
    const missing = required.filter((name) => typeof context[name] !== 'function');
    if (missing.length > 0) {
        throw new Error(`content bundle smoke: missing globals ${missing.join(', ')}`);
    }

    if (context.detectPage('/search/vacancy') !== 'search') {
        throw new Error('content bundle smoke: detectPage broken');
    }
    if (context.detectPage('/applicant/negotiations') !== 'negotiations') {
        throw new Error('content bundle smoke: detectPage negotiations broken');
    }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
    await smokeContentBundle();
    console.log('ok: content bundle smoke');
}