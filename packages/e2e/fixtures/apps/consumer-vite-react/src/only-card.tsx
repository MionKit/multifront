import {createRoot} from 'react-dom/client';
import {Card} from '@mf-fixture/ui-react';

createRoot(document.getElementById('app')!).render(<Card title="Only card" />);
