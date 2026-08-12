import firebase from 'firebase/compat/app';
import 'firebase/compat/functions';

export interface ManagedAccount {
  uid: string;
  email: string;
  disabled: boolean;
  createdAt?: string;
  lastSignInAt?: string;
}

interface BootstrapStatus {
  initialized: boolean;
}

interface ListAccountsResult {
  accounts: ManagedAccount[];
  nextPageToken?: string;
}

const callable = <Request, Response>(name: string) =>
  firebase.functions().httpsCallable(name) as unknown as (
    request?: Request
  ) => Promise<{data: Response}>;

export async function getAdminBootstrapStatus(): Promise<boolean> {
  const result = await callable<void, BootstrapStatus>('getAdminBootstrapStatus')();
  return result.data.initialized;
}

export async function bootstrapAdmin(): Promise<void> {
  await callable<void, {initialized: true}>('bootstrapAdmin')();
}

export async function listAccounts(pageToken?: string): Promise<ListAccountsResult> {
  const result = await callable<{pageToken?: string}, ListAccountsResult>('listAccounts')({pageToken});
  return result.data;
}

export async function createManagedAccount(email: string, password: string): Promise<ManagedAccount> {
  const result = await callable<{email: string; password: string}, {account: ManagedAccount}>(
    'createManagedAccount'
  )({email, password});
  return result.data.account;
}

export async function resetManagedAccountPassword(uid: string, password: string): Promise<void> {
  await callable<{uid: string; password: string}, {updated: true}>('resetManagedAccountPassword')({
    uid,
    password,
  });
}

export async function deleteManagedAccount(uid: string): Promise<void> {
  await callable<{uid: string}, {deleted: true}>('deleteManagedAccount')({uid});
}
