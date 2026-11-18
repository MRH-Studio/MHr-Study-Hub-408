import { getAdminSession } from '@/lib/adminAuth';
import { getDb } from '@/lib/mongodb';
import { SITE } from '@/lib/siteData';
import { deleteStoredFile, saveUploadedFile, storagePathFromUploadUrl } from '@/lib/localStorage';

const DEFAULT_STUDENT_EMAIL_FROM = 'mrh408520@gmail.com';

function normalizePaymentQrUrl(paymentQrUrl) {
  if (typeof paymentQrUrl !== 'string') return '';
  const trimmed = paymentQrUrl.trim();
  return trimmed.startsWith('/api/uploads/Payments/payment-qr/') ? trimmed : '';
}

async function ensureDefaultSettings(db) {
  const collection = db.collection('settings');
  const fallbackPrice = Number(SITE.seatLockFee ?? 20);

  let settings = await collection.findOne({ name: 'registration_payment' });

  if (!settings) {
    settings = {
      name: 'registration_payment',
      registrationPrice: fallbackPrice,
      paymentQrUrl: '',
      paymentQrPath: '',
      studentEmailFrom: process.env.SMTP_FROM || DEFAULT_STUDENT_EMAIL_FROM,
      status: 'active',
      updatedAt: new Date(),
      lastUpdatedAt: new Date(),
      registrationPriceUpdatedAt: new Date(),
      paymentQrUpdatedAt: null,
    };

    await collection.insertOne(settings);
  }

  const normalizedPrice = Number(settings.registrationPrice ?? fallbackPrice);
  const normalizedQrUrl = normalizePaymentQrUrl(settings.paymentQrUrl);
  const normalizedQrPath = storagePathFromUploadUrl(normalizedQrUrl);
  const studentEmailFrom = String(
    settings.studentEmailFrom || process.env.SMTP_FROM || DEFAULT_STUDENT_EMAIL_FROM
  ).trim();

  if (settings.paymentQrUrl !== normalizedQrUrl || settings.paymentQrPath !== normalizedQrPath || Number(settings.registrationPrice ?? fallbackPrice) !== normalizedPrice || settings.studentEmailFrom !== studentEmailFrom) {
    await collection.updateOne(
      { name: 'registration_payment' },
      {
        $set: {
          registrationPrice: normalizedPrice,
          paymentQrUrl: normalizedQrUrl,
          paymentQrPath: normalizedQrPath,
          studentEmailFrom,
          updatedAt: new Date(),
          lastUpdatedAt: new Date(),
          registrationPriceUpdatedAt: settings.registrationPriceUpdatedAt || new Date(),
          paymentQrUpdatedAt: settings.paymentQrUpdatedAt || null,
          status: settings.status || 'active',
        },
      },
      { upsert: true }
    );
    settings = await collection.findOne({ name: 'registration_payment' });
  }

  return settings;
}

export async function GET() {
  const user = await getAdminSession();
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const db = await getDb();
    const settings = await ensureDefaultSettings(db);

    const registrationPrice = Number(settings.registrationPrice ?? SITE.seatLockFee ?? 20);
    const paymentQrUrl = normalizePaymentQrUrl(settings.paymentQrUrl);

    return Response.json(
      {
        success: true,
        settings: { ...settings, registrationPrice, paymentQrUrl },
        registrationPrice,
        paymentQrUrl,
        status: settings.status || 'active',
        updatedAt: settings.updatedAt || settings.lastUpdatedAt || new Date().toISOString(),
        lastUpdatedAt: settings.lastUpdatedAt || settings.updatedAt || new Date().toISOString(),
        updatedBy: settings.updatedBy || 'system',
      },
      {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
          Pragma: 'no-cache',
          Expires: '0',
        },
      }
    );
  } catch (error) {
    console.error('Admin settings fetch error:', error);
    return Response.json({ error: 'Unable to load settings.' }, { status: 500 });
  }
}

