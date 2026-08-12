import * as React from 'react';

// This import loads the firebase namespace along with all its type information.
import firebase from 'firebase/compat/app';

// These imports load individual services into the firebase namespace.
import 'firebase/compat/auth';
import 'firebase/compat/database';
import 'firebase/compat/firestore';
import 'firebase/compat/storage';
import 'firebase/compat/analytics';
import 'firebase/compat/functions';
import { connectDatabaseEmulator, getDatabase } from 'firebase/database';
import { connectStorageEmulator, getStorage } from 'firebase/storage';

import { Route, Switch } from 'react-router-dom';
import './App.css';

import Onboard from './pages/Onboard';
import Homepage from './pages/Homepage';
import Committee from './pages/Committee';
import Templates from './pages/Templates';
import Countries from './pages/Countries';
import AccountAdmin from './pages/AccountAdmin';
import SelfHostedIdentity from './pages/SelfHostedIdentity';
import { NotFound } from './components/NotFound';
import Loading from './components/Loading';
import {Button, Container, Message} from 'semantic-ui-react';
import {getAdminBootstrapStatus} from './services/account-admin';
import {t} from './i18n';
import {runtimeMode} from './runtime-mode';

const firebaseConfig = {
  apiKey: 'AIzaSyA9EuEf7m3YOTBhBNhoe7DcOIZJP2toL6w',
  authDomain: 'muncoordinated.firebaseapp.com',
  databaseURL: 'https://muncoordinated.firebaseio.com',
  projectId: 'muncoordinated',
  storageBucket: 'muncoordinated.appspot.com',
  messagingSenderId: '308589918735',
  appId: "1:308589918735:web:f3567ce28d637eba40017a",
  measurementId: "G-DPWPPBRD4M"
};

const useFirebaseEmulators = import.meta.env.VITE_USE_FIREBASE_EMULATORS === 'true';
const emulatorState = window as typeof window & {
  __FIREBASE_EMULATORS_CONNECTED__?: boolean;
};

if (runtimeMode === 'firebase' && !firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

if (runtimeMode === 'firebase' && useFirebaseEmulators && !emulatorState.__FIREBASE_EMULATORS_CONNECTED__) {
  firebase.auth().useEmulator('http://127.0.0.1:9099');
  connectDatabaseEmulator(getDatabase(), '127.0.0.1', 9000);
  connectStorageEmulator(getStorage(), '127.0.0.1', 9199);
  firebase.functions().useEmulator('127.0.0.1', 5001);
  emulatorState.__FIREBASE_EMULATORS_CONNECTED__ = true;
}

if (runtimeMode === 'firebase' && !useFirebaseEmulators) {
  firebase.analytics();
}

function FirebaseApp() {
  const [initialized, setInitialized] = React.useState<boolean>();
  const [bootstrapError, setBootstrapError] = React.useState<string>();

  const checkBootstrap = React.useCallback(() => {
    setBootstrapError(undefined);
    setInitialized(undefined);
    getAdminBootstrapStatus()
      .then(setInitialized)
      .catch(error => setBootstrapError(error instanceof Error ? error.message : String(error)));
  }, []);

  React.useEffect(checkBootstrap, [checkBootstrap]);

  if (bootstrapError) {
    return <Container text style={{padding: '3em 1em'}}>
      <Message error header={t('Could not check administrator setup')} content={bootstrapError} />
      <Button onClick={checkBootstrap}>{t('Retry')}</Button>
    </Container>;
  }

  if (initialized === undefined) return <Loading />;
  if (!initialized) {
    return <AccountAdmin initialSetup onInitialized={() => window.location.assign('/admin')} />;
  }

  return (
      <Switch>
        <Route exact path="/" component={Homepage} />
        <Route exact path="/onboard" component={Onboard} />
        <Route exact path="/committees" component={Onboard} />
        <Route exact path="/templates" component={Templates} />
        <Route exact path="/countries" component={Countries} />
        <Route exact path="/admin" component={AccountAdmin} />
        <Route path="/committees/:committeeID" component={Committee} />
        <Route path="*">
          <NotFound item="page" id="unknown" />
        </Route>
      </Switch>
  );
}

function App() {
  return runtimeMode === 'self-hosted' ? <SelfHostedIdentity /> : <FirebaseApp />;
}

export default App;
