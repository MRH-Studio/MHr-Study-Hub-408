import { getAdminSession } from '@/lib/adminAuth';
import { getDb } from '@/lib/mongodb';
import { courseStorageDirectory, deleteStoredFile, saveUploadedStream } from '@/lib/localStorage';
import { ObjectId } from 'mongodb';
import { Readable } from 'node:stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.m4v', '.avi', '.mkv', '.mpeg', '.mpg', '.3gp'];

function normalizeModuleList(modules = []) {
  return modules.map((module) => ({
    title: module.title || 'Module',
    videos: Array.isArray(module.videos) ? module.videos : [],
  }));
}

function courseFilterFor(courseId) {
  return {
    $or: [
      { _id: ObjectId.isValid(courseId) ? new ObjectId(courseId) : courseId },
      { slug: courseId },
    ],
  };
}

export async function GET(_request, { params }) {
  const user = await getAdminSession();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { courseId } = await params;
  if (!courseId) return Response.json({ error: 'Course id is required.' }, { status: 400 });

  try {
    const db = await getDb();
    const course = await db.collection('courses').findOne(courseFilterFor(courseId));
    return Response.json({ modules: normalizeModuleList(course?.modules || []) });
  } catch (error) {
    console.error('Course video listing error:', error);
    return Response.json({ error: 'Unable to load course videos.' }, { status: 500 });
  }
}

export async function POST(request, { params }) {
  const user = await getAdminSession();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { courseId } = await params;
  if (!courseId) return Response.json({ error: 'Course id is required.' }, { status: 400 });

  let storedFile = null;
  try {
    const encodedName = request.headers.get('x-file-name') || '';
    const encodedModuleTitle = request.headers.get('x-module-title') || '';
    const encodedVideoTitle = request.headers.get('x-video-title') || '';
    const mimeType = String(request.headers.get('content-type') || '').toLowerCase();
    const fileSize = Number(request.headers.get('x-file-size'));
    let fileName;
    let moduleTitle;
    let videoTitle;
    try {
      fileName = decodeURIComponent(encodedName);
      moduleTitle = decodeURIComponent(encodedModuleTitle || 'Module%201').trim().slice(0, 120) || 'Module 1';
      videoTitle = decodeURIComponent(encodedVideoTitle || encodeURIComponent(fileName.replace(/\.[^/.]+$/, ''))).trim().slice(0, 200) || 'Untitled lesson';
    } catch {
      return Response.json({ error: 'Invalid upload metadata.' }, { status: 400 });
    }

    if (!request.body || !fileName || !Number.isSafeInteger(fileSize) || fileSize <= 0) {
      return Response.json({ error: 'A video file and its size are required.' }, { status: 400 });
    }
    if (!mimeType.startsWith('video/')) {
      return Response.json({ error: 'Please upload a valid video file.' }, { status: 400 });
    }

    const db = await getDb();
    const courseFilter = courseFilterFor(courseId);
    const course = await db.collection('courses').findOne(courseFilter);
    if (!course) return Response.json({ error: 'Course not found.' }, { status: 404 });

    let courseDirectory;
    try {
      courseDirectory = courseStorageDirectory(course);
    } catch (error) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    const moduleFolder = moduleTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'module';
    storedFile = await saveUploadedStream(Readable.fromWeb(request.body), {
      name: fileName,
      type: mimeType,
      size: fileSize,
    }, ['courses', courseDirectory, 'modules', moduleFolder, 'videos'], {
      allowedMimePrefixes: ['video/'],
      allowedExtensions: VIDEO_EXTENSIONS,
      maxBytes: MAX_VIDEO_BYTES,
    });

    const existingModules = Array.isArray(course.modules) ? course.modules : [];
    const targetIndex = existingModules.findIndex(
      (module) => String(module.title).toLowerCase() === moduleTitle.toLowerCase()
    );
    const nextVideo = {
      title: videoTitle,
      duration: '00:00',
      status: 'Published',
      uploadedAt: new Date(),
      source: storedFile.url,
      storagePath: storedFile.relativePath,
      mimeType: storedFile.mimeType,
      size: storedFile.size,
      originalName: storedFile.originalName,
    };

    const nextModules = [...existingModules];
    if (targetIndex >= 0) {
      nextModules[targetIndex] = {
        ...nextModules[targetIndex],
        videos: [...(nextModules[targetIndex].videos || []), nextVideo],
      };
    } else {
      nextModules.push({ title: moduleTitle, videos: [nextVideo] });
    }

    const update = await db.collection('courses').updateOne(courseFilter, {
      $set: { modules: nextModules, updatedAt: new Date() },
    });
    if (!update.matchedCount) throw new Error('Course changed while the video was being uploaded.');

    return Response.json({
      success: true,
      message: 'Video uploaded to this server.',
      file: nextVideo,
      module: moduleTitle,
      modules: nextModules,
    });
  } catch (error) {
    if (storedFile?.relativePath) await deleteStoredFile(storedFile.relativePath).catch(() => {});
    console.error('Local video upload error:', error);
    const status = /exceeds the maximum|size exceeded|size mismatch|unsupported file|valid video|non-empty file/i.test(error.message || '') ? 400 : 500;
    return Response.json({ error: error.message || 'Unable to save video on server.' }, { status });
  }
}

