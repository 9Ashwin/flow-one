// Wire this bridge into DSH (DeepSeek Harness).
//
// Why a separate module: it touches **someone else's** two files — the profile's
// `cordis.patch.yml` (where the `llm-pi-ai` provider is written) and the credential
// seam `.credentials.yaml` (where the bridge's gate token is stored). A bad write keeps
// DSH from starting, so this logic has to be testable offline.
//
// Two rules (the same as install.ts):
//
// 1. **Touch only the section this tool writes**: the provider is fenced by comment
// markers, a rerun replaces the whole section, uninstall removes it; old hand-written
// entries (without markers) are cleaned up on write so the same key never appears twice.
// 2. **Back up before writing** (`<file>.bak-<timestamp>`).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from "./atomic.js";
/** DSH's data directory; `DSH_HOME` redirects it (matching how config.ts reads the gateway key). */
export function dshHome(env = process.env, home = os.homedir()) {
    const override = String(env.DSH_HOME ?? '').trim();
    return override !== '' ? path.resolve(override) : path.join(home, '.dsh');
}
/** The profile config: desktop first, then web. Neither means DSH was never installed here. */
export function dshProfileFile({ env = process.env, home = os.homedir(), exists = fs.existsSync } = {}) {
    const root = path.join(dshHome(env, home), 'profiles');
    for (const profile of ['desktop', 'web']) {
        const file = path.join(root, profile, 'cordis.patch.yml');
        if (exists(file))
            return { file, profile };
    }
    return undefined;
}
/** The credential seam file. */
export function dshCredentialFile({ env = process.env, home = os.homedir() } = {}) {
    return path.join(dshHome(env, home), '.credentials.yaml');
}
/**
 * The provider-level default reasoning level (DSH's `reasoning` field, values as in
 * THINKING_LEVELS).
 *
 * Without this field DSH's model picker shows `Default` and the upstream decides —
 * measured: the same sentence passes under both Default and high, but "default" means
 * behaviour drifts with the upstream. It is pinned to high here, matching DSH's own
 * `opencode-go` provider (which also writes `reasoning: high`). To change:
 * `fo setup --dsh-reasoning max`, or `FO_DSH_REASONING=medium`; `none` = do not write it.
 */
export const DEFAULT_DSH_REASONING = 'high';
/** The provider's `apiKeyEnv` points at this reference name. */
export const CREDENTIAL_REF = 'FLOW_ONE_BRIDGE_KEY';
/**
 * The managed block's begin/end markers. Edits inside it are overwritten by the next
 * `fo setup`. The marker text stays Chinese on purpose: it is a **fence literal already
 * written into users' `cordis.patch.yml`**, not display text. Renaming it would make
 * existing managed blocks unrecognisable, so a rerun would duplicate the provider and
 * uninstall would leave it behind.
 */
export const BLOCK_BEGIN = '# >>> flow-one 托管：DSH provider（由 `fo setup` 维护，手改会被覆盖）>>>';
export const BLOCK_END = '# <<< flow-one 托管：DSH provider <<<';
/** DSH only gets the two Tencent lines (oc/ocg already have their own providers there). */
export const DSH_SOURCE_IDS = ['cn', 'intl'];
const ROUTES = { cn: 'workbuddy-cn', intl: 'workbuddy-intl' };
const LABELS = { cn: 'WorkBuddy China edition (CodeBuddy)', intl: 'WorkBuddy International' };
/**
 * Only the two Tencent lines are written into DSH: `oc/` and `ocg/` already have
 * their own providers there, and a second copy only duplicates entries in the model
 * picker.
 */
export function dshSources(rows) {
    const groups = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
        const id = String(row?.id ?? '');
        const slash = id.indexOf('/');
        if (slash <= 0)
            continue;
        const product = id.slice(0, slash);
        if (ROUTES[product] === undefined)
            continue;
        const bucket = groups.get(product);
        if (bucket === undefined)
            groups.set(product, [row]);
        else
            bucket.push(row);
    }
    return [...groups].map(([id, models]) => ({ id, models }));
}
/**
 * Detect a file's newline style.
 *
 * Hand-edited configuration on Windows is often CRLF. This tool only inserts lines and
 * never rewrites existing ones, so the inserted lines must follow the file — turning a
 * CRLF file into a mixed one would be a change nobody asked for.
 */
