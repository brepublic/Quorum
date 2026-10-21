import './App.css';
import {useLanguage} from './i18n';
import SelfHostedIdentity from './pages/SelfHostedIdentity';
import {FileDownloadStatus} from './components/FileDownloadStatus';

function App() {
  useLanguage();
  return <><FileDownloadStatus /><SelfHostedIdentity /></>;
}

export default App;
