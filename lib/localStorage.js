import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, realpath, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const STORAGE_ROOT = path.resolve(
  process.env.STORAGE_DIR || '/home/mrh123/data/Project-1'
);

const PUBLIC_UPLOAD_PREFIX = '/api/uploads/';
const COURSE_DIRECTORIES = new Map([
  ['basic-of-computer', 'Basic of Computer'],
  ['basic-of-c-programming', 'Basic of C Programming'],
  ['basic-of-microsoft-excel', 'Basic of Microsoft Excel'],
  ['basic-of-ms-excel', 'Basic of Microsoft Excel'],
  ['basic-of-microsoft-powerpoint', 'Basic of Microsoft PowerPoint'],
  ['basic-of-ms-powerpoint', 'Basic of Microsoft PowerPoint'],
  ['basic-of-microsoft-word', 'Basic of Microsoft Word'],
  ['basic-of-ms-word', 'Basic of Microsoft Word'],
  ['basic-of-power-bi', 'Basic of Power BI'],
  ['basic-of-python', 'Basic of Python'],
  ['basic-of-sql', 'Basic of SQL'],
]);
const ALLOWED_ROOTS = new Set(['courses', 'Payments', 'Recipt']);
const COURSE_DIRECTORY_NAMES = new Set(COURSE_DIRECTORIES.values());

function assertInsideStorage(absolutePath, storageRealPath) {
  if (!absolutePath.startsWith(`${storageRealPath}${path.sep}`)) {
    throw new Error('Storage path is outside the configured data directory.');
  }
}

function safeSegment(value) {
  const segment = String(value ?? '').normalize('NFC').trim();
  if (
    !segment
    || segment === '.'
    || segment === '..'
    || segment.length > 120
    || /[\\/\u0000-\u001f\u007f]/.test(segment)
  ) {
    throw new Error('Invalid storage folder name.');
  }
  return segment;
}

function safeFileDetails(file) {
  const originalName = String(file?.name || 'upload').trim();
  if (!originalName || /[\\/\u0000-\u001f\u007f]/.test(originalName)) {
    throw new Error('Invalid file name.');
  }
  const extension = path.extname(originalName).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 12);
  const baseName = path.basename(originalName, path.extname(originalName))
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70) || 'file';

  return { originalName, extension, baseName };
}

