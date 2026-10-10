import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import Stamped from '../../../components/react/scope/Stamped.ucf';

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <Stamped />
  </StrictMode>
);
