import path from 'node:path';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { getAdminSession } from '@/lib/adminAuth';
import { resolveStoragePath, STORAGE_ROOT } from '@/lib/localStorage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.3gp': 'video/3gpp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
};

function isPublicFile(parts) {
  return parts[0] === 'courses'
    || (parts[0] === 'Payments' && parts[1] === 'payment-qr');
}

async function serve(request, context, headOnly = false) {
  let fileRealPath = null;
  try {
    const { path: parts = [] } = await context.params;
    if (!Array.isArray(parts) || !parts.length || parts.some((part) => (
      typeof part !== 'string' || !part || part === '.' || part === '..' || part.includes('/') || part.includes('\\')
    ))) {
      return new Response('Not found', { status: 404 });
    }

    // Payment proofs and the general "other" area are private and require an admin session.
    if (!isPublicFile(parts)) {
      const user = await getAdminSession();
      if (!user) return new Response('Unauthorized', { status: 401 });
    }

    const filePath = resolveStoragePath(parts.join('/'));
    const [storageRealPath, resolvedFilePath] = await Promise.all([
      realpath(STORAGE_ROOT),
      realpath(filePath),
    ]);
    if (!resolvedFilePath.startsWith(`${storageRealPath}${path.sep}`)) {
      return new Response('Not found', { status: 404 });
    }
    fileRealPath = resolvedFilePath;

    const info = await stat(fileRealPath);
    if (!info.isFile()) return new Response('Not found', { status: 404 });

    const extension = path.extname(fileRealPath).toLowerCase();
    const type = MIME_TYPES[extension] || 'application/octet-stream';
    const isPrivate = !isPublicFile(parts);
    const headers = new Headers({
      'Content-Type': type,
      'Content-Length': String(info.size),
      'Accept-Ranges': 'bytes',
      'Cache-Control': isPrivate ? 'private, no-store' : 'public, max-age=3600',
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
    });

    const range = request.headers.get('range');
    if (range && type.startsWith('video/')) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${info.size}` },
        });
      }

      let start;
      let end;
      if (!match[1]) {
        const suffixLength = Number(match[2]);
        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } });
        }
        start = Math.max(0, info.size - suffixLength);
        end = info.size - 1;
      } else {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : info.size - 1;
      }

      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= info.size) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } });
      }
      end = Math.min(end, info.size - 1);
      headers.set('Content-Range', `bytes ${start}-${end}/${info.size}`);
      headers.set('Content-Length', String(end - start + 1));
      const stream = headOnly ? null : Readable.toWeb(createReadStream(fileRealPath, { start, end }));
      return new Response(stream, { status: 206, headers });
    }

    const stream = headOnly ? null : Readable.toWeb(createReadStream(fileRealPath));
    return new Response(stream, { status: 200, headers });
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'EACCES' && error?.code !== 'EPERM') {
      console.error('Local file serving error:', error);
    } else if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      console.error('Local file permissions error:', error);
      return new Response('File is not accessible.', { status: 500 });
    }
    return new Response('Not found', { status: 404 });
  }
}

export async function GET(request, context) {
  return serve(request, context, false);
}

export async function HEAD(request, context) {
  return serve(request, context, true);
}
