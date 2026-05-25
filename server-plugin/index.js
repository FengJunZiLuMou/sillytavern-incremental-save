import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import sanitize from 'sanitize-filename';

export const info = {
    id: 'incremental-save',
    name: 'Incremental Save',
    description: 'Append-only chat save and external image proxy cache for SillyTavern.',
};

const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const IMAGE_CACHE_MAX_AGE = 30 * 24 * 60 * 60;
const IMAGE_CACHE_MAX_AGE_MS = IMAGE_CACHE_MAX_AGE * 1000;
const IMAGE_CACHE_DIR = 'cache/images';
const inFlightImages = new Map();

function isPathUnderParent(parent, child) {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function tryWriteFileSync(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, data, 'utf8');
}

function readTextFile(filePath) {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function tryParseJson(value) {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function readFirstLine(filePath) {
    const data = readTextFile(filePath);
    const firstNewline = data.indexOf('\n');
    return firstNewline >= 0 ? data.slice(0, firstNewline) : data;
}

function checkChatIntegrity(filePath, integritySlug) {
    if (!fs.existsSync(filePath) || !integritySlug) {
        return true;
    }

    const jsonData = tryParseJson(readFirstLine(filePath));
    const currentIntegrity = jsonData?.chat_metadata?.integrity;
    return !currentIntegrity || currentIntegrity === integritySlug;
}

async function countJsonlLines(filePath) {
    return new Promise((resolve, reject) => {
        let lineBreaks = 0;
        let hasData = false;
        let lastByte = null;
        const stream = fs.createReadStream(filePath);

        stream.on('data', (chunk) => {
            hasData = true;
            lastByte = chunk[chunk.length - 1];
            for (let index = 0; index < chunk.length; index++) {
                if (chunk[index] === 10) {
                    lineBreaks++;
                }
            }
        });
        stream.on('end', () => resolve(hasData ? (lastByte === 10 ? lineBreaks : lineBreaks + 1) : 0));
        stream.on('error', reject);
    });
}

function fileEndsWithNewline(filePath) {
    const stats = fs.statSync(filePath);
    if (stats.size === 0) {
        return false;
    }

    const fd = fs.openSync(filePath, 'r');
    try {
        const buffer = Buffer.alloc(1);
        fs.readSync(fd, buffer, 0, 1, stats.size - 1);
        return buffer[0] === 10;
    } finally {
        fs.closeSync(fd);
    }
}

function getBackupFileName(name) {
    const safeName = sanitize(String(name || 'chat')).replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
    return `chat_${safeName}_${stamp}.jsonl`;
}

function backupChat(request, backupName, data) {
    const backupDirectory = request.user?.directories?.backups;
    if (!backupDirectory) {
        return;
    }

    try {
        fs.mkdirSync(backupDirectory, { recursive: true });
        tryWriteFileSync(path.join(backupDirectory, getBackupFileName(backupName)), data);
    } catch (error) {
        console.error('[IncrementalSave] backup failed', error);
    }
}

async function appendChatFile(filePath, header, newMessages, expectedLines, request, backupName) {
    if (!fs.existsSync(filePath)) {
        return { ok: false, error: 'file_not_found' };
    }

    if (!checkChatIntegrity(filePath, header?.chat_metadata?.integrity)) {
        return { ok: false, error: 'integrity' };
    }

    const actualLines = await countJsonlLines(filePath);
    if (actualLines !== expectedLines) {
        console.warn(`[IncrementalSave] line mismatch for ${filePath}: expected ${expectedLines}, got ${actualLines}`);
        return { ok: false, error: 'line_mismatch', actualLines };
    }

    const headerLine = JSON.stringify(header);
    const appendRows = newMessages.map(message => JSON.stringify(message)).join('\n');
    const appendData = appendRows ? `${fileEndsWithNewline(filePath) ? '' : '\n'}${appendRows}` : '';
    const existingData = readTextFile(filePath);
    const firstNewline = existingData.indexOf('\n');
    const restOfFile = firstNewline >= 0 ? existingData.substring(firstNewline) : '';
    const newData = headerLine + restOfFile + appendData;

    tryWriteFileSync(filePath, newData);
    backupChat(request, backupName, newData);
    return { ok: true };
}

function sendAppendResult(response, result) {
    if (result.ok) {
        return response.send({ ok: true });
    }

    if (result.error === 'line_mismatch') {
        return response.status(409).send({ error: result.error, actualLines: result.actualLines });
    }

    return response.status(409).send({ error: result.error || 'append_failed' });
}

function hashUrl(url) {
    return crypto.createHash('sha256').update(url).digest('hex');
}

function isValidExternalImageUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}

function getImageCacheDir(request) {
    return path.resolve(request.user.directories.root, IMAGE_CACHE_DIR);
}

function getExtensionFromContentType(contentType) {
    if (contentType.includes('png')) return '.png';
    if (contentType.includes('jpeg') || contentType.includes('jpg')) return '.jpg';
    if (contentType.includes('gif')) return '.gif';
    if (contentType.includes('webp')) return '.webp';
    if (contentType.includes('svg')) return '.svg';
    if (contentType.includes('avif')) return '.avif';
    if (contentType.includes('bmp')) return '.bmp';
    return '';
}

function removeCachedImage(cacheDir, hash) {
    try {
        for (const file of fs.readdirSync(cacheDir)) {
            if (file === `${hash}.meta.json` || (file.startsWith(hash) && !file.endsWith('.meta.json'))) {
                fs.rmSync(path.join(cacheDir, file), { force: true });
            }
        }
    } catch {
        // Best effort cleanup only. A failed cleanup should not block image loading.
    }
}

function findCachedImage(cacheDir, hash) {
    const metaPath = path.join(cacheDir, `${hash}.meta.json`);
    if (!fs.existsSync(metaPath)) {
        return null;
    }

    try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        const cachedAt = Date.parse(meta.cachedAt || '');
        if (!cachedAt || Date.now() - cachedAt > IMAGE_CACHE_MAX_AGE_MS) {
            removeCachedImage(cacheDir, hash);
            return null;
        }

        const file = fs.readdirSync(cacheDir).find(name => name.startsWith(hash) && !name.endsWith('.meta.json'));
        if (!file) {
            removeCachedImage(cacheDir, hash);
            return null;
        }

        return {
            filePath: path.join(cacheDir, file),
            contentType: meta.contentType || 'application/octet-stream',
        };
    } catch {
        return null;
    }
}

