import { getCoursesFromDb } from '@/lib/coursesData';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    const courses = await getCoursesFromDb();

    // This endpoint contains live database data; do not let Next.js or
    // intermediate HTTP caches retain an empty/old response.
    return Response.json(courses, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
      },
    });
  } catch (error) {
    console.error('[Courses API] Failed to load courses:', error);
    return Response.json(
      { error: 'Unable to load courses' },
      {
        status: 500,
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  }
}
