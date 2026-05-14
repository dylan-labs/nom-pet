import React from 'react';
import { createRoot } from 'react-dom/client';
import { CardApp } from './CardApp';
import './styles.css';

const root = createRoot(document.getElementById('card-root')!);
root.render(<React.StrictMode><CardApp /></React.StrictMode>);
