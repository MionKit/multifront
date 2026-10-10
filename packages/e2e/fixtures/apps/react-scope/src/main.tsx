import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import Stamped from '../../../components/react/scope/Stamped.ucf';
import Parent from '../Parent.ucf';

// One page per test, so each reads its own console.
const page = new URLSearchParams(location.search).get('page');

createRoot(document.getElementById('app')!).render(<StrictMode>{page === 'shapes' ? <Parent /> : <Stamped />}</StrictMode>);
