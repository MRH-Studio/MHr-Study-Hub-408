import { getAdminSession } from '@/lib/adminAuth';
import { getAdminAdmissions } from '@/lib/adminData';
import { ObjectId } from 'mongodb';
import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import nodemailer from 'nodemailer';

const scrypt = promisify(scryptCallback);

async function getMailTransport(db) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASSWORD) {
    throw new Error('Email is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASSWORD.');
  }

  const settings = await db.collection('settings').findOne({ name: 'registration_payment' });
  const from = String(settings?.studentEmailFrom || process.env.SMTP_FROM || 'mrh408520@gmail.com').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) {
    throw new Error('The student sender email address is not valid. Update it in admin settings.');
  }

  const port = Number(SMTP_PORT);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('SMTP_PORT must be a valid port number.');
  }

  return {
    from,
    transport: nodemailer.createTransport({
      host: SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
    }),
  };
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

async function sendStudentCredentialsEmail(db, { to, name, studentId, password, course }) {
  const { from, transport } = await getMailTransport(db);
  const safeName = escapeHtml(name);
  const safeCourse = escapeHtml(course);
  const mailResult = await transport.sendMail({
    from: { name: 'MRH_study', address: from },
    to,
    subject: 'Your MRH Study Hub student account',
    text: `Hello ${name},\n\nYour admission has been approved.\nStudent ID: ${studentId}\nPermanent password: ${password}\nCourse: ${course}\n\nPlease keep these credentials private.`,
    html: `<p>Hello ${safeName},</p><p>Your admission has been approved.</p><p><strong>Student ID:</strong> ${studentId}<br><strong>Permanent password:</strong> ${password}<br><strong>Course:</strong> ${safeCourse}</p><p>Please keep these credentials private.</p>`,
  });
  const emailAccepted = Array.isArray(mailResult.accepted)
    && mailResult.accepted.some((recipient) => String(recipient).toLowerCase() === to.toLowerCase());
  if (!emailAccepted) {
    throw new Error(`SMTP did not accept the credentials email for ${to}.`);
  }
}

async function provisionStudent(db, admission) {
  const students = db.collection('students');
  const admissionId = String(admission._id);
  let student = await students.findOne({ admissionId });

  if (student && !student.provisioning && admission.admissionStatus === 'Approved') {
    return { emailSent: false };
  }

  const email = String(admission.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('The application does not have a valid email address.');
  }

  const emailOwner = await students.findOne({
    email,
    admissionId: { $ne: admissionId },
    provisioning: { $ne: true },
  });
  if (emailOwner) {
    throw new Error('A student account already exists for this email address.');
  }

  const password = randomBytes(18).toString('base64url');
  const salt = randomBytes(16).toString('hex');
  const passwordHash = (await scrypt(password, salt, 64)).toString('hex');
  const now = new Date();
  const studentId = student?.studentId || `ST${randomBytes(8).toString('hex').toUpperCase()}`;
  const record = {
    admissionId,
    studentId,
    fullName: admission.fullName || admission.name || '',
    name: admission.fullName || admission.name || '',
    phone: admission.phone || '',
    email,
    course: admission.course || admission.courseName || '',
    status: 'Active',
    admissionStatus: 'Approved',
    paymentStatus: admission.paymentStatus || 'Pending',
    passwordHash,
    passwordSalt: salt,
    provisioning: true,
    enrollmentDate: admission.enrollmentDate || now,
    createdAt: student?.createdAt || now,
    updatedAt: now,
    source: admission.source || 'Website',
  };

  await students.updateOne(
    { admissionId },
    { $set: record },
    { upsert: true }
  );

  await sendStudentCredentialsEmail(db, {
    to: email,
    name: record.fullName,
    studentId,
    password,
    course: record.course,
  });

  await db.collection('admissions').updateOne(
    { _id: admission._id },
    {
      $set: {
        admissionStatus: 'Approved',
        studentId,
        enrollmentDate: record.enrollmentDate,
        updatedAt: new Date(),
      },
    }
  );
  const credentialsUpdatedAt = new Date();
  await students.updateOne(
    { admissionId },
    {
      $set: {
        provisioning: false,
        credentialEmailedAt: credentialsUpdatedAt,
        passwordUpdatedAt: credentialsUpdatedAt,
        updatedAt: credentialsUpdatedAt,
      },
    }
  );

  return { emailSent: true };
}

export async function GET() {
  const user = await getAdminSession();
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admissions = await getAdminAdmissions();
  return Response.json(admissions);
}

export async function PATCH(request) {
  const user = await getAdminSession();
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const { id, _id, admissionStatus, paymentStatus, notes } = body || {};
  const recordId = id || _id;

  if (!recordId) {
    return Response.json({ error: 'Application ID is required.' }, { status: 400 });
  }

  const { getDb } = await import('@/lib/mongodb');
  const db = await getDb();
  const filter = ObjectId.isValid(recordId) ? { _id: new ObjectId(recordId) } : { _id: recordId };

  const current = await db.collection('admissions').findOne(filter);
  if (!current) {
    return Response.json({ error: 'Application not found.' }, { status: 404 });
  }

  let emailSent = false;
  if (admissionStatus === 'Approved') {
    try {
      const result = await provisionStudent(db, current);
      emailSent = result.emailSent;
    } catch (error) {
      console.error('Student provisioning failed:', error);
      return Response.json(
        { error: error.message || 'Unable to approve application and email student credentials.' },
        { status: 502 }
      );
    }
  }

  const update = { $set: { updatedAt: new Date() } };
  if (admissionStatus && admissionStatus !== 'Approved') update.$set.admissionStatus = admissionStatus;
  if (paymentStatus) update.$set.paymentStatus = paymentStatus;
  if (notes) update.$set.notes = notes;

  await db.collection('admissions').updateOne(filter, update);
  if (admissionStatus === 'Rejected') {
    await db.collection('students').updateOne(
      { admissionId: String(current._id) },
      { $set: { admissionStatus: 'Rejected', status: 'Inactive', updatedAt: new Date() } }
    );
  }
  const refreshed = await db.collection('admissions').findOne(filter);
  return Response.json({
    success: true,
    application: refreshed,
    emailSent,
    emailTo: emailSent ? refreshed?.email || '' : '',
  });
}