export async function POST(request) {
  const user = await getAdminSession();
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const db = await getDb();
    const collection = db.collection('settings');
    const contentType = request.headers.get('content-type') || '';

    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const file = formData.get('file');
      const action = String(formData.get('action') || 'qr');

      if (!file || typeof file === 'string') {
        return Response.json({ error: 'A QR image file is required.' }, { status: 400 });
      }

      let uploadedFile;
      try {
        uploadedFile = await saveUploadedFile(file, ['Payments', 'payment-qr'], {
          allowedMimePrefixes: ['image/'],
          allowedExtensions: ['.jpg', '.jpeg', '.png', '.webp', '.gif'],
          maxBytes: 10 * 1024 * 1024,
        });

        const now = new Date();
        const doc = await ensureDefaultSettings(db);
        const previousPath = storagePathFromUploadUrl(doc.paymentQrUrl);
        const paymentQrUrl = uploadedFile.url;
        await collection.updateOne(
          { name: 'registration_payment' },
          {
            $set: {
              ...doc,
              name: 'registration_payment',
              paymentQrUrl,
              paymentQrPath: uploadedFile.relativePath,
              paymentQrUpdatedAt: now,
              updatedAt: now,
              lastUpdatedAt: now,
              updatedBy: user.username || 'admin',
              status: 'active',
            },
          },
          { upsert: true }
        );

        if (previousPath && previousPath !== uploadedFile.relativePath) {
          await deleteStoredFile(previousPath).catch((cleanupError) => {
            console.error('Previous payment QR cleanup failed:', cleanupError);
          });
        }

        return Response.json({
          success: true,
          message: 'Payment QR code saved on this server.',
          paymentQrUrl,
          lastUpdated: now.toISOString(),
          action,
        });
      } catch (error) {
        if (uploadedFile?.relativePath) await deleteStoredFile(uploadedFile.relativePath).catch(() => {});
        const message = error?.message || 'Local server upload failed.';
        const status = /exceeds the maximum|unsupported file/i.test(message) ? 400 : 500;
        return Response.json(
          {
            error: message,
            keepExistingQrUrl: true,
            messageDetail: 'The current QR image was kept unchanged because the upload did not succeed.',
          },
          { status }
        );
      }
    }

    const payload = await request.json();
    const action = String(payload.action || 'price');

    if (action === 'student-email-from') {
      const studentEmailFrom = String(payload.studentEmailFrom || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(studentEmailFrom)) {
        return Response.json({ error: 'Enter a valid sender email address.' }, { status: 400 });
      }

      const doc = await ensureDefaultSettings(db);
      const now = new Date();
      await collection.updateOne(
        { name: 'registration_payment' },
        {
          $set: {
            ...doc,
            studentEmailFrom,
            updatedAt: now,
            lastUpdatedAt: now,
            updatedBy: user.username || 'admin',
          },
        },
        { upsert: true }
      );

      return Response.json({
        success: true,
        message: 'Student sender email updated successfully.',
        studentEmailFrom,
        lastUpdated: now.toISOString(),
      });
    }

    const registrationPrice = Number(payload.registrationPrice);

    if (action === 'qr') {
      const doc = await ensureDefaultSettings(db);
      const now = new Date();
      const nextQrUrl = normalizePaymentQrUrl(payload.paymentQrUrl || doc.paymentQrUrl || '');

      if (!nextQrUrl) {
        return Response.json({ error: 'A valid payment QR URL is required.' }, { status: 400 });
      }

      await collection.updateOne(
        { name: 'registration_payment' },
        {
          $set: {
            ...doc,
            name: 'registration_payment',
            paymentQrUrl: nextQrUrl,
            paymentQrPath: storagePathFromUploadUrl(nextQrUrl),
            paymentQrUpdatedAt: now,
            updatedAt: now,
            lastUpdatedAt: now,
            updatedBy: user.username || 'admin',
            status: 'active',
          },
        },
        { upsert: true }
      );

      return Response.json({
        success: true,
        message: 'Payment QR code updated successfully.',
        paymentQrUrl: nextQrUrl,
        lastUpdated: now.toISOString(),
      });
    }

    if (!Number.isFinite(registrationPrice) || registrationPrice <= 0) {
      return Response.json({ error: 'A valid registration price is required.' }, { status: 400 });
    }

    const doc = await ensureDefaultSettings(db);
    const now = new Date();
    const currentQrUrl = normalizePaymentQrUrl(doc.paymentQrUrl || '');

    await collection.updateOne(
      { name: 'registration_payment' },
      {
        $set: {
          ...doc,
          name: 'registration_payment',
          registrationPrice,
          paymentQrUrl: currentQrUrl,
          paymentQrPath: storagePathFromUploadUrl(currentQrUrl),
          registrationPriceUpdatedAt: now,
          paymentQrUpdatedAt: doc.paymentQrUpdatedAt || null,
          updatedAt: now,
          lastUpdatedAt: now,
          updatedBy: user.username || 'admin',
          status: 'active',
        },
      },
      { upsert: true }
    );

    return Response.json({
      success: true,
      message: 'Registration price updated successfully.',
      registrationPrice,
      paymentQrUrl: currentQrUrl,
      lastUpdated: now.toISOString(),
    });
  } catch (error) {
    console.error('Admin settings update error:', error);
    return Response.json({ error: error.message || 'Unable to update settings.' }, { status: 500 });
  }
}
