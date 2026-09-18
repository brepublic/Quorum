import './App.css';
import {useLanguage} from './i18n';
import SelfHostedIdentity from './pages/SelfHostedIdentity';

function App() {
  useLanguage();
  return <SelfHostedIdentity />;
}

export default App;
