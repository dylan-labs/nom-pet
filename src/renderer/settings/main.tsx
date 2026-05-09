import React from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsApp } from './App';
import './styles.css';

const root = createRoot(document.getElementById('settings-root')!);
root.render(<React.StrictMode><SettingsApp /></React.StrictMode>);
