import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import AllBlocks from '../../../components/react/AllBlocks.ucf';
import UsesIcon from '../../../components/imports/UsesIcon.ucf';

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <AllBlocks />
    <UsesIcon />
  </StrictMode>
);
