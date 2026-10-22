import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import AllBlocks from '../../../components/react/AllBlocks.front';
import UsesIcon from '../../../components/imports/UsesIcon.front';

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <AllBlocks />
    <UsesIcon />
  </StrictMode>
);