export function newlineOf(text) {
    return String(text).includes('\r\n') ? '\r\n' : '\n';
}
/**
 * The input types a model can handle.
 *
 * DSH's documentation is explicit: omitting `input` inherits the adapter default, and
 * declaring what the upstream really accepts is the configurer's job. The upstream
 * catalogue carries `supportsImages`, which decides between `[text, image]` and text
 * only; an unknown model gets text only — better conservative than sending an image to
 * a model that cannot read it (a user found images broken in DSH on 2026-10-22 because
 * this was missing).
 */
export function inputTypesOf(model) {
    if (Array.isArray(model?.input)) {
        const declared = model.input.filter((kind) => typeof kind === 'string' && kind !== '');
        if (declared.length > 0)
            return declared;
    }
    return model?.supportsImages === true ? ['text', 'image'] : ['text'];
}
const EFFORT_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
/**
 * The reasoning levels a model supports (ascending).
 *
 * The upstream catalogue carries `efforts` (only for models that declare levels,
 * 31 of 181). A model without them gets no `reasoningEfforts`: DSH should show "no
 * levels to pick" rather than a fake option.
 */
export function effortLevelsOf(model) {
    const efforts = Array.isArray(model?.efforts)
        ? model.efforts.filter(effort => typeof effort === 'string' && effort !== '' && effort !== 'off')
        : [];
    const rank = (effort) => {
        const at = EFFORT_ORDER.indexOf(effort);
        return at === -1 ? EFFORT_ORDER.length : at;
    };
    return [...new Set(efforts)].sort((a, b) => rank(a) - rank(b));
}
/** Render the managed block, markers included; `indent` matches the sibling provider. */
export function dshProviderBlock({ port, sources, indent = 6, reasoning = DEFAULT_DSH_REASONING, }) {
    const pad = (offset) => ' '.repeat(indent + offset);
    const lines = [pad(0) + BLOCK_BEGIN];
    for (const source of sources) {
        lines.push(`${pad(0)}${ROUTES[source.id]}:`);
        lines.push(`${pad(2)}displayName: "${LABELS[source.id]}"`);
        lines.push(`${pad(2)}apiKeyEnv: ${CREDENTIAL_REF}`);
        lines.push(`${pad(2)}api: anthropic-messages`);
        lines.push(`${pad(2)}baseURL: http://127.0.0.1:${port}`);
        if (reasoning !== '' && reasoning !== 'none')
            lines.push(`${pad(2)}reasoning: ${reasoning}`);
        lines.push(`${pad(2)}models:`);
        for (const model of source.models) {
            lines.push(`${pad(4)}- id: ${model.id}`);
            lines.push(`${pad(6)}name: "${String(model.name ?? model.id).replace(/"/g, "'")}"`);
            if (Number.isFinite(model.contextWindow))
                lines.push(`${pad(6)}contextWindow: ${model.contextWindow}`);
            if (Number.isFinite(model.maxOutputTokens))
                lines.push(`${pad(6)}maxTokens: ${model.maxOutputTokens}`);
            lines.push(`${pad(6)}input:`);
            for (const kind of inputTypesOf(model))
                lines.push(`${pad(8)}- ${kind}`);
            const efforts = effortLevelsOf(model);
            if (efforts.length > 0) {
                // The shape DSH itself writes: off first with a null value, other levels map to
                // their own name as the API value.
                lines.push(`${pad(6)}reasoningEfforts:`);
                lines.push(`${pad(8)}off: null`);
                for (const effort of efforts)
                    lines.push(`${pad(8)}${effort}: ${effort}`);
            }
        }
    }
    lines.push(pad(0) + BLOCK_END);
    return lines.join('\n');
}
function indentOf(line) {
    return line.length - line.trimStart().length;
}
/** Remove the managed block, markers included; returns the input unchanged when absent. */
export function stripManagedBlock(text) {
    const lines = String(text).split('\n');
    const out = [];
    let inside = false;
    for (const line of lines) {
        if (line.trim() === BLOCK_BEGIN) {
            inside = true;
            continue;
        }
        if (inside) {
            if (line.trim() === BLOCK_END)
                inside = false;
            continue;
        }
        out.push(line);
    }
    return out.join('\n');
}
/**
 * Remove hand-written `workbuddy-cn:` / `workbuddy-intl:` entries — the ones people
 * configured by hand before there were markers.
 *
 * The criterion is indentation: from that line onward, until the next line whose
 * indentation is not greater.
 */
