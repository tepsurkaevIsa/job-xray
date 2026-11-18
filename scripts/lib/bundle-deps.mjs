import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC_DIR = join(root, 'extension/src');

export const BUNDLE_ENTRY = 'extension/src/content.js';

const IMPORT_FROM_RE = /^\s*import\s[\s\S]*?\sfrom\s+['"](\.\/[^'"]+)['"];?\s*$/gm;

function toBundlePath(relativeImport) {
    return `extension/src/${relativeImport.replace(/^\.\//, '')}`;
}

/**
 * Local `./foo.js` imports for one extension module (content bundle sources only).
 */
export async function localImports(bundlePathRel) {
    const abs = join(root, bundlePathRel);
    const text = await readFile(abs, 'utf8');
    const paths = [];
    for (const match of text.matchAll(IMPORT_FROM_RE)) {
        paths.push(toBundlePath(match[1]));
    }
    return [...new Set(paths)];
}

/**
 * Dependency closure of `content.js` — every file that must be concatenated into the AMO/Chromium bundle.
 */
export async function bundleDependencyClosure(entryRel = BUNDLE_ENTRY) {
    const needed = new Set();
    const stack = [entryRel];

    while (stack.length > 0) {
        const file = stack.pop();
        if (needed.has(file)) {
            continue;
        }
        needed.add(file);
        const deps = await localImports(file);
        for (const dep of deps) {
            if (!dep.startsWith('extension/src/')) {
                throw new Error(`unexpected import path ${dep} in ${file}`);
            }
            stack.push(dep);
        }
    }

    return needed;
}

/**
 * Topological order: dependencies before dependents; `content.js` last.
 */
export async function resolveBundleOrder(entryRel = BUNDLE_ENTRY) {
    const visiting = new Set();
    const visited = new Set();
    const order = [];

    async function visit(file) {
        if (visited.has(file)) {
            return;
        }
        if (visiting.has(file)) {
            throw new Error(`circular import in content bundle graph at ${file}`);
        }
        visiting.add(file);
        const deps = await localImports(file);
        for (const dep of deps) {
            await visit(dep);
        }
        visiting.delete(file);
        visited.add(file);
        order.push(file);
    }

    await visit(entryRel);

    const closure = await bundleDependencyClosure(entryRel);
    if (order.length !== closure.size) {
        throw new Error('bundle order length mismatch vs dependency closure');
    }

    return order;
}

/** Files under extension/src that are never pulled in by content.js (hooks, loader). */
export async function assertNoOrphanContentModules(order) {
    const { readdir } = await import('node:fs/promises');
    const files = (await readdir(SRC_DIR))
        .filter((name) => name.endsWith('.js') && name !== 'network-hook.js')
        .map((name) => `extension/src/${name}`);

    const optional = new Set(['extension/src/network-hook.js']);
    const inBundle = new Set(order);
    const orphans = files.filter((rel) => !inBundle.has(rel) && !optional.has(rel));

    if (orphans.length > 0) {
        throw new Error(
            `extension/src modules not reachable from content.js (add to graph or exclude): ${orphans.join(', ')}`,
        );
    }
}

export function assertOrderMatchesClosure(order, closure) {
    const orderSet = new Set(order);
    const missing = [...closure].filter((rel) => !orderSet.has(rel));
    const extra = order.filter((rel) => !closure.has(rel));
    if (missing.length > 0) {
        throw new Error(`BUNDLE_ORDER missing modules: ${missing.join(', ')}`);
    }
    if (extra.length > 0) {
        throw new Error(`BUNDLE_ORDER has files not in content.js closure: ${extra.join(', ')}`);
    }
    if (order[order.length - 1] !== BUNDLE_ENTRY) {
        throw new Error(`bundle entry must be last (expected ${BUNDLE_ENTRY})`);
    }
}