export function courseStorageDirectory(course) {
  const slug = String(course?.slug || '').trim().toLowerCase();
  const title = String(course?.title || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const bySlug = COURSE_DIRECTORIES.get(slug);
  const byTitle = [...COURSE_DIRECTORIES.entries()]
    .find(([key]) => key.replaceAll('-', ' ') === title)?.[1];
  const directory = bySlug || byTitle;
  if (!directory) {
    throw new Error(`No existing course directory is configured for "${course?.title || course?.slug || 'this course'}".`);
  }
  return directory;
}

export function resolveStoragePath(relativePath) {
  const raw = String(relativePath || '').replace(/\\/g, '/');
  const segments = raw.split('/');
  if (!raw || raw.startsWith('/') || segments.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Invalid storage path.');
  }

  if (!ALLOWED_ROOTS.has(segments[0])) {
    throw new Error('Storage category is not allowed.');
  }
  if (segments[0] === 'courses' && (!segments[1] || !COURSE_DIRECTORY_NAMES.has(segments[1]))) {
    throw new Error('Course storage directory is not configured.');
  }

  const absolutePath = path.resolve(STORAGE_ROOT, ...segments);
  if (!absolutePath.startsWith(`${STORAGE_ROOT}${path.sep}`)) {
    throw new Error('Storage path is outside the configured data directory.');
  }
  return absolutePath;
}

export function storagePathFromUploadUrl(value) {
  if (typeof value !== 'string' || !value.startsWith(PUBLIC_UPLOAD_PREFIX)) return '';
  const pathname = value.split('?')[0];
  const encodedPath = pathname.slice(PUBLIC_UPLOAD_PREFIX.length);
  try {
    const relativePath = encodedPath.split('/').map((part) => decodeURIComponent(part)).join('/');
    resolveStoragePath(relativePath);
    return relativePath;
  } catch {
    return '';
  }
}

async function assertExistingStorageBase(folderSegments) {
  const baseSegments = folderSegments[0] === 'courses' ? folderSegments.slice(0, 2) : folderSegments.slice(0, 1);
  const basePath = resolveStoragePath(baseSegments.join('/'));
  const storageRealPath = await realpath(STORAGE_ROOT);
  const baseRealPath = await realpath(basePath);
  const baseInfo = await lstat(basePath);
  if (baseInfo.isSymbolicLink()) {
    throw new Error('Required existing storage directories cannot be symbolic links.');
  }
  assertInsideStorage(baseRealPath, storageRealPath);
  if (!baseInfo.isDirectory() || !(await stat(baseRealPath)).isDirectory()) {
    throw new Error(`Required existing storage directory is not a directory: ${baseSegments.join('/')}`);
  }
  return storageRealPath;
}

async function ensureStorageDirectories(folderSegments, storageRealPath) {
  const baseLength = folderSegments[0] === 'courses' ? 2 : 1;
  let directoryPath = resolveStoragePath(folderSegments.slice(0, baseLength).join('/'));

  for (const segment of folderSegments.slice(baseLength)) {
    directoryPath = path.join(directoryPath, segment);
    try {
      await mkdir(directoryPath, { mode: 0o750 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }

    const [directoryInfo, directoryRealPath] = await Promise.all([
      lstat(directoryPath),
      realpath(directoryPath),
    ]);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
      throw new Error('Storage subdirectories must be real directories, not symbolic links.');
    }
    assertInsideStorage(directoryRealPath, storageRealPath);
  }
}

export async function saveUploadedStream(stream, fileInfo, folderSegments, {
  allowedMimePrefixes,
  allowedExtensions,
  maxBytes,
} = {}) {
  const fileSize = Number(fileInfo?.size);
  if (!stream || typeof stream.pipe !== 'function') throw new Error('A readable file stream is required.');
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) throw new Error('A valid, non-empty file size is required.');
  if (maxBytes && fileSize > maxBytes) {
    throw new Error(`File exceeds the maximum size of ${Math.round(maxBytes / 1024 / 1024)} MB.`);
  }

  const mimeType = String(fileInfo?.type || 'application/octet-stream').toLowerCase();
  if (allowedMimePrefixes?.length && !allowedMimePrefixes.some((prefix) => mimeType.startsWith(prefix))) {
    throw new Error(`Unsupported file type: ${mimeType}`);
  }

  const { originalName, extension, baseName } = safeFileDetails({ name: fileInfo?.name });
  if (allowedExtensions?.length && !allowedExtensions.includes(extension)) {
    throw new Error(`Unsupported file extension: ${extension || '(none)'}`);
  }

  const safeFolders = folderSegments.map(safeSegment);
  if (
    !safeFolders.length
    || !ALLOWED_ROOTS.has(safeFolders[0])
    || (safeFolders[0] === 'courses' && !COURSE_DIRECTORY_NAMES.has(safeFolders[1]))
  ) {
    throw new Error('A valid existing storage directory is required.');
  }

  const storageRealPath = await assertExistingStorageBase(safeFolders);
  const filename = `${baseName}-${randomUUID()}${extension}`;
  const relativePath = [...safeFolders, filename].join('/');
  const absolutePath = resolveStoragePath(relativePath);
  let writtenBytes = 0;

  const sizeGuard = new Transform({
    transform(chunk, _encoding, callback) {
      writtenBytes += chunk.length;
      if (writtenBytes > fileSize || (maxBytes && writtenBytes > maxBytes)) {
        callback(new Error('Uploaded file size exceeded the declared or allowed size.'));
        return;
      }
      callback(null, chunk);
    },
  });

  await ensureStorageDirectories(safeFolders, storageRealPath);
  try {
    await pipeline(stream, sizeGuard, createWriteStream(absolutePath, { flags: 'wx', mode: 0o640 }));
    if (writtenBytes !== fileSize) {
      throw new Error(`Upload size mismatch. Expected ${fileSize} bytes but received ${writtenBytes} bytes.`);
    }
  } catch (error) {
    await unlink(absolutePath).catch((cleanupError) => {
      if (cleanupError?.code !== 'ENOENT') console.error('Incomplete upload cleanup failed:', cleanupError);
    });
    throw error;
  }

  const encodedPath = relativePath.split('/').map(encodeURIComponent).join('/');
  return {
    filename,
    relativePath,
    url: `${PUBLIC_UPLOAD_PREFIX}${encodedPath}`,
    mimeType,
    size: writtenBytes,
    originalName,
  };
}

export async function saveUploadedFile(file, folderSegments, options = {}) {
  if (!file || typeof file.stream !== 'function' || typeof file.size !== 'number') {
    throw new Error('A valid file is required.');
  }
  return saveUploadedStream(
    Readable.fromWeb(file.stream()),
    { name: file.name, type: file.type, size: file.size },
    folderSegments,
    options
  );
}

export async function storedFileExists(pathOrUrl) {
  const value = String(pathOrUrl || '');
  if (!value) return false;
  const relativePath = value.startsWith(PUBLIC_UPLOAD_PREFIX) ? storagePathFromUploadUrl(value) : value;
  if (!relativePath) throw new Error('Invalid stored file path.');

  const absolutePath = resolveStoragePath(relativePath);
  try {
    const [storageRealPath, fileRealPath, fileInfo] = await Promise.all([
      realpath(STORAGE_ROOT),
      realpath(absolutePath),
      stat(absolutePath),
    ]);
    assertInsideStorage(fileRealPath, storageRealPath);
    return fileInfo.isFile();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function deleteStoredFile(pathOrUrl) {
  const value = String(pathOrUrl || '');
  if (!value) return false;
  const relativePath = value.startsWith(PUBLIC_UPLOAD_PREFIX) ? storagePathFromUploadUrl(value) : value;
  if (!relativePath) throw new Error('Invalid stored file path.');

  const absolutePath = resolveStoragePath(relativePath);
  try {
    const [storageRealPath, fileRealPath, fileInfo] = await Promise.all([
      realpath(STORAGE_ROOT),
      realpath(absolutePath),
      lstat(absolutePath),
    ]);
    assertInsideStorage(fileRealPath, storageRealPath);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
      throw new Error('Only regular files inside the configured data directory can be deleted.');
    }
    await unlink(absolutePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
