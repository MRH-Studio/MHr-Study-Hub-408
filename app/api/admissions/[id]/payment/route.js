import { ObjectId } from 'mongodb';
import { getDb } from '@/lib/mongodb';
import { SITE } from '@/lib/siteData';
import { deleteStoredFile, saveUploadedFile } from '@/lib/localStorage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PAYMENT_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

export async function POST(request, { params }) {
  let uploadedProof = null;
  try {
    const db = await getDb();
    const { id } = await params;
    const contentType = request.headers.get('content-type') || '';
    let paymentData = {};
    let proofFile = null;

    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      paymentData = {
        transactionId: formData.get('transactionId') || '',
        paymentNote: formData.get('paymentNote') || '',
      };
      const candidate = formData.get('paymentProof');
      if (candidate && typeof candidate !== 'string') proofFile = candidate;
    } else {
      paymentData = await request.json();
    }

    const filter = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { _id: id };
    const admission = await db.collection('admissions').findOne(filter);
    if (!admission) {
      return Response.json({ success: false, error: 'Admission not found' }, { status: 404 });
    }

    const currentSettings = await db.collection('settings').findOne({ name: 'registration_payment' });
    const currentRegistrationPrice = Number(currentSettings?.registrationPrice ?? SITE.seatLockFee ?? 20);
    if (!Number.isFinite(currentRegistrationPrice) || currentRegistrationPrice <= 0) {
      return Response.json({ success: false, error: 'Registration price is not configured correctly.' }, { status: 400 });
    }

    if (proofFile) {
      uploadedProof = await saveUploadedFile(proofFile, ['Payments', String(admission._id), 'payment-proofs'], {
        allowedMimePrefixes: ['image/'],
        allowedExtensions: PAYMENT_IMAGE_EXTENSIONS,
        maxBytes: 10 * 1024 * 1024,
      });
    }

    const oldProofPath = admission.paymentDetails?.paymentProofPath || '';
    const paymentProofImage = uploadedProof?.url
      || admission.paymentDetails?.paymentProofImage
      || paymentData.paymentProofImage
      || paymentData.imageName
      || paymentData.paymentImageName
      || '';
    const imageName = uploadedProof?.originalName
      || admission.paymentDetails?.imageName
      || paymentData.imageName
      || paymentData.paymentProofImage
      || paymentData.paymentImageName
      || '';

    const normalizedPayment = {
      transactionId: String(paymentData.transactionId || '').trim().slice(0, 150),
      paymentNote: String(paymentData.paymentNote || '').trim().slice(0, 2000),
      paymentProofImage,
      paymentProofPath: uploadedProof?.relativePath || oldProofPath,
      imageName,
    };

    if (!normalizedPayment.transactionId) {
      if (uploadedProof?.relativePath) await deleteStoredFile(uploadedProof.relativePath).catch(() => {});
      return Response.json({ success: false, error: 'UPI transaction/reference ID is required.' }, { status: 400 });
    }

    const paymentRecord = {
      admissionId: admission._id.toString(),
      fullName: admission.fullName || '',
      phone: admission.phone || '',
      email: admission.email || '',
      course: admission.course || '',
      transactionId: normalizedPayment.transactionId,
      paymentNote: normalizedPayment.paymentNote,
      paymentProofImage: normalizedPayment.paymentProofImage,
      paymentProofPath: normalizedPayment.paymentProofPath,
      imageName: normalizedPayment.imageName,
      amount: currentRegistrationPrice,
      paymentStatus: 'completed',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await db.collection('payments').updateOne(
      { admissionId: paymentRecord.admissionId },
      { $set: paymentRecord },
      { upsert: true }
    );

    await db.collection('admissions').updateOne(filter, {
      $set: {
        paymentStatus: 'completed',
        paymentDetails: normalizedPayment,
        updatedAt: new Date(),
      },
    });

    if (uploadedProof?.relativePath && oldProofPath && oldProofPath !== uploadedProof.relativePath) {
      await deleteStoredFile(oldProofPath).catch((cleanupError) => {
        console.error('Previous payment proof cleanup failed:', cleanupError);
      });
    }

    return Response.json({
      success: true,
      message: 'Payment recorded successfully',
      payment: paymentRecord,
    }, { status: 200 });
  } catch (error) {
    if (uploadedProof?.relativePath) await deleteStoredFile(uploadedProof.relativePath).catch(() => {});
    console.error('Payment Error:', error);
    const message = error?.message || 'Unable to save payment details.';
    const status = /exceeds the maximum|unsupported file/i.test(message) ? 400 : 500;
    return Response.json({ success: false, error: message }, { status });
  }
}
