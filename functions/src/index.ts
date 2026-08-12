import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions/v1';

admin.initializeApp();

const ADMIN_UID_PATH = 'system/adminUid';
const BOOTSTRAP_COMPLETE_PATH = 'system/bootstrapComplete';

interface CallableContext {
  auth?: {
    uid: string;
    token: Record<string, unknown>;
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new functions.https.HttpsError('invalid-argument', `${field} is required.`);
  }
  return value.trim();
}

function requirePassword(value: unknown): string {
  const password = requireString(value, 'password');
  if (password.length < 6) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'The password must contain at least 6 characters.'
    );
  }
  return password;
}

function throwAuthError(error: unknown): never {
  const code = (error as {code?: string}).code;
  if (code === 'auth/email-already-exists') {
    throw new functions.https.HttpsError('already-exists', 'An account already uses this email address.');
  }
  if (code === 'auth/user-not-found') {
    throw new functions.https.HttpsError('not-found', 'The account no longer exists.');
  }
  if (code?.startsWith('auth/invalid-')) {
    throw new functions.https.HttpsError('invalid-argument', 'The account information is invalid.');
  }
  functions.logger.error('Firebase Authentication management error', error);
  throw new functions.https.HttpsError('internal', 'The account operation failed.');
}

async function requireAdmin(context: CallableContext): Promise<string> {
  if (!context.auth || context.auth.token.admin !== true) {
    throw new functions.https.HttpsError('permission-denied', 'Administrator access is required.');
  }

  const snapshot = await admin.database().ref(ADMIN_UID_PATH).get();
  if (snapshot.val() !== context.auth.uid) {
    throw new functions.https.HttpsError('permission-denied', 'Administrator access is required.');
  }
  return context.auth.uid;
}

function account(user: admin.auth.UserRecord) {
  return {
    uid: user.uid,
    email: user.email || '',
    disabled: user.disabled,
    createdAt: user.metadata.creationTime || undefined,
    lastSignInAt: user.metadata.lastSignInTime || undefined,
  };
}

export const getAdminBootstrapStatus = functions.https.onCall(async () => {
  const snapshot = await admin.database().ref(BOOTSTRAP_COMPLETE_PATH).get();
  return {initialized: snapshot.val() === true};
});

export const bootstrapAdmin = functions.https.onCall(async (_data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Sign in before initialization.');
  }

  const uid = context.auth.uid;
  const adminUid = admin.database().ref(ADMIN_UID_PATH);
  const transaction = await adminUid.transaction(current => current || uid, undefined, false);
  if (!transaction.committed || transaction.snapshot.val() !== uid) {
    throw new functions.https.HttpsError('failed-precondition', 'An administrator already exists.');
  }

  const user = await admin.auth().getUser(uid);
  try {
    await admin.auth().setCustomUserClaims(uid, {...user.customClaims, admin: true, managed: true});
    await admin.database().ref(BOOTSTRAP_COMPLETE_PATH).set(true);
  } catch (error) {
    await adminUid.transaction(current => current === uid ? null : current, undefined, false);
    await admin.auth().setCustomUserClaims(uid, user.customClaims || null).catch(() => undefined);
    throw error;
  }
  functions.logger.info('Administrator initialized', {uid});
  return {initialized: true as const};
});

export const listAccounts = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);
  const pageToken = typeof data?.pageToken === 'string' ? data.pageToken : undefined;
  const result = await admin.auth().listUsers(1000, pageToken);
  return {
    accounts: result.users.map(account),
    nextPageToken: result.pageToken,
  };
});

export const createManagedAccount = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);
  const email = requireString(data?.email, 'email').toLowerCase();
  const password = requirePassword(data?.password);
  let user: admin.auth.UserRecord;
  let createdUid: string | undefined;
  try {
    user = await admin.auth().createUser({email, password});
    createdUid = user.uid;
    await admin.auth().setCustomUserClaims(user.uid, {managed: true});
  } catch (error) {
    if (createdUid) {
      await admin.auth().deleteUser(createdUid).catch(() => undefined);
    }
    throwAuthError(error);
  }
  functions.logger.info('Account created by administrator', {administratorUid: context.auth!.uid, uid: user.uid});
  return {account: account(user)};
});

export const resetManagedAccountPassword = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);
  const uid = requireString(data?.uid, 'uid');
  const password = requirePassword(data?.password);
  try {
    await admin.auth().updateUser(uid, {password});
  } catch (error) {
    throwAuthError(error);
  }
  functions.logger.info('Password reset by administrator', {administratorUid: context.auth!.uid, uid});
  return {updated: true as const};
});

export const deleteManagedAccount = functions.https.onCall(async (data, context) => {
  const administratorUid = await requireAdmin(context);
  const uid = requireString(data?.uid, 'uid');
  if (uid === administratorUid) {
    throw new functions.https.HttpsError('failed-precondition', 'The administrator account cannot be deleted.');
  }
  try {
    await admin.auth().deleteUser(uid);
  } catch (error) {
    throwAuthError(error);
  }
  functions.logger.info('Account deleted by administrator', {administratorUid, uid});
  return {deleted: true as const};
});