export function stripLooseProviders(text) {
    const lines = String(text).split('\n');
    const out = [];
    let skipIndent = -1;
    for (const line of lines) {
        const trimmed = line.trim();
        if (skipIndent >= 0) {
            if (trimmed === '' || indentOf(line) > skipIndent)
                continue;
            skipIndent = -1;
        }
        if (/^\s*workbuddy-(cn|intl):\s*$/.test(line)) {
            skipIndent = indentOf(line);
            continue;
        }
        out.push(line);
    }
    return out.join('\n');
}
/**
 * Find the **end** of `providers:` inside the `llm-pi-ai` loader entry (the insertion
 * point) plus the sibling indentation.
 *
 * Inserting at the end rather than directly under `providers:` leaves existing
 * providers untouched, so the diff gains only our block ("every changed line must trace
 * back to the user's request").
 */
export function providersAnchor(text) {
    const lines = String(text).split('\n');
    const entry = lines.findIndex(line => /^\s*-\s*id:\s*['"]?llm-pi-ai['"]?\s*$/.test(line));
    if (entry === -1)
        return undefined;
    for (let i = entry + 1; i < lines.length; i++) {
        if (/^\s*-\s*id:/.test(lines[i]))
            break; // the next loader entry, so this one has no providers
        const match = /^(\s*)providers:\s*$/.exec(lines[i]);
        if (match === null)
            continue;
        const base = match[1].length;
        // Sibling indent = the first line deeper than providers; without one, use +2.
        let indent = base + 2;
        for (let j = i + 1; j < lines.length; j++) {
            if (lines[j].trim() === '' || lines[j].trim().startsWith('#'))
                continue;
            const sibling = indentOf(lines[j]);
            if (sibling > base)
                indent = sibling;
            break;
        }
        // The end = the last line still belonging to this providers mapping (blank or deeper).
        let last = i;
        for (let j = i + 1; j < lines.length; j++) {
            const line = lines[j];
            if (line.trim() === '') {
                last = j;
                continue;
            }
            if (indentOf(line) > base) {
                last = j;
                continue;
            }
            break;
        }
        return { line: last, indent };
    }
    return undefined;
}
function backup(file) {
    if (!fs.existsSync(file))
        return undefined;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = `${file}.bak-${stamp}`;
    fs.copyFileSync(file, target);
    return target;
}
/** Whether the managed block is already in the file. */
export function dshManagedIn(text) {
    return String(text).includes(BLOCK_BEGIN);
}
/** Write (or update) the DSH provider block. */
export function applyDshProviders({ file, port, sources, reasoning = DEFAULT_DSH_REASONING, backupFile = backup, }) {
    if (!fs.existsSync(file))
        return { ok: false, reason: `no DSH profile configuration found at ${file}` };
    const original = fs.readFileSync(file, 'utf8');
    let text = stripManagedBlock(stripLooseProviders(original));
    const anchor = providersAnchor(text);
    if (anchor === undefined) {
        return {
            ok: false,
            reason: `no llm-pi-ai providers section found in ${file} (a different DSH version?); add it by hand from \`fo client\``,
        };
    }
    const lines = text.split('\n');
    // In a CRLF file every inserted line must carry \r too, or the whole file becomes
    // mixed-newline.
    const cr = newlineOf(original) === '\r\n' ? '\r' : '';
    const block = dshProviderBlock({ port, sources, indent: anchor.indent, reasoning })
        .split('\n')
        .map(line => line + cr);
    lines.splice(anchor.line + 1, 0, ...block);
    text = lines.join('\n');
    if (text === original)
        return { ok: true, file, changed: false };
    const backupPath = backupFile(file);
    writeFileAtomic(file, text, 0o644);
    return { ok: true, file, changed: true, backup: backupPath };
}
/** Uninstall: remove only the managed block; hand-written content is left alone. */
export function removeDshProviders({ file, backupFile = backup, }) {
    if (!fs.existsSync(file))
        return { ok: true, removed: false };
    const original = fs.readFileSync(file, 'utf8');
    if (!dshManagedIn(original))
        return { ok: true, removed: false };
    const backupPath = backupFile(file);
    writeFileAtomic(file, stripManagedBlock(original), 0o644);
    return { ok: true, removed: true, backup: backupPath };
}
/** Whether DSH currently holds a managed provider block ("is this configuration ours?"). */
export function dshCurrentlyManaged({ env = process.env, home = os.homedir(), } = {}) {
    const target = dshProfileFile({ env, home });
    if (target === undefined)
        return false;
    try {
        return dshManagedIn(fs.readFileSync(target.file, 'utf8'));
    }
    catch {
        return false;
    }
}
/** Write the bridge token into DSH's credential seam (`refs.FLOW_ONE_BRIDGE_KEY`). */
export function setDshCredential({ file, apiKey, }) {
    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
        return { ok: false, reason: 'the token is empty, so there is nothing for DSH to reference' };
    }
    if (!fs.existsSync(file))
        return { ok: false, reason: `no DSH credential file found at ${file}` };
    const original = fs.readFileSync(file, 'utf8');
    const line = `  ${CREDENTIAL_REF}: "${apiKey}"`;
    let text;
    if (new RegExp(`^\\s*${CREDENTIAL_REF}:`, 'm').test(original)) {
        text = original.replace(new RegExp(`^\\s*${CREDENTIAL_REF}:.*$`, 'm'), line);
    }
    else if (/^refs:\s*$/m.test(original)) {
        text = original.replace(/^refs:\s*$/m, `refs:${newlineOf(original)}${line}`);
    }
    else {
        return { ok: false, reason: `${file} has no refs section (a different DSH version?)` };
    }
    if (text === original)
        return { ok: true, file, changed: false };
    const backupPath = backup(file);
    writeFileAtomic(file, text, 0o600);
    return { ok: true, file, changed: true, backup: backupPath };
}
/** Uninstall: remove the credential reference this tool wrote. */
export function removeDshCredential({ file, backupFile = backup, }) {
    if (!fs.existsSync(file))
        return { ok: true, removed: false };
    const original = fs.readFileSync(file, 'utf8');
    const pattern = new RegExp(`^\\s*${CREDENTIAL_REF}:.*\\n?`, 'm');
    if (!pattern.test(original))
        return { ok: true, removed: false };
    const backupPath = backupFile(file);
    writeFileAtomic(file, original.replace(pattern, ''), 0o600);
    return { ok: true, removed: true, backup: backupPath };
}
/**
 * The whole "configure DSH as well" step: provider block plus credential reference.
 */
export function applyDshConfig({ port, apiKey, rows, reasoning = DEFAULT_DSH_REASONING, env = process.env, home = os.homedir(), }) {
    const target = dshProfileFile({ env, home });
    if (target === undefined) {
        return {
            ok: false,
            reason: 'no profile configuration under ~/.dsh/profiles on this machine, so DSH cannot be configured; install DSH first, then run fo setup --clients dsh',
        };
    }
    const sources = dshSources(rows);
    if (sources.length === 0) {
        return {
            ok: false,
            reason: 'no cn/intl WorkBuddy model was mounted, so there is nothing to configure for DSH (run fo setup and pick a Tencent source first)',
        };
    }
    const providers = applyDshProviders({ file: target.file, port, sources, reasoning });
    if (providers.ok !== true)
        return providers;
    const credential = setDshCredential({ file: dshCredentialFile({ env, home }), apiKey });
    if (credential.ok !== true)
        return credential;
    return {
        ok: true,
        file: target.file,
        credential: dshCredentialFile({ env, home }),
        changed: providers.changed === true || credential.changed === true,
        backup: providers.backup ?? credential.backup,
        models: sources.reduce((sum, source) => sum + source.models.length, 0),
    };
}
/** Uninstall: remove both the provider section and the credential reference. */
export function removeDshConfig({ env = process.env, home = os.homedir() } = {}) {
    const target = dshProfileFile({ env, home });
    const providers = target === undefined ? { ok: true, removed: false } : removeDshProviders({ file: target.file });
    const credential = removeDshCredential({ file: dshCredentialFile({ env, home }) });
    return { providers, credential, removed: providers.removed === true || credential.removed === true };
}
