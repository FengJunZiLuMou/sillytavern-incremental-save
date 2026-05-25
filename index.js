import { eventSource, event_types, getRequestHeaders } from '../../../script.js';
import { getStringHash } from '../../utils.js';

const PLUGIN_BASE = '/api/plugins/incremental-save';
const IMAGE_PROXY_PATH = `${PLUGIN_BASE}/image-proxy`;
const STATUS_PATH = `${PLUGIN_BASE}/status`;
const SAVE_APPEND_PATH = `${PLUGIN_BASE}/chats/save-append`;
const GROUP_SAVE_APPEND_PATH = `${PLUGIN_BASE}/chats/group/save-append`;

const state = {
    enabled: true,
    serverReady: false,
    warnedMissingServer: false,
    chat: {
        name: null,
        length: 0,
        hash: null,
    },
    group: {
        id: null,
        length: 0,
        hash: null,
    },
};

const nativeFetch = window.fetch.bind(window);
const originalImageSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');

function log(...args) {
    console.debug('[IncrementalSave]', ...args);
}

function warnOnce(message) {
    if (state.warnedMissingServer) {
        return;
    }

    state.warnedMissingServer = true;
    console.warn(`[IncrementalSave] ${message}`);
}

function isObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function getRequestUrl(input) {
    if (typeof input === 'string') {
        return input;
    }

    if (input instanceof URL) {
        return input.pathname + input.search;
    }

    if (input instanceof Request) {
        try {
            const url = new URL(input.url, location.href);
            return url.pathname + url.search;
        } catch {
            return input.url;
        }
    }

    return '';
}

async function readJsonBody(input, init) {
    const body = init?.body;
    if (typeof body === 'string') {
        return JSON.parse(body);
    }

    if (input instanceof Request) {
        const text = await input.clone().text();
        return JSON.parse(text);
    }

    return null;
}

function cloneHeaders(headersLike) {
    return new Headers(headersLike || getRequestHeaders());
}

async function postJson(url, payload, sourceInit) {
    const headers = cloneHeaders(sourceInit?.headers);
    headers.set('content-type', 'application/json');

    return nativeFetch(url, {
        method: 'POST',
        cache: 'no-cache',
        headers,
        body: JSON.stringify(payload),
    });
}

function computeChatHash(chatArray, upToIndex) {
    const serialized = Array.isArray(chatArray) ? chatArray.slice(0, upToIndex) : [];
    return getStringHash(JSON.stringify(serialized));
}

function computeGroupChatHash(chatArray, upToIndex) {
    return computeChatHash(chatArray, upToIndex);
}

function resetChatState() {
    state.chat.name = null;
    state.chat.length = 0;
    state.chat.hash = null;
}

function resetGroupState() {
    state.group.id = null;
    state.group.length = 0;
    state.group.hash = null;
}

function updateChatState(fileName, messages) {
    state.chat.name = fileName || null;
    state.chat.length = Array.isArray(messages) ? messages.length : 0;
    state.chat.hash = Array.isArray(messages) ? computeChatHash(messages, messages.length) : null;
}

function updateGroupState(chatId, messages) {
    state.group.id = chatId || null;
    state.group.length = Array.isArray(messages) ? messages.length : 0;
    state.group.hash = Array.isArray(messages) ? computeGroupChatHash(messages, messages.length) : null;
}

function getIncrementalPayloadForChat(body) {
    if (!state.serverReady || !isObject(body) || body.force || !Array.isArray(body.chat)) {
        return null;
    }

    const header = body.chat[0];
    const messages = body.chat.slice(1);
    const fileName = body.file_name;
    const isSameChat = fileName && fileName === state.chat.name && state.chat.length > 0;
    if (!isSameChat) {
        return null;
    }

    const hasNewMessages = messages.length > state.chat.length;
    const isSameLength = messages.length === state.chat.length;
    const oldMessagesUnchanged = computeChatHash(messages, state.chat.length) === state.chat.hash;
    const canAppend = hasNewMessages && oldMessagesUnchanged;
    const canHeaderOnly = isSameLength && oldMessagesUnchanged;

    if (!canAppend && !canHeaderOnly) {
        return null;
    }

    return {
        url: SAVE_APPEND_PATH,
        payload: {
            file_name: fileName,
            avatar_url: body.avatar_url,
            header,
            newMessages: canAppend ? messages.slice(state.chat.length) : [],
            expectedLines: state.chat.length + 1,
        },
        onSuccess: () => updateChatState(fileName, messages),
    };
}

function getIncrementalPayloadForGroup(body) {
    if (!state.serverReady || !isObject(body) || body.force || !body.id || !Array.isArray(body.chat)) {
        return null;
    }

    const header = body.chat[0];
    const messages = body.chat.slice(1);
    const chatId = body.id;
    const isSameGroup = chatId === state.group.id && state.group.length > 0;
    if (!isSameGroup) {
        return null;
    }

    const hasNewMessages = messages.length > state.group.length;
    const isSameLength = messages.length === state.group.length;
    const oldMessagesUnchanged = computeGroupChatHash(messages, state.group.length) === state.group.hash;
    const canAppend = hasNewMessages && oldMessagesUnchanged;
    const canHeaderOnly = isSameLength && oldMessagesUnchanged;

    if (!canAppend && !canHeaderOnly) {
        return null;
    }

    return {
        url: GROUP_SAVE_APPEND_PATH,
        payload: {
            id: chatId,
            header,
            newMessages: canAppend ? messages.slice(state.group.length) : [],
            expectedLines: state.group.length + 1,
        },
        onSuccess: () => updateGroupState(chatId, messages),
    };
}

