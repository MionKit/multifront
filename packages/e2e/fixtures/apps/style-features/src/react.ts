import {createElement} from 'react';
import {createRoot} from 'react-dom/client';
import Parent from '../Parent.ucf' with {framework: 'react'};

createRoot(document.getElementById('app')!).render(createElement(Parent));