export async function DELETE(request, { params }) {
  const user = await getAdminSession();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { courseId } = await params;
  if (!courseId) return Response.json({ error: 'Course id is required.' }, { status: 400 });

  try {
    const body = await request.json();
    const moduleTitle = String(body.moduleTitle || '').trim();
    const storagePath = String(body.storagePath || '').trim();
    const requestedIndex = Number(body.videoIndex);
    const requestedTitle = String(body.videoTitle || '').trim();
    if (!moduleTitle || !Number.isInteger(requestedIndex) || requestedIndex < 0) {
      return Response.json({ error: 'A valid module and video selection are required.' }, { status: 400 });
    }
    if (storagePath && !storagePath.startsWith('courses/')) {
      return Response.json({ error: 'Invalid course storage path.' }, { status: 400 });
    }

    const db = await getDb();
    const courseFilter = courseFilterFor(courseId);
    const course = await db.collection('courses').findOne(courseFilter);
    if (!course) return Response.json({ error: 'Course not found.' }, { status: 404 });

    const modules = normalizeModuleList(course.modules || []);
    const moduleIndex = modules.findIndex((module) => module.title === moduleTitle);
    if (moduleIndex < 0) return Response.json({ error: 'Module not found.' }, { status: 404 });

    const candidate = modules[moduleIndex].videos[requestedIndex];
    if (!candidate || String(candidate.title || '') !== requestedTitle || (storagePath && candidate.storagePath !== storagePath) || (!storagePath && candidate.storagePath)) {
      return Response.json({ error: 'Video selection no longer matches. Refresh the page and try again.' }, { status: 409 });
    }

    const [removedVideo] = modules[moduleIndex].videos.splice(requestedIndex, 1);
    await db.collection('courses').updateOne(courseFilter, {
      $set: { modules, updatedAt: new Date() },
    });

    if (removedVideo.storagePath) {
      try {
        await deleteStoredFile(removedVideo.storagePath);
      } catch (deleteError) {
        console.error('Video file cleanup failed:', deleteError);
        return Response.json({
          success: true,
          warning: 'Video entry was removed, but the server could not delete its local file. Check the configured data directory.',
          modules,
        });
      }
      return Response.json({ success: true, message: 'Video and its server file were deleted.', modules });
    }

    return Response.json({
      success: true,
      message: 'Legacy video entry removed from this course. Its old external copy was not modified.',
      modules,
    });
  } catch (error) {
    console.error('Video delete error:', error);
    return Response.json({ error: error.message || 'Unable to delete video.' }, { status: 500 });
  }
}
