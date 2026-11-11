import {createRoot} from 'react-dom/client';
import {App} from './App.tsx';
import './styles.css';
import {registerServiceWorker} from './device.ts';

registerServiceWorker();

createRoot(document.getElementById('root')!).render(<App />);