async function tryIncrementalSave(input, init, url) {
    let body;
    try {
        body = await readJsonBody(input, init);
    } catch {
        return null;
    }

    const incremental = url === '/api/chats/save'
        ? getIncrementalPayloadForChat(body)
        : getIncrementalPayloadForGroup(body);

    if (!incremental) {
        return null;
    }

    const response = await postJson(incremental.url, incremental.payload, init);
    if (response.ok) {
        log('incremental save ok', url, incremental.payload.newMessages.length);
        incremental.onSuccess();
        return response;
    }

    console.warn('[IncrementalSave] incremental save failed, falling back to full save', response.status);
    return null;
}

async function fetchInterceptor(input, init) {
    const url = getRequestUrl(input);

    if (state.enabled && (url === '/api/chats/save' || url === '/api/chats/group/save')) {
        const incrementalResponse = await tryIncrementalSave(input, init, url);
        if (incrementalResponse) {
            return incrementalResponse;
        }
    }

    const response = await nativeFetch(input, init);

    if (state.enabled && response.ok) {
        try {
            const body = await readJsonBody(input, init);
            if (url === '/api/chats/save' && isObject(body) && Array.isArray(body.chat)) {
                updateChatState(body.file_name, body.chat.slice(1));
            } else if (url === '/api/chats/group/save' && isObject(body) && Array.isArray(body.chat)) {
                updateGroupState(body.id, body.chat.slice(1));
            }
        } catch {
            // Tracking is best-effort. Full saves are still authoritative.
        }
    }

    return response;
}

function shouldProxyImageUrl(value) {
    if (typeof value !== 'string' || !state.serverReady) {
        return false;
    }

    try {
        const url = new URL(value, location.href);
        if (!['http:', 'https:'].includes(url.protocol)) {
            return false;
        }

        if (url.origin === location.origin) {
            return false;
        }

        if (url.pathname.startsWith('/api/plugins/incremental-save/image-proxy')) {
            return false;
        }

        return true;
    } catch {
        return false;
    }
}

function toProxyImageUrl(value) {
    return `${IMAGE_PROXY_PATH}?url=${encodeURIComponent(value)}`;
}

function installImageInterceptor() {
    if (!originalImageSrcDescriptor?.set) {
        return;
    }

    Object.defineProperty(HTMLImageElement.prototype, 'src', {
        ...originalImageSrcDescriptor,
        set(value) {
            const nextValue = shouldProxyImageUrl(value) ? toProxyImageUrl(value) : value;
            originalImageSrcDescriptor.set.call(this, nextValue);
        },
    });
}

function rewriteExistingImages(root = document) {
    if (!state.serverReady || !root?.querySelectorAll) {
        return;
    }

    const images = root.matches?.('img') ? [root] : Array.from(root.querySelectorAll('img'));
    for (const image of images) {
        const src = image.getAttribute('src');
        if (shouldProxyImageUrl(src)) {
            image.dataset.incrementalSaveOriginalSrc = src;
            image.setAttribute('src', toProxyImageUrl(src));
        }
    }
}

function startImageObserver() {
    rewriteExistingImages();

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.type === 'attributes' && mutation.attributeName === 'src') {
                rewriteExistingImages(mutation.target);
                continue;
            }

            for (const node of mutation.addedNodes) {
                if (node instanceof HTMLElement) {
                    rewriteExistingImages(node);
                }
            }
        }
    });

    observer.observe(document.body, {
        attributes: true,
        attributeFilter: ['src'],
        childList: true,
        subtree: true,
    });
}

async function checkServerPlugin() {
    try {
        const response = await nativeFetch(STATUS_PATH, {
            method: 'GET',
            cache: 'no-cache',
            headers: getRequestHeaders(),
        });
        state.serverReady = response.ok;
    } catch {
        state.serverReady = false;
    }

    if (!state.serverReady) {
        warnOnce('server plugin is not available; full saves and direct images will be used.');
    }
}

function exposeDebugApi() {
    window.STIncrementalSave = {
        state,
        reset() {
            resetChatState();
            resetGroupState();
        },
        enable() {
            state.enabled = true;
        },
        disable() {
            state.enabled = false;
        },
    };
}

async function init() {
    await checkServerPlugin();
    window.fetch = fetchInterceptor;
    installImageInterceptor();
    startImageObserver();
    exposeDebugApi();

    eventSource.on(event_types.CHAT_CHANGED, () => {
        resetChatState();
        resetGroupState();
    });
    eventSource.on(event_types.GROUP_UPDATED, resetGroupState);

    log(`loaded; server plugin ${state.serverReady ? 'ready' : 'missing'}`);
}

init();
