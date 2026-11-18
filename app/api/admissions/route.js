import { getDb } from '@/lib/mongodb';

export async function POST(request) {
  try {
    const db = await getDb();
    const body = await request.json();
    const data = {
      fullName: String(body?.fullName || '').trim().slice(0, 150),
      phone: String(body?.phone || '').trim().slice(0, 40),
      whatsapp: String(body?.whatsapp || '').trim().slice(0, 40),
      email: String(body?.email || '').trim().toLowerCase().slice(0, 254),
      age: String(body?.age || '').trim().slice(0, 10),
      gender: String(body?.gender || '').trim().slice(0, 40),
      education: String(body?.education || '').trim().slice(0, 150),
      address: String(body?.address || '').trim().slice(0, 1000),
      course: String(body?.course || '').trim().slice(0, 150),
      message: String(body?.message || '').trim().slice(0, 2000),
      admissionStatus: 'Pending',
      paymentStatus: 'Pending',
    };

    if (
      !data.fullName
      || !data.phone
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)
      || !data.course
    ) {
      return Response.json(
        { success: false, error: 'Enter a name, phone, valid email and course.' },
        { status: 400 }
      );
    }

    const createdAt = new Date();

    const result = await db.collection('admissions').insertOne({
      ...data,
      createdAt,
    });

    const id = String(result.insertedId);

    return Response.json(
      {
        success: true,
        id,
        _id: id,
        data: {
          id,
          _id: id,
          ...data,
          createdAt: createdAt.toISOString(),
        },
        message: 'Admission created successfully',
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('MongoDB Error:', error);
    return Response.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}