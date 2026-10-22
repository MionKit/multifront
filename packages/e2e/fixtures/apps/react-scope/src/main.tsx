import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import ScopedPanel from '../../../components/react/ScopedPanel.front';
import Stamped from '../../../components/react/scope/Stamped.front';
import Parent from '../Parent.front';

// One page per test, so each reads its own console.
const page = new URLSearchParams(location.search).get('page');

const element = page === 'shapes' ? <Parent /> : page === 'panel' ? <ScopedPanel /> : <Stamped />;

createRoot(document.getElementById('app')!).render(<StrictMode>{element}</StrictMode>);