async function fetchAndCacheImage(url, cacheDir, hash) {
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; SillyTavern Incremental Save Image Proxy)',
            Accept: 'image/*,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
        throw new Error(`Remote server returned ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_IMAGE_SIZE) {
        throw new Error(`Image too large: ${contentLength}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_IMAGE_SIZE) {
        throw new Error(`Image too large: ${buffer.length}`);
    }

    fs.mkdirSync(cacheDir, { recursive: true });
    const filePath = path.join(cacheDir, `${hash}${getExtensionFromContentType(contentType)}`);
    fs.writeFileSync(filePath, buffer);
    fs.writeFileSync(path.join(cacheDir, `${hash}.meta.json`), JSON.stringify({
        url,
        contentType,
        size: buffer.length,
        cachedAt: new Date().toISOString(),
    }, null, 2));

    return { filePath, contentType };
}

async function getCachedOrFetchImage(url, cacheDir, hash) {
    const cached = findCachedImage(cacheDir, hash);
    if (cached) {
        return { ...cached, cache: 'HIT' };
    }

    let promise = inFlightImages.get(url);
    if (!promise) {
        promise = fetchAndCacheImage(url, cacheDir, hash);
        inFlightImages.set(url, promise);
        promise.finally(() => inFlightImages.delete(url));
    }

    const fetched = await promise;
    return { ...fetched, cache: 'MISS' };
}

export async function init(router) {
    router.get('/status', (_, response) => response.send({ ok: true, plugin: info.id }));

    router.post('/chats/save-append', async (request, response) => {
        try {
            const { file_name: fileName, avatar_url: avatarUrl, header, newMessages, expectedLines } = request.body || {};
            if (!fileName || !avatarUrl || !header || !Array.isArray(newMessages) || !Number.isInteger(expectedLines)) {
                return response.status(400).send({ error: 'invalid_request' });
            }

            const cardName = String(avatarUrl).replace('.png', '');
            const chatFileName = `${String(fileName)}.jsonl`;
            const filePath = path.join(request.user.directories.chats, cardName, sanitize(chatFileName));
            if (!isPathUnderParent(request.user.directories.chats, filePath)) {
                return response.sendStatus(400);
            }

            const result = await appendChatFile(filePath, header, newMessages, expectedLines, request, cardName);
            return sendAppendResult(response, result);
        } catch (error) {
            console.error('[IncrementalSave] save append failed', error);
            return response.status(500).send({ error: 'append_failed' });
        }
    });

    router.post('/chats/group/save-append', async (request, response) => {
        try {
            const { id, header, newMessages, expectedLines } = request.body || {};
            if (!id || !header || !Array.isArray(newMessages) || !Number.isInteger(expectedLines)) {
                return response.status(400).send({ error: 'invalid_request' });
            }

            const filePath = path.join(request.user.directories.groupChats, sanitize(`${id}.jsonl`));
            if (!isPathUnderParent(request.user.directories.groupChats, filePath)) {
                return response.sendStatus(400);
            }

            const result = await appendChatFile(filePath, header, newMessages, expectedLines, request, String(id));
            return sendAppendResult(response, result);
        } catch (error) {
            console.error('[IncrementalSave] group save append failed', error);
            return response.status(500).send({ error: 'append_failed' });
        }
    });

    router.get('/image-proxy', async (request, response) => {
        const { url } = request.query;
        if (!url || typeof url !== 'string') {
            return response.status(400).send('Missing url parameter');
        }

        if (!isValidExternalImageUrl(url)) {
            return response.status(400).send('Invalid URL');
        }

        try {
            const cacheDir = getImageCacheDir(request);
            const hash = hashUrl(url);
            const image = await getCachedOrFetchImage(url, cacheDir, hash);

            response.setHeader('Content-Type', image.contentType);
            response.setHeader('Cache-Control', `public, max-age=${IMAGE_CACHE_MAX_AGE}`);
            response.setHeader('X-Image-Cache', image.cache);
            return response.sendFile(image.filePath);
        } catch (error) {
            console.error(`[IncrementalSave] image proxy failed for ${url}`, error);
            return response.status(502).send('Failed to fetch image');
        }
    });
}
