import { getDb } from '@/lib/mongodb';

export function normalizeCourse(course = {}) {
  return {
    _id: course._id ? String(course._id) : course.slug || '',
    slug: course.slug || course._id || '',
    title: course.title || 'Untitled Course',
    short: course.short || course.description || 'Course description unavailable.',
    description: course.description || course.short || '',
    price: Number(course.fee ?? course.price ?? 0),
    fee: Number(course.fee ?? course.price ?? 0),
    duration: course.duration || '1 Month',
    status: course.status || 'active',
    modules: Array.isArray(course.modules) ? course.modules : [],
    thumbnail: course.thumbnail || '',
    createdAt: course.createdAt || null,
    updatedAt: course.updatedAt || null,
  };
}

export function normalizeAdmission(admission = {}, payment = {}) {
  const paymentDetails = admission.paymentDetails || payment;
  const amount = Number(payment.amount ?? admission.amount ?? admission.seatLockFee ?? 0);
  return {
    _id: admission._id ? String(admission._id) : admission.id || '',
    id: admission.id || admission._id ? String(admission._id || admission.id || '') : '',
    applicationId: admission.applicationId || admission.application_id || `AD${String(admission._id || '').slice(-4) || '0000'}`,
    fullName: admission.fullName || admission.name || 'Unknown Student',
    phone: admission.phone || '',
    email: admission.email || '',
    course: admission.course || admission.courseName || 'General',
    amount,
    paymentAmount: amount,
    paymentStatus: admission.paymentStatus || admission.payment_status || payment.paymentStatus || 'Pending',
    admissionStatus: admission.admissionStatus || admission.status || 'Pending',
    createdAt: admission.createdAt || admission.date || null,
    updatedAt: admission.updatedAt || null,
    source: admission.source || 'Website',
    paymentProofImage: (() => {
      const proof = paymentDetails.paymentProofImage || admission.paymentProofImage || '';
      return typeof proof === 'string' && proof.startsWith('/api/uploads/Payments/') ? proof : '';
    })(),
    paymentProofName: paymentDetails.imageName || admission.imageName || '',
    paymentTransactionId: paymentDetails.transactionId || admission.transactionId || '',
    paymentNote: paymentDetails.paymentNote || admission.paymentNote || '',
    paymentUpdatedAt: paymentDetails.updatedAt || paymentDetails.createdAt || null,
  };
}

export async function getAdminDashboardData() {
  const db = await getDb();
  const admissions = await db.collection('admissions').find({}).sort({ createdAt: -1 }).toArray();
  const payments = await db.collection('payments').find({}).sort({ createdAt: -1 }).toArray();
  const students = await getAdminStudents();
  const courses = await db.collection('courses').find({}).sort({ order: 1, title: 1 }).toArray();

  const totalApplications = admissions.length;
  const pendingApplications = admissions.filter((item) => {
    const status = (item.admissionStatus || item.status || '').toString().toLowerCase();
    return ['pending', 'under review'].includes(status);
  }).length;
  const confirmedAdmissions = admissions.filter((item) => {
    const status = (item.admissionStatus || item.status || '').toString().toLowerCase();
    return ['approved', 'confirmed', 'active'].includes(status);
  }).length;

  const successfulPayments = payments.filter((item) => {
    const status = (item.paymentStatus || item.status || '').toString().toLowerCase();
    return ['paid', 'success', 'completed'].includes(status);
  }).length;
  const pendingPayments = payments.filter((item) => {
    const status = (item.paymentStatus || item.status || '').toString().toLowerCase();
    return ['pending', 'in review', 'partially paid'].includes(status);
  }).length;

  const totalCourseCount = courses.length;
  const totalPayments = payments.reduce((sum, item) => sum + Number(item.amount || item.totalAmount || 0), 0);

  return {
    stats: {
      totalApplications,
      pendingApplications,
      confirmedAdmissions,
      totalStudents: students.length,
      totalCourses: totalCourseCount,
      totalPayments,
      successfulPayments,
      pendingPayments,
    },
    recentAdmissions: admissions.slice(0, 5).map(normalizeAdmission),
    recentPayments: payments.slice(0, 5).map((payment) => ({
      _id: payment._id ? String(payment._id) : '',
      name: payment.fullName || payment.name || 'Unknown',
      course: payment.course || 'Course',
      amount: Number(payment.amount || payment.totalAmount || 0),
      method: payment.method || payment.paymentMethod || 'UPI',
      status: payment.paymentStatus || payment.status || 'Pending',
      date: payment.createdAt || null,
    })),
    courses: courses.map(normalizeCourse),
  };
}

export async function getAdminAdmissions() {
  const db = await getDb();
  const [admissions, payments] = await Promise.all([
    db.collection('admissions').find({}).sort({ createdAt: -1 }).toArray(),
    db.collection('payments').find({}).toArray(),
  ]);
  const paymentsByAdmissionId = new Map(payments.map((payment) => [String(payment.admissionId), payment]));
  return admissions.map((admission) => normalizeAdmission(
    admission,
    paymentsByAdmissionId.get(String(admission._id)) || {}
  ));
}

export async function getAdminStudents() {
  const db = await getDb();
  const students = await db.collection('students')
    .find(
      { provisioning: { $ne: true }, admissionStatus: 'Approved' },
      { projection: { passwordHash: 0, passwordSalt: 0 } }
    )
    .sort({ createdAt: -1 })
    .toArray();
  return students.map((item) => ({
    _id: item._id ? String(item._id) : '',
    studentId: item.studentId || item.id || `ST${String(item._id || '').slice(-4) || '0000'}`,
    name: item.fullName || item.name || 'Unknown Student',
    phone: item.phone || '',
    email: item.email || '',
    course: item.course || item.courseName || 'General',
    enrollmentDate: item.enrollmentDate || item.createdAt || null,
    passwordUpdatedAt: item.passwordUpdatedAt || item.credentialEmailedAt || null,
    status: item.status || 'Active',
    source: item.source || 'Website',
  }));
}

export async function getAdminCourses() {
  const db = await getDb();
  const courses = await db.collection('courses').find({}).sort({ order: 1, title: 1 }).toArray();
  return courses.map(normalizeCourse);
}
