import {createRoot, hydrateRoot} from 'react-dom/client';
import App from './App.tsx';

const container = document.getElementById('app')!;
// The test serves the page with the server-rendered App in it to check hydration.
if (container.firstElementChild) hydrateRoot(container, <App />);
else createRoot(container).render(<App />);